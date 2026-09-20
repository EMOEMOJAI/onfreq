import { DurableObject } from 'cloudflare:workers';
import { MIN_POLL_INTERVAL_MS, POLL_SNAPSHOT_KEY, STATE_KEY } from './config';
import { runPoll } from './poll';
import type { PendingOffline, RosterMessage, StateMap } from './types';
import { cleanupGcaCopies } from './retention';

export const HEALTH_MAX_AGE_MS = 5 * 60_000;

export interface PollSnapshot {
  state: StateMap | null;
  rosterMessages?: RosterMessage[];
  pendingOffline?: PendingOffline[];
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
    const ok = ageMs !== null && ageMs >= 0 && ageMs < HEALTH_MAX_AGE_MS;
    return { ok, lastSuccessfulPollAt, maxAgeSeconds: HEALTH_MAX_AGE_MS / 1000 };
  }

  cleanupGcaHistory(apply: boolean) {
    // Never race a reminder POST/reservation or a staff-copy retry. The cleanup
    // itself is synchronous, so no poll can interleave with its transaction.
    if (this.inFlight) return { busy: true as const };
    return { busy: false as const, ...cleanupGcaCopies(this.ctx.storage, apply, Date.now()) };
  }

  async getGcaHistory(after = '') {
    const sql = this.ctx.storage.sql;
    const tables = new Set(sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('gca_reminders', 'gca_occurrences')",
    ).toArray().map((row) => row.name));
    if (!tables.has('gca_reminders')) return { records: [], nextCursor: null };
    const hasOccurrences = tables.has('gca_occurrences');
    const records = sql.exec<{
      sessionKey: string; status: string; attempts: number; lastSeenAt: number; occurrence: number | null;
    }>(`SELECT r.session_key AS sessionKey, r.status, r.attempts, r.last_seen AS lastSeenAt,
      ${hasOccurrences ? 'o.occurrence' : 'NULL'} AS occurrence
      FROM gca_reminders r
      ${hasOccurrences ? 'LEFT JOIN gca_occurrences o ON o.session_key = r.session_key' : ''}
      WHERE r.session_key > ? AND (r.attempts > 0 OR r.status IN ('sent', 'reserved', 'failed'))
      ORDER BY r.session_key LIMIT 101`, after).toArray();
    return { records: records.slice(0, 100), nextCursor: records.length > 100 ? records[99]!.sessionKey : null };
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
    if (snapshot.lastPollStartedAt !== undefined &&
        startedAt - snapshot.lastPollStartedAt < MIN_POLL_INTERVAL_MS) {
      if (snapshot.error) throw new Error(snapshot.error);
      return { skipped: true };
    }

    const outcome = await runPoll(this.env, snapshot.state, new Date(startedAt).toISOString(),
      this.ctx.storage, snapshot.rosterMessages, snapshot.pendingOffline);
    // One durable write commits the state, cadence, and outcome together.
    // No successful response or in-memory checkpoint precedes persistence.
    await this.ctx.storage.put(POLL_SNAPSHOT_KEY, {
      state: outcome.state,
      ...(outcome.pendingOffline.length ? { pendingOffline: outcome.pendingOffline } : {}),
      ...(outcome.rosterMessages.length ? { rosterMessages: outcome.rosterMessages } : {}),
      lastPollStartedAt: startedAt,
      ...(outcome.error
        ? (snapshot.lastSuccessfulPollAt === undefined ? {} : { lastSuccessfulPollAt: snapshot.lastSuccessfulPollAt })
        : { lastSuccessfulPollAt: Date.now() }),
      ...(outcome.error ? { error: outcome.error } : {}),
    } satisfies PollSnapshot);
    if (outcome.error) throw new Error(outcome.error);
    return { skipped: false };
  }
}
