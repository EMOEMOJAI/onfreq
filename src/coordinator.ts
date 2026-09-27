import { DurableObject } from 'cloudflare:workers';
import { MIN_POLL_INTERVAL_MS, POLL_SNAPSHOT_KEY, STATE_KEY } from './config';
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
  lastPollStartedAt?: number;
  lastSuccessfulPollAt?: number;
  error?: string;
}

export interface PollResult {
  skipped: boolean;
}

/** One object owns this bot's session state and serializes both trigger sources. */
export class PollCoordinator extends DurableObject<Env> {
  private inFlight?: Promise<PollResult>;

  async poll(): Promise<PollResult> {
    // Set synchronously before yielding: external fetches permit other RPCs
    // to enter this object, so storage consistency alone is not a mutex.
    if (this.inFlight) {
      await this.inFlight;
      return { skipped: true };
    }
    this.inFlight = this.runOnce();
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
    const lastSuccessfulPollAt = snapshot?.lastSuccessfulPollAt ?? null;
    const ageMs = lastSuccessfulPollAt === null ? null : Date.now() - lastSuccessfulPollAt;
    // A negative age (clock skew or a corrupted future timestamp) is treated
    // as unhealthy rather than trusted, same as a stale one.
    const ok = ageMs !== null && ageMs >= 0 && ageMs < HEALTH_MAX_AGE_MS;
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

  private async runOnce(): Promise<PollResult> {
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
    const elapsed = snapshot.lastPollStartedAt === undefined ? undefined : startedAt - snapshot.lastPollStartedAt;
    if (elapsed !== undefined && elapsed >= 0 && elapsed < MIN_POLL_INTERVAL_MS) {
      if (snapshot.error) throw new Error(snapshot.error);
      return { skipped: true };
    }

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
        await this.persist(snapshot, startedAt, snapshot.lastSuccessfulPollAt,
          err instanceof Error ? err.message : String(err));
      } catch (putErr) {
        console.error(JSON.stringify({ event: 'poll_snapshot_put_failed', error: String(putErr) }));
      }
      throw err;
    }
    // No successful response or in-memory checkpoint precedes persistence.
    await this.persist(outcome, startedAt,
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
  private persist(carried: Omit<PollSnapshot, 'lastPollStartedAt' | 'lastSuccessfulPollAt' | 'error'>,
    lastPollStartedAt: number, lastSuccessfulPollAt: number | undefined, error: string | undefined): Promise<void> {
    const nonEmpty = <T>(list: T[] | undefined) => (list?.length ? list : undefined);
    const next: { [K in keyof Required<PollSnapshot>]: PollSnapshot[K] } = {
      state: carried.state,
      pendingOffline: nonEmpty(carried.pendingOffline),
      rosterMessages: nonEmpty(carried.rosterMessages),
      rosterPostAttempts: nonEmpty(carried.rosterPostAttempts),
      rolePings: carried.rolePings && Object.keys(carried.rolePings).length ? carried.rolePings : undefined,
      lastPollStartedAt,
      lastSuccessfulPollAt,
      error: error || undefined,
    };
    // Dropping undefined keys only removes optional fields, so the result is still a PollSnapshot.
    return this.ctx.storage.put(POLL_SNAPSHOT_KEY,
      Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as unknown as PollSnapshot);
  }
}
