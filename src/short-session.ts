import { EMBED_FOOTER } from './config';
import { escapeMarkdown, isSnowflake, type DiscordEmbed } from './discord';
import type { DiscordRateLimitError, DiscordRateLimits } from './discord-rate-limit';
import {
  BACKOFF_KEY, classifyDeliveryFailure, discordJson, indexMemberVids, openDm, readBackoff, sharedMembers,
  type MemberListCache,
} from './gca';
import type { OfflineEvent, OnlineAtc, StateMap, TrackedAtc } from './types';

/** IVAO Rules & Regulations ask controllers to stay online at least this long. */
const MIN_SESSION_MS = 30 * 60_000;
/** A controller back online within this long reconnected rather than left. */
const REPORT_DELAY_MS = 10 * 60_000;
/** A reminder not deliverable within this long after the session ended is dropped. */
const EXPIRY_MS = 2 * 3_600_000;
/**
 * A reminder goes out between REPORT_DELAY_MS and EXPIRY_MS after its session
 * ended, so earlier rows that ended within 24 h plus EXPIRY_MS cover every
 * send (or possible send) in the last 24 h.
 */
const DAILY_WINDOW_MS = 24 * 3_600_000 + EXPIRY_MS;
/** Closed sessions are kept this long as segments of their IVAO connection. */
const SEGMENT_RETENTION_MS = 3 * 3_600_000;
const RETENTION_MS = 7 * 86_400_000;
const POSITIONS = new Set(['DEL', 'GND', 'TWR', 'APP', 'DEP', 'CTR', 'FSS']);
/** More ended sessions than this in one poll is treated as a feed anomaly. */
const MAX_ENDED_PER_POLL = 10;
const MAX_SENDS_PER_POLL = 3;
const MAX_ATTEMPTS = 5;

export interface ShortSessionConfig {
  memberRoleId: string;
  verifiedRoleId?: string;
}

/**
 * The feature's settings, or null when disabled. It reuses the GCA guild,
 * member-role and verified-role IDs, but not GCA_DM_ENABLED or the GCA
 * policy. Invalid IDs disable it for the poll; this never throws.
 */
export function shortSessionConfig(env: Env): ShortSessionConfig | null {
  if (env.SHORT_SESSION_DM_ENABLED !== 'true') return null;
  const verifiedRoleId = env.GCA_VERIFIED_ROLE_ID?.trim();
  if (!isSnowflake(env.GCA_DISCORD_GUILD_ID) || !isSnowflake(env.GCA_MEMBER_ROLE_ID) ||
      (verifiedRoleId && !isSnowflake(verifiedRoleId))) {
    console.error(JSON.stringify({ event: 'short_session_config_invalid' }));
    return null;
  }
  return { memberRoleId: env.GCA_MEMBER_ROLE_ID, ...(verifiedRoleId ? { verifiedRoleId } : {}) };
}

/** A stored poll time usable as `seenAfter`: a valid time not after this poll. */
export function trustedStateAt(raw: unknown, nowMs: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at <= nowMs ? new Date(at).toISOString() : undefined;
}

export function ensureShortSessionSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS short_sessions (
    session_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, callsign TEXT NOT NULL, session_ids TEXT NOT NULL,
    ended_at INTEGER NOT NULL, seen_after INTEGER NOT NULL, duration_minutes INTEGER NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS short_sessions_due_idx ON short_sessions (status, due_at)');
  sql.exec('CREATE INDEX IF NOT EXISTS short_sessions_user_idx ON short_sessions (user_id, ended_at)');
  // Recently closed sessions per IVAO connection, with their presence start
  // (NULL when unknown), so a connection tracked again after a feed gap keeps it.
  sql.exec(`CREATE TABLE IF NOT EXISTS short_session_segments (
    user_id INTEGER NOT NULL, session_id INTEGER NOT NULL, seen_after INTEGER, ended_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, session_id, ended_at)
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS short_session_segments_ended_idx ON short_session_segments (ended_at)');
}

/** A session's IVAO connection IDs: the first one seen and the latest. */
function connectionIds(session: TrackedAtc): number[] {
  return [...new Set([session.firstSessionId, session.sessionId])]
    .filter((id): id is number => Number.isSafeInteger(id) && id! > 0);
}

/**
 * Record carded sessions that provably lasted under MIN_SESSION_MS: from the
 * last poll before the presence was seen to the first poll it was missing.
 * A feed gap can close a connection that is then tracked again: every
 * session closed this poll (`prev` entries `next` does not continue) is kept
 * as a segment of its IVAO connections for SEGMENT_RETENTION_MS, and a later
 * session of the same connection starts no later than its earliest segment
 * (or is unprovable when that start is unknown).
 * Each candidate is deduplicated by session, so a poll whose state was not
 * saved can detect it again harmlessly. Also applies retention.
 */
export function recordShortSessions(
  storage: DurableObjectStorage, prev: StateMap, next: StateMap, ended: OfflineEvent[], nowIso: string,
): void {
  const sql = storage.sql;
  const nowMs = Date.parse(nowIso);
  ensureShortSessionSchema(sql);
  storage.transactionSync(() => {
    sql.exec('DELETE FROM short_sessions WHERE ended_at < ?', nowMs - RETENTION_MS);
    sql.exec("UPDATE short_sessions SET callsign = '' WHERE status NOT IN ('pending', 'reserved') AND callsign != ''");
    sql.exec('DELETE FROM short_session_segments WHERE ended_at < ?', nowMs - SEGMENT_RETENTION_MS);
  });
  const keyOf = (session: TrackedAtc) => `${session.userId}:${session.callsign}:${session.since}`;
  /** The earliest provable presence start (epoch ms), or null when unknown. */
  const presenceStart = (session: TrackedAtc): number | null => {
    let start = session.seenAfter === undefined ? NaN : Date.parse(session.seenAfter);
    if (!Number.isFinite(start)) return null;
    for (const id of connectionIds(session)) {
      for (const segment of sql.exec<{ seen_after: number | null }>(
        'SELECT seen_after FROM short_session_segments WHERE user_id = ? AND session_id = ?', session.userId, id).toArray()) {
        if (segment.seen_after === null) return null;
        start = Math.min(start, segment.seen_after);
      }
    }
    return start;
  };
  // Carded or not: an unannounced session's connection may still be tracked again.
  const closed = Object.entries(prev).filter(([callsign, session]) =>
    (Object.hasOwn(next, callsign) ? next[callsign] : undefined)?.since !== session.since).map(([, session]) => session);
  const starts = new Map(closed.map((session) => [keyOf(session), presenceStart(session)]));
  storage.transactionSync(() => {
    for (const session of closed) {
      if (!Number.isSafeInteger(session.userId) || session.userId <= 0) continue;
      const endedAt = Date.parse(session.missingSince ?? nowIso);
      if (!Number.isFinite(endedAt)) continue;
      for (const id of connectionIds(session)) {
        sql.exec(`INSERT OR IGNORE INTO short_session_segments (user_id, session_id, seen_after, ended_at)
          VALUES (?, ?, ?, ?)`, session.userId, id, starts.get(keyOf(session)) ?? null, endedAt);
      }
    }
  });
  const trackedBefore = Object.keys(prev).length;
  if (ended.length > MAX_ENDED_PER_POLL || (trackedBefore >= 4 && ended.length > trackedBefore / 2)) {
    console.error(JSON.stringify({ event: 'short_session_anomaly', ended: ended.length, tracked: trackedBefore }));
    return;
  }
  let recorded = 0;
  for (const event of ended) {
    if (!POSITIONS.has(event.position.toUpperCase()) || !Number.isSafeInteger(event.userId) || event.userId <= 0) continue;
    const seenAfter = starts.get(keyOf(event));
    if (seenAfter === null || seenAfter === undefined) continue;
    const endedAt = Date.parse(event.endedAt);
    const bound = endedAt - seenAfter;
    if (!Number.isFinite(bound) || bound < 0 || bound >= MIN_SESSION_MS) continue;
    const minutes = Math.max(1, Math.round(event.durationSeconds / 60));
    sql.exec(`INSERT OR IGNORE INTO short_sessions (session_key, user_id, callsign, session_ids, ended_at, seen_after,
      duration_minutes, status, due_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    keyOf(event), event.userId, event.callsign, JSON.stringify(connectionIds(event)),
    endedAt, seenAfter, minutes, endedAt + REPORT_DELAY_MS, endedAt + EXPIRY_MS);
    recorded++;
  }
  if (recorded) console.log(JSON.stringify({ event: 'short_session_recorded', count: recorded }));
}

/** The friendly reminder; it carries no member ID or other personal data. */
export function buildShortSessionEmbed(callsign: string, minutes: number): DiscordEmbed {
  const shown = escapeMarkdown(callsign);
  const duration = `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  return {
    title: `⏱️ ${shown} — short ATC session`,
    description: `You were connected as **${shown}** for ${duration}. IVAO Rules & Regulations ask controllers to connect only when they can stay online for at least 30 minutes. If something came up, no worries — this is just a friendly reminder.`,
    color: 0x5865f2,
    footer: { text: EMBED_FOOTER },
  };
}

/** Stored connection IDs; a corrupt value reads as none rather than failing every poll. */
function sessionIdsOf(stored: string): number[] {
  try {
    const ids: unknown = JSON.parse(stored);
    return Array.isArray(ids) ? ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

type ShortSessionRow = {
  session_key: string; user_id: number; callsign: string; session_ids: string; ended_at: number;
  duration_minutes: number; attempts: number; expires_at: number;
};

export interface ShortSessionDelivery {
  env: Env;
  config: ShortSessionConfig;
  storage: DurableObjectStorage;
  limits: DiscordRateLimits;
  /** The unfiltered division feed, including excluded and untuned positions. */
  currentAll: OnlineAtc[];
  /** Tracked positions in this poll's feed, and sessions tracked before it. */
  current: number;
  trackedBefore: number;
  /** The poll's shared DM deadline. */
  deadline: number;
  memberCache: MemberListCache;
}

/**
 * Send due reminders, at most once each: the row is reserved durably before
 * the message POST. Runs after the public cards, within what is left of the
 * poll's DM deadline. Logs carry event names and counts only.
 */
export async function sendShortSessionReminders(delivery: ShortSessionDelivery): Promise<void> {
  const { env, config, storage, limits, currentAll, deadline, memberCache } = delivery;
  const sql = storage.sql;
  ensureShortSessionSchema(sql);
  const now = Date.now();
  const due = sql.exec<ShortSessionRow>(`SELECT session_key, user_id, callsign, session_ids, ended_at, duration_minutes,
    attempts, expires_at FROM short_sessions WHERE status = 'pending' AND due_at <= ? AND retry_at <= ? AND attempts < ?
    ORDER BY due_at, rowid LIMIT 50`, now, now, MAX_ATTEMPTS).toArray();
  if (!due.length) return;
  const online = new Set(currentAll.map((atc) => atc.userId));
  // A feed suddenly much smaller than the tracked state cannot show who is still online.
  const feedShrunk = delivery.trackedBefore >= 4 && delivery.current < delivery.trackedBefore / 2;
  // Read-only: this path never creates or writes any GCA table.
  const gcaTable = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gca_reminders'")
    .toArray().length > 0;
  const finish = (key: string, status: string) => {
    sql.exec('UPDATE short_sessions SET status = ? WHERE session_key = ?', status, key);
    console.log(JSON.stringify({ event: 'short_session_skipped', reason: status }));
  };
  let index: Map<number, string> | undefined;
  let sends = 0;
  for (const row of due) {
    if (now > row.expires_at) { finish(row.session_key, 'expired'); continue; }
    if (online.has(row.user_id)) { finish(row.session_key, 'reconnected'); continue; }
    if (feedShrunk) continue;
    const sessionKeys = sessionIdsOf(row.session_ids).map((id) => `${row.user_id}:${id}`);
    if (gcaTable && sessionKeys.length && sql.exec(`SELECT 1 FROM gca_reminders WHERE session_key IN
      (${sessionKeys.map(() => '?').join(', ')}) AND status IN ('sent', 'reserved', 'failed') LIMIT 1`,
    ...sessionKeys).toArray().length) {
      finish(row.session_key, 'skipped_gca');
      continue;
    }
    // A failed row may still have been delivered (a timeout or 5xx after the POST).
    if (sql.exec(`SELECT 1 FROM short_sessions WHERE user_id = ? AND status IN ('sent', 'reserved', 'failed')
      AND ended_at > ? LIMIT 1`, row.user_id, now - DAILY_WINDOW_MS).toArray().length) {
      finish(row.session_key, 'skipped_daily');
      continue;
    }
    if (sends >= MAX_SENDS_PER_POLL || Date.now() >= deadline) break;
    if (await readBackoff(storage, BACKOFF_KEY, Date.now()) > Date.now()) break;
    if (!index) {
      let members;
      try {
        members = await sharedMembers(env, storage, limits, now, deadline, memberCache);
      } catch {
        // Already logged and backed off by the shared lookup; retried on a later poll.
        return;
      }
      if (!members) return;
      index = indexMemberVids(members, config.memberRoleId, config.verifiedRoleId);
    }
    const recipient = index.get(row.user_id);
    if (!recipient) { finish(row.session_key, 'unmapped'); continue; }
    sends++;
    let messageAttempted = false;
    try {
      const channelId = await openDm(limits, env.DISCORD_BOT_TOKEN, recipient);
      if (Date.now() >= deadline) break;
      sql.exec("UPDATE short_sessions SET status = 'reserved', attempts = attempts + 1 WHERE session_key = ?",
        row.session_key);
      await storage.sync();
      messageAttempted = true;
      const payload = { embeds: [buildShortSessionEmbed(row.callsign, row.duration_minutes)], allowed_mentions: { parse: [] } };
      const message = await discordJson(limits, env.DISCORD_BOT_TOKEN, `/channels/${channelId}/messages`, payload) as
        { id?: string } | null;
      // A 2xx POST delivered the DM even if the response body is unusable.
      sql.exec("UPDATE short_sessions SET status = 'sent' WHERE session_key = ?", row.session_key);
      console.log(JSON.stringify({ event: message?.id ? 'short_session_dm_sent' : 'short_session_dm_sent_unconfirmed' }));
    } catch (err) {
      const outcome = classifyDeliveryFailure(err, row.attempts, messageAttempted, Date.now());
      sql.exec('UPDATE short_sessions SET status = ?, attempts = ?, retry_at = ? WHERE session_key = ?',
        outcome.status, outcome.attempts, outcome.retryAt, row.session_key);
      console.warn(JSON.stringify({
        event: 'short_session_dm_failed', status: outcome.statusCode, retry: outcome.status === 'pending',
      }));
      if (outcome.rateLimited) {
        // Only a genuinely global limit widens the backoff shared with GCA DMs.
        if ((err as DiscordRateLimitError).global) await storage.put(BACKOFF_KEY, outcome.retryAt);
        break;
      }
    }
  }
}
