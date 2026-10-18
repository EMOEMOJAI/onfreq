import { DurableObject } from 'cloudflare:workers';
import {
  CRON_PERIOD_MS, EARLY_POLL_DELAY_MS, EARLY_POLL_KEY, EARLY_POLL_MIN_GAIN_MS, EARLY_POLLS_PER_HOUR,
  MIN_POLL_INTERVAL_MS, MIN_POLL_SPACING_MS, POLL_SNAPSHOT_KEY, SCHEDULER_SEEN_KEY, SCHEDULER_SEEN_MIN_WRITE_MS,
  STATE_KEY,
} from './config';
import { runPoll } from './poll';
import type { PendingOffline, RosterMessage, RosterPostAttempt, StateMap } from './types';
import { cleanupGcaCopies } from './retention';

export const HEALTH_MAX_AGE_MS = 5 * 60_000;

export interface PollSnapshot {
  state: StateMap | null;
  rosterMessages?: RosterMessage[];
  /** Budget for continuation pages that have never once posted successfully. */
  rosterPostAttempts?: RosterPostAttempt[];
  pendingOffline?: PendingOffline[];
  /** Last role ping per channel (epoch ms), kept while its mention cooldown runs. */
  rolePings?: Record<string, number>;
  /** Start of the last poll of either kind. */
  lastPollStartedAt?: number;
  /** Start of the last scheduled (cron or POST /poll) poll; absent in snapshots older than early polls. */
  lastScheduledPollStartedAt?: number;
  lastSuccessfulPollAt?: number;
  error?: string;
}

export interface PollResult {
  skipped: boolean;
}

export interface PollOptions {
  /** Cron or POST /poll: records the scheduler heartbeat that health requires. */
  recordHeartbeat?: boolean;
}

/** Scheduled polls (cron, POST /poll) or early polls (webhook alarm), throttled differently. */
type PollKind = 'scheduled' | 'early';

/** Early polls that actually ran in the clock hour starting at `hourStart`. */
interface EarlyPollBudget {
  hourStart: number;
  count: number;
}

const HOUR_MS = 60 * 60_000;

/** The clock hour whose spent budget was last logged: webhook traffic must not multiply this line. */
let loggedEarlyPollCappedHour: number | undefined;
/** Logged once per isolate, like other storage-failure lines. */
let loggedHeartbeatFailed = false;

/** Test-only: forget which early-poll cap and heartbeat failure were logged. */
export function resetEarlyPollLogForTests(): void {
  loggedEarlyPollCappedHour = undefined;
  loggedHeartbeatFailed = false;
}

/** True when `at` is a trusted time less than `windowMs` before `now`; a future time is not trusted. */
function within(at: unknown, now: number, windowMs: number): boolean {
  return typeof at === 'number' && now - at >= 0 && now - at < windowMs;
}

/** One object owns this bot's session state and serializes both trigger sources. */
export class PollCoordinator extends DurableObject<Env> {
  private inFlight?: Promise<PollResult>;

  /**
   * A regular poll. It always uses the scheduled-poll throttle, whether or not
   * it records the heartbeat; only the webhook alarm runs an early poll.
   */
  async poll({ recordHeartbeat = false }: PollOptions = {}): Promise<PollResult> {
    if (recordHeartbeat) await this.recordSchedulerSeen();
    return this.serialized('scheduled');
  }

  /**
   * Separate key: health can tell a live scheduler from webhook-driven polls.
   * The heartbeat is advisory, so a storage failure never stops the poll.
   */
  private async recordSchedulerSeen(): Promise<void> {
    try {
      const now = Date.now();
      if (within(await this.ctx.storage.get<unknown>(SCHEDULER_SEEN_KEY), now, SCHEDULER_SEEN_MIN_WRITE_MS)) return;
      await this.ctx.storage.put(SCHEDULER_SEEN_KEY, now);
    } catch (err) {
      if (loggedHeartbeatFailed) return;
      loggedHeartbeatFailed = true;
      console.error(JSON.stringify({
        event: 'scheduler_heartbeat_failed', error: err instanceof Error ? err.name : typeof err,
      }));
    }
  }

  /**
   * A verified webhook hint: schedule one earlier poll through the alarm, at
   * least EARLY_POLL_DELAY_MS from now and MIN_POLL_SPACING_MS after the last
   * poll. No-op while a poll runs, when a live cron's next poll that will
   * actually run is about as soon, or once this hour's early-poll budget is
   * spent. Without a recent heartbeat (a stopped cron) the early poll always
   * helps. Resolves true when an alarm is pending (just set or already set),
   * false for every no-op.
   */
  async requestEarlyPoll(): Promise<boolean> {
    if ((await this.ctx.storage.getAlarm()) !== null) return true;
    if (this.inFlight) return false;
    const snapshot = await this.ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY);
    const seen = await this.ctx.storage.get<unknown>(SCHEDULER_SEEN_KEY);
    const now = Date.now();
    // Future start times are not trusted, as in runOnce's throttle.
    const trusted = (at: number | undefined) => (at !== undefined && at <= now ? at : undefined);
    const last = trusted(snapshot?.lastPollStartedAt);
    const target = Math.max(now + EARLY_POLL_DELAY_MS, (last ?? 0) + MIN_POLL_SPACING_MS);
    if (typeof seen === 'number' && within(seen, now, CRON_PERIOD_MS)) {
      // The next cron poll that will actually run: a tick within the spacing of
      // the last poll, or within the interval of the last scheduled one, is
      // skipped. One tick later always clears both, so the loop is bounded.
      const lastScheduled = trusted(snapshot?.lastScheduledPollStartedAt ?? snapshot?.lastPollStartedAt);
      let next = seen + CRON_PERIOD_MS;
      for (let i = 0; i < 2 && ((last !== undefined && next - last < MIN_POLL_SPACING_MS) ||
          (lastScheduled !== undefined && next - lastScheduled < MIN_POLL_INTERVAL_MS)); i++) {
        next += CRON_PERIOD_MS;
      }
      if (target >= next - EARLY_POLL_MIN_GAIN_MS) return false;
    }
    const budget = await this.ctx.storage.get<EarlyPollBudget>(EARLY_POLL_KEY);
    const hour = hourStart(now);
    if (budget?.hourStart === hour && budget.count >= EARLY_POLLS_PER_HOUR) {
      if (loggedEarlyPollCappedHour !== hour) {
        loggedEarlyPollCappedHour = hour;
        console.error(JSON.stringify({ event: 'early_poll_capped' }));
      }
      return false;
    }
    // No re-check of inFlight: input gates deliver no other event while this awaits storage only.
    await this.ctx.storage.setAlarm(target);
    return true;
  }

  /**
   * Runs the early poll through the same serialized path, with only the
   * throttle shortened. Errors are swallowed so the platform does not retry:
   * the next cron poll reports them as usual. Only a poll that ran is logged,
   * not a skip that rethrows an earlier poll's stored error.
   */
  async alarm(): Promise<void> {
    const attempt = { ran: false };
    try {
      await this.serialized('early', attempt);
    } catch (err) {
      if (attempt.ran) {
        console.error(JSON.stringify({ event: 'early_poll_failed', error: err instanceof Error ? err.name : typeof err }));
      }
    }
    if (!attempt.ran) return;
    try {
      const now = Date.now();
      const budget = await this.ctx.storage.get<EarlyPollBudget>(EARLY_POLL_KEY);
      const count = budget?.hourStart === hourStart(now) ? budget.count + 1 : 1;
      await this.ctx.storage.put(EARLY_POLL_KEY, { hourStart: hourStart(now), count } satisfies EarlyPollBudget);
    } catch (err) {
      console.error(JSON.stringify({ event: 'early_poll_failed', error: err instanceof Error ? err.name : typeof err }));
    }
  }

  private async serialized(kind: PollKind, attempt?: { ran: boolean }): Promise<PollResult> {
    // Set synchronously before yielding: external fetches permit other RPCs
    // to enter this object, so storage consistency alone is not a mutex.
    if (this.inFlight) {
      await this.inFlight;
      return { skipped: true };
    }
    this.inFlight = this.runOnce(kind, attempt);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  async getState(): Promise<StateMap | null> {
    const snapshot = await this.ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY);
    // Read-only fallback until the first poll imports legacy state.
    return snapshot ? snapshot.state : this.env.ATC_STATE.get<StateMap>(STATE_KEY, 'json');
  }

  async getHealth() {
    const snapshot = await this.ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY);
    const schedulerSeenAt = await this.ctx.storage.get<unknown>(SCHEDULER_SEEN_KEY);
    const now = Date.now();
    const lastSuccessfulPollAt = snapshot?.lastSuccessfulPollAt ?? null;
    // A negative age (clock skew or a corrupted future timestamp) is treated
    // as unhealthy rather than trusted, same as a stale one.
    const fresh = (at: unknown) => typeof at === 'number' && now - at >= 0 && now - at < HEALTH_MAX_AGE_MS;
    // Early polls alone must not hide a stopped scheduler. A deployment that
    // has not yet recorded a heartbeat keeps the success-age rule alone.
    const ok = fresh(lastSuccessfulPollAt) && (schedulerSeenAt === undefined || fresh(schedulerSeenAt));
    return { ok, lastSuccessfulPollAt, maxAgeSeconds: HEALTH_MAX_AGE_MS / 1000 };
  }

  cleanupGcaHistory(apply: boolean) {
    // Never race a reminder POST/reservation or a staff-copy retry. The cleanup
    // itself is synchronous, so no poll can interleave with its transaction.
    if (this.inFlight) return { busy: true as const };
    return { busy: false as const, ...cleanupGcaCopies(this.ctx.storage, apply, Date.now(), this.env.GCA_COPY_USER_ID) };
  }

  async getGcaHistory(after = 0) {
    const sql = this.ctx.storage.sql;
    // Existence check runs on every call rather than being cached per
    // instance: it is cheap, and it keeps this method correct even the very
    // first time the tables are created mid-lifetime of a warm instance.
    const tables = new Set(sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('gca_reminders', 'gca_occurrences')",
    ).toArray().map((row) => row.name));
    if (!tables.has('gca_reminders')) return { records: [], nextCursor: null };
    const hasOccurrences = tables.has('gca_occurrences');
    // `after` is an opaque cursor: the rowid of the last returned row. It never
    // carries member ids, because request URLs reach Workers invocation logs.
    // Upserts keep a row's rowid, so pages follow first-detection order.
    const rows = sql.exec<{
      cursor: number; sessionKey: string; status: string; attempts: number; lastSeenAt: number; occurrence: number | null;
    }>(`SELECT r.rowid AS cursor, r.session_key AS sessionKey, r.status, r.attempts, r.last_seen AS lastSeenAt,
      ${hasOccurrences ? 'o.occurrence' : 'NULL'} AS occurrence
      FROM gca_reminders r
      ${hasOccurrences ? 'LEFT JOIN gca_occurrences o ON o.session_key = r.session_key' : ''}
      WHERE r.rowid > ? AND (r.attempts > 0 OR r.status IN ('sent', 'reserved', 'failed'))
      ORDER BY r.rowid LIMIT 101`, after).toArray();
    const records = rows.slice(0, 100).map(({ cursor: _cursor, ...record }) => record);
    return { records, nextCursor: rows.length > 100 ? String(rows[99]!.cursor) : null };
  }

  private async runOnce(kind: PollKind, attempt?: { ran: boolean }): Promise<PollResult> {
    let snapshot = await this.ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY);
    if (!snapshot) {
      snapshot = { state: await this.env.ATC_STATE.get<StateMap>(STATE_KEY, 'json') };
      // Import before making external side effects. Even an empty legacy map
      // is authoritative, and future polls never re-import stale KV state.
      await this.ctx.storage.put(POLL_SNAPSHOT_KEY, snapshot);
    }

    const startedAt = Date.now();
    // A future start time (clock skew or corrupted storage) is not trusted as a
    // throttle: otherwise it would block every poll until that time arrives.
    // Every poll keeps MIN_POLL_SPACING_MS from the last one; scheduled polls
    // also keep MIN_POLL_INTERVAL_MS from the last scheduled one, so early
    // polls do not push the cron back. Older snapshots fall back to any poll.
    const lastScheduled = snapshot.lastScheduledPollStartedAt ?? snapshot.lastPollStartedAt;
    if (within(snapshot.lastPollStartedAt, startedAt, MIN_POLL_SPACING_MS) ||
        (kind === 'scheduled' && within(lastScheduled, startedAt, MIN_POLL_INTERVAL_MS))) {
      if (snapshot.error) throw new Error(snapshot.error);
      return { skipped: true };
    }
    if (attempt) attempt.ran = true;
    // A scheduled poll that runs, even one that fails, restarts the scheduled
    // interval; an early poll carries it forward. An early poll on a snapshot
    // with no poll of either kind records 0, "no scheduled poll yet", so the
    // first cron is not throttled against it. An older lastPollStartedAt alone
    // is still a scheduled start: every poll before early polls was one.
    const scheduledAt = kind === 'scheduled' ? startedAt : lastScheduled ?? 0;

    let outcome: Awaited<ReturnType<typeof runPoll>>;
    try {
      outcome = await runPoll(this.env, snapshot.state, new Date(startedAt).toISOString(), {
        storage: this.ctx.storage,
        previousRosterMessages: snapshot.rosterMessages,
        previousRosterPostAttempts: snapshot.rosterPostAttempts,
        previousPendingOffline: snapshot.pendingOffline,
        previousRolePings: snapshot.rolePings,
      });
    } catch (err) {
      // runPoll threw (a config/precondition failure or any other error), so
      // this poll's results are discarded: carry the previous snapshot forward
      // and record only the cadence and error. Otherwise a misconfigured bot
      // bypasses MIN_POLL_INTERVAL on every invocation.
      // A failure while recording that must never mask the original runPoll
      // error — log it (without bodies) and rethrow `err` regardless.
      try {
        // An empty message still records a failure, so the throttle keeps reporting it.
        await this.persist(snapshot, startedAt, scheduledAt, snapshot.lastSuccessfulPollAt,
          (err instanceof Error ? err.message || err.name : String(err)) || 'poll failed');
      } catch (putErr) {
        console.error(JSON.stringify({
          event: 'poll_snapshot_put_failed', error: putErr instanceof Error ? putErr.name : typeof putErr,
        }));
      }
      throw err;
    }
    // No successful response or in-memory checkpoint precedes persistence.
    await this.persist(outcome, startedAt, scheduledAt,
      outcome.error ? snapshot.lastSuccessfulPollAt : Date.now(), outcome.error);
    if (outcome.error) throw new Error(outcome.error);
    return { skipped: false };
  }

  /**
   * One durable write commits the state, cadence, and outcome together. Both
   * the success and the error path use it, and every PollSnapshot key must be
   * listed below (the mapped type fails to compile otherwise), so no path can
   * silently erase a field. Empty lists/maps and unset values are omitted.
   */
  private persist(
    carried: Omit<PollSnapshot, 'lastPollStartedAt' | 'lastScheduledPollStartedAt' | 'lastSuccessfulPollAt' | 'error'>,
    lastPollStartedAt: number, lastScheduledPollStartedAt: number | undefined,
    lastSuccessfulPollAt: number | undefined, error: string | undefined,
  ): Promise<void> {
    const nonEmpty = <T>(list: T[] | undefined) => (list?.length ? list : undefined);
    const next: { [K in keyof Required<PollSnapshot>]: PollSnapshot[K] } = {
      state: carried.state,
      pendingOffline: nonEmpty(carried.pendingOffline),
      rosterMessages: nonEmpty(carried.rosterMessages),
      rosterPostAttempts: nonEmpty(carried.rosterPostAttempts),
      rolePings: carried.rolePings && Object.keys(carried.rolePings).length ? carried.rolePings : undefined,
      lastPollStartedAt,
      lastScheduledPollStartedAt,
      lastSuccessfulPollAt,
      error: error || undefined,
    };
    // Dropping undefined keys only removes optional fields, so the result is still a PollSnapshot.
    return this.ctx.storage.put(POLL_SNAPSHOT_KEY,
      Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as unknown as PollSnapshot);
  }
}

function hourStart(ms: number): number {
  return ms - (ms % HOUR_MS);
}
