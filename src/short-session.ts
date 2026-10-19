import { EMBED_FOOTER } from './config';
import { escapeMarkdown, isSnowflake, type DiscordEmbed } from './discord';
import type { DiscordRateLimitError, DiscordRateLimits } from './discord-rate-limit';
import {
  BACKOFF_KEY, classifyDeliveryFailure, discordJson, GcaDeadlineError, indexMemberVids, openDm, readBackoff,
  sharedMembers, type MemberListCache,
} from './gca';
import type { OfflineEvent, StateMap } from './types';

/** IVAO Rules & Regulations ask controllers to stay online at least this long. */
const MIN_SESSION_MS = 30 * 60_000;
/** Poll times are not exact: a bound within this of MIN_SESSION_MS is not reported. */
const MARGIN_MS = 60_000;
/** A controller back online within this long reconnected rather than left. */
const REPORT_DELAY_MS = 10 * 60_000;
/** A member missing for less than this between recorded polls stayed online. */
const LINK_MS = 10 * 60_000;
/** A reminder not deliverable within this long after the presence ended is dropped. */
const EXPIRY_MS = 2 * 3_600_000;
/**
 * A reminder goes out between REPORT_DELAY_MS and EXPIRY_MS after its presence
 * ended, so earlier rows that ended within 24 h plus EXPIRY_MS cover every
 * send (or possible send) in the last 24 h.
 */
const DAILY_WINDOW_MS = 24 * 3_600_000 + EXPIRY_MS;
/** Online records are kept this long after the member was last missed. */
const ONLINE_RETENTION_MS = 3_600_000;
const RETENTION_MS = 7 * 86_400_000;
const POSITIONS = new Set(['DEL', 'GND', 'TWR', 'APP', 'DEP', 'CTR', 'FSS']);
/** More ended sessions, or new online records, than this in one poll is a feed anomaly. */
const MAX_ENDED_PER_POLL = 10;
const MAX_NEW_ONLINE_PER_POLL = 10;
const MAX_SENDS_PER_POLL = 3;
const MAX_ATTEMPTS = 5;
/** Delivery runs after the snapshot is saved, with this budget of its own. */
export const SHORT_SESSION_DM_BUDGET_MS = 15_000;
/** A member-list lookup of its own starts only with at least this much budget left. */
const MIN_MEMBER_LIST_BUDGET_MS = 10_000;
/**
 * The stateAt (epoch ms) of the last poll whose online records were fully
 * committed. Deleted at the start of every recording, so any failure, an
 * unsaved snapshot or a poll that did not record makes the next one baseline.
 */
const RECORDED_KEY = 'short-session-recorded-v1';
/** Short-session's own member-list lookups that ran out of budget: never GCA's counters. */
const MEMBER_LIST_KEY = 'short-session-member-list-v1';
const MEMBER_LIST_DEADLINE_LIMIT = 2;
const MEMBER_LIST_PAUSE_MS = 5 * 60_000;
/** Keys of earlier, never-released designs: removed whenever seen. */
const OLD_KEYS = ['short-session-presence-poll-v1', 'short-session-recording-v1'];
const ALL_KEYS = [RECORDED_KEY, ...OLD_KEYS, MEMBER_LIST_KEY];

const REMINDERS = 'short_session_reminders_v2';
const ONLINE = 'short_session_online';
/** Tables of earlier, never-released designs: dropped, never migrated. */
const OLD_TABLES = ['short_session_reminders', 'short_session_segments', 'short_session_presence', 'short_sessions'];
const ALL_TABLES = [ONLINE, REMINDERS, ...OLD_TABLES];

export interface ShortSessionConfig {
  memberRoleId: string;
  verifiedRoleId: string;
}

export type ShortSessionMode =
  | { kind: 'enabled'; config: ShortSessionConfig }
  | { kind: 'disabled' }
  | { kind: 'purge' };

/**
 * "true" enables the feature, "purge" deletes its data, anything else keeps
 * it off. It reuses the GCA guild, member-role and verified-role IDs (all
 * required), but not GCA_DM_ENABLED or the GCA policy. Invalid IDs disable
 * it for the poll; this never throws.
 */
export function shortSessionMode(env: Env): ShortSessionMode {
  if (env.SHORT_SESSION_DM_ENABLED === 'purge') return { kind: 'purge' };
  if (env.SHORT_SESSION_DM_ENABLED !== 'true') return { kind: 'disabled' };
  const verifiedRoleId = env.GCA_VERIFIED_ROLE_ID?.trim();
  if (!isSnowflake(env.GCA_DISCORD_GUILD_ID) || !isSnowflake(env.GCA_MEMBER_ROLE_ID) || !isSnowflake(verifiedRoleId)) {
    console.error(JSON.stringify({ event: 'short_session_config_invalid' }));
    return { kind: 'disabled' };
  }
  return { kind: 'enabled', config: { memberRoleId: env.GCA_MEMBER_ROLE_ID, verifiedRoleId } };
}

/**
 * The stored poll time, when trusted: a valid time no later than the last
 * poll start and this poll, and no earlier than any stored session's start
 * or disappearance (which that poll must have seen). Otherwise none.
 */
export function trustedStateAt(raw: unknown, nowMs: number, lastPollStartedAt: unknown, sessions: StateMap): string | undefined {
  if (typeof raw !== 'string' || typeof lastPollStartedAt !== 'number') return undefined;
  const at = Date.parse(raw);
  if (!Number.isFinite(at) || at > nowMs || at > lastPollStartedAt) return undefined;
  for (const session of Object.values(sessions)) {
    for (const time of [session.since, session.missingSince]) {
      if (time === undefined) continue;
      const ms = Date.parse(time);
      if (!Number.isFinite(ms) || ms > at) return undefined;
    }
  }
  return new Date(at).toISOString();
}

/** The whole minutes of a bound, as shown in the reminder (1–29). */
export function reminderMinutes(boundMs: number): number {
  return Math.min(29, Math.max(1, Math.floor(boundMs / 60_000)));
}

function existingTables(sql: SqlStorage, names: string[]): string[] {
  return sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN (${names.map(() => '?').join(', ')})`, ...names).toArray().map((row) => row.name);
}

/** Only on a recorded poll: a disabled or purging feature never creates tables. */
function ensureShortSessionSchema(sql: SqlStorage): void {
  for (const table of OLD_TABLES) sql.exec(`DROP TABLE IF EXISTS ${table}`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${REMINDERS} (
    session_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, callsign TEXT NOT NULL, online_since INTEGER NOT NULL,
    ended_at INTEGER NOT NULL, duration_minutes INTEGER NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${REMINDERS}_due_idx ON ${REMINDERS} (status, due_at)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${REMINDERS}_user_idx ON ${REMINDERS} (user_id, ended_at)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${REMINDERS}_ended_idx ON ${REMINDERS} (ended_at)`);
  // One record per member present in the division feed, at any position:
  // online_since is the last recorded poll before they appeared (NULL when
  // unknown), missing_since the first recorded poll that missed them.
  sql.exec(`CREATE TABLE IF NOT EXISTS ${ONLINE} (
    user_id INTEGER PRIMARY KEY, online_since INTEGER, missing_since INTEGER
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${ONLINE}_missing_idx ON ${ONLINE} (missing_since)`);
}

const isVid = (id: number) => Number.isSafeInteger(id) && id > 0;

/** Reminder retention: rows go after 7 days; finished or expired rows keep no callsign. */
function reminderRetention(sql: SqlStorage, nowMs: number): void {
  sql.exec(`DELETE FROM ${REMINDERS} WHERE ended_at < ?`, nowMs - RETENTION_MS);
  // Reserved rows still count towards the daily cap.
  sql.exec(`UPDATE ${REMINDERS} SET callsign = '' WHERE callsign != ''
    AND (expires_at < ? OR status NOT IN ('pending', 'reserved'))`, nowMs);
}

/** What one recorded poll hands to short-session recording. */
export interface ShortSessionPoll {
  /** Carded sessions the feed showed ending this poll (never excluded closures). */
  ended: OfflineEvent[];
  nowIso: string;
  /** Sessions tracked before this poll. */
  trackedBefore: number;
  /** VIDs of every division entry, at any position, before duplicate callsigns are merged. */
  presentVids: number[];
  /** The previous poll's time, when trusted (see `trustedStateAt`). */
  previousStateAt: string | undefined;
}

/**
 * A recorded poll (enabled, valid configuration): update each member's online
 * record, then record carded sessions whose whole presence provably lasted
 * under MIN_SESSION_MS, with MARGIN_MS to spare.
 *
 * A member's presence runs from the last recorded poll before they appeared
 * to the first recorded poll that missed them; a gap shorter than LINK_MS
 * between recorded polls (measured between those polls, so time without
 * recorded polls never splits a presence) continues it. Unless the previous
 * recorded poll is this poll's trusted predecessor, every record starts over
 * with an unknown start, as do records created on a poll where many members
 * appear at once.
 */
export async function recordShortSessions(storage: DurableObjectStorage, poll: ShortSessionPoll): Promise<void> {
  const sql = storage.sql;
  const nowMs = Date.parse(poll.nowIso);
  const recorded = await storage.get<unknown>(RECORDED_KEY);
  await storage.delete([RECORDED_KEY, ...OLD_KEYS]);
  ensureShortSessionSchema(sql);
  const previous = poll.previousStateAt === undefined ? undefined : Date.parse(poll.previousStateAt);
  const baseline = previous === undefined || !Number.isFinite(previous) || recorded !== previous;
  const present = new Set(poll.presentVids.filter(isVid));
  const { ended, trackedBefore } = poll;
  const anomaly = ended.length > MAX_ENDED_PER_POLL || (trackedBefore >= 4 && ended.length > trackedBefore / 2);
  let fresh = 0;
  let mass = false;
  let candidates = 0;
  storage.transactionSync(() => {
    reminderRetention(sql, nowMs);
    if (baseline) sql.exec(`DELETE FROM ${ONLINE}`);
    const rows = new Map(sql.exec<{ user_id: number; missing_since: number | null }>(
      `SELECT user_id, missing_since FROM ${ONLINE}`).toArray().map((row) => [row.user_id, row.missing_since]));
    const continues = (id: number) => {
      if (!rows.has(id)) return false;
      const missing = rows.get(id)!;
      return missing === null || previous! - missing < LINK_MS;
    };
    const appearing = [...present].filter((id) => !continues(id));
    fresh = appearing.length;
    mass = fresh > MAX_NEW_ONLINE_PER_POLL || (present.size >= 4 && fresh > present.size / 2);
    for (const id of present) {
      if (continues(id)) sql.exec(`UPDATE ${ONLINE} SET missing_since = NULL WHERE user_id = ?`, id);
    }
    for (const id of appearing) {
      sql.exec(`INSERT OR REPLACE INTO ${ONLINE} (user_id, online_since, missing_since) VALUES (?, ?, NULL)`,
        id, baseline || mass ? null : previous!);
    }
    for (const [id, missing] of rows) {
      if (!present.has(id) && missing === null) {
        sql.exec(`UPDATE ${ONLINE} SET missing_since = ? WHERE user_id = ?`, nowMs, id);
      }
    }
    sql.exec(`DELETE FROM ${ONLINE} WHERE missing_since < ?`, nowMs - ONLINE_RETENTION_MS);
    if (anomaly) return;
    for (const event of ended) {
      if (!POSITIONS.has(event.position.toUpperCase()) || !isVid(event.userId)) continue;
      const row = sql.exec<{ online_since: number | null; missing_since: number | null }>(
        `SELECT online_since, missing_since FROM ${ONLINE} WHERE user_id = ?`, event.userId).toArray()[0];
      if (!row || row.online_since === null || row.missing_since === null) continue;
      // The session must lie within this one presence.
      if (!(row.online_since <= Date.parse(event.since) && row.missing_since >= Date.parse(event.endedAt))) continue;
      const bound = row.missing_since - row.online_since;
      if (bound + MARGIN_MS >= MIN_SESSION_MS) continue;
      // Keyed by presence: a later session of the same presence replaces a
      // reminder not yet acted on.
      sql.exec(`INSERT INTO ${REMINDERS} (session_key, user_id, callsign, online_since, ended_at, duration_minutes,
        status, due_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET status = 'pending', ended_at = excluded.ended_at,
          due_at = excluded.due_at, expires_at = excluded.expires_at, duration_minutes = excluded.duration_minutes,
          callsign = excluded.callsign
        WHERE status IN ('pending', 'reconnected')`,
      `${event.userId}:${row.online_since}`, event.userId, event.callsign, row.online_since, row.missing_since,
      reminderMinutes(bound), row.missing_since + REPORT_DELAY_MS, row.missing_since + EXPIRY_MS);
      candidates++;
    }
  });
  // Only now, with every update committed, may the next poll continue from this one.
  await storage.put(RECORDED_KEY, nowMs);
  if (baseline) console.log(JSON.stringify({ event: 'short_session_baseline', online: present.size }));
  else if (mass) console.log(JSON.stringify({ event: 'short_session_mass_reappearance', count: fresh }));
  if (anomaly) console.error(JSON.stringify({ event: 'short_session_anomaly', ended: ended.length, tracked: trackedBefore }));
  if (candidates) console.log(JSON.stringify({ event: 'short_session_recorded', count: candidates }));
}

/**
 * Disabled or misconfigured: no online records are kept (the next recorded
 * poll baselines), reminders still expire, and no table is ever created.
 */
export async function maintainShortSessions(storage: DurableObjectStorage, nowIso: string): Promise<void> {
  const sql = storage.sql;
  const tables = existingTables(sql, ALL_TABLES);
  if (tables.length) {
    storage.transactionSync(() => {
      for (const table of tables) if (table !== REMINDERS) sql.exec(`DROP TABLE IF EXISTS ${table}`);
      if (tables.includes(REMINDERS)) reminderRetention(sql, Date.parse(nowIso));
    });
  }
  const keys = [RECORDED_KEY, ...OLD_KEYS];
  if ((await storage.get(keys)).size) await storage.delete(keys);
}

/** Purge mode: drop every short-session table and key; never creates anything. */
export async function purgeShortSessions(storage: DurableObjectStorage): Promise<void> {
  const sql = storage.sql;
  const tables = existingTables(sql, ALL_TABLES);
  storage.transactionSync(() => {
    for (const table of tables) sql.exec(`DROP TABLE IF EXISTS ${table}`);
  });
  await storage.delete(ALL_KEYS);
  console.log(JSON.stringify({ event: 'short_session_purged', tables: tables.length }));
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

type ReminderRow = {
  session_key: string; user_id: number; callsign: string; online_since: number; ended_at: number;
  duration_minutes: number; attempts: number; expires_at: number;
};

/** What runPoll hands the coordinator for delivery after the snapshot is saved. */
export interface ShortSessionHandoff {
  config: ShortSessionConfig;
  limits: DiscordRateLimits;
  /** This poll's start (its stateAt, epoch ms): delivery runs only if it was fully recorded. */
  stateAtMs: number;
  /** VIDs of every division entry this poll, at any position. */
  presentVids: number[];
  /** Sessions tracked before the poll, and tracked positions in its feed. */
  trackedBefore: number;
  current: number;
  /** The poll's member-list lookup, if GCA already made one. */
  memberCache: MemberListCache;
  /** GCA made a member DM or staff-copy request this poll. */
  gcaAttempted: boolean;
}

/**
 * Send due reminders, at most once each: the row is reserved durably before
 * the message POST. Logs carry event names and counts only.
 */
export async function sendShortSessionReminders(
  env: Env, storage: DurableObjectStorage, handoff: ShortSessionHandoff, deadline: number,
): Promise<void> {
  const { config, limits, memberCache } = handoff;
  const sql = storage.sql;
  if (existingTables(sql, [REMINDERS, ONLINE]).length < 2) return;
  if (await storage.get(RECORDED_KEY) !== handoff.stateAtMs) {
    console.log(JSON.stringify({ event: 'short_session_skipped', reason: 'unrecorded_poll' }));
    return;
  }
  const now = Date.now();
  const due = sql.exec<ReminderRow>(`SELECT session_key, user_id, callsign, online_since, ended_at, duration_minutes,
    attempts, expires_at FROM ${REMINDERS}
    WHERE status = 'pending' AND due_at <= ? AND retry_at <= ? AND attempts < ?
    ORDER BY due_at, rowid LIMIT 50`, now, now, MAX_ATTEMPTS).toArray();
  if (!due.length) return;
  const present = new Set(handoff.presentVids);
  // A feed suddenly much smaller than the tracked state cannot show who is still online.
  const feedShrunk = handoff.trackedBefore >= 4 && handoff.current < handoff.trackedBefore / 2;
  // Read-only: this path never creates or writes any GCA table.
  const gcaTable = existingTables(sql, ['gca_reminders']).length > 0;
  const finish = (key: string, status: string) => {
    sql.exec(`UPDATE ${REMINDERS} SET status = ? WHERE session_key = ?`, status, key);
    console.log(JSON.stringify({ event: 'short_session_skipped', reason: status }));
  };
  let index: Map<number, string> | undefined;
  let sends = 0;
  for (const row of due) {
    if (now > row.expires_at) { finish(row.session_key, 'expired'); continue; }
    // Online now, or online at any recorded poll since the presence ended.
    const online = sql.exec<{ missing_since: number | null }>(
      `SELECT missing_since FROM ${ONLINE} WHERE user_id = ?`, row.user_id).toArray()[0];
    if (present.has(row.user_id) || !online || online.missing_since !== row.ended_at) {
      finish(row.session_key, 'reconnected');
      continue;
    }
    if (feedShrunk) continue;
    // A GCA reminder possibly delivered to this member during this presence
    // already told them about it.
    if (gcaTable && sql.exec(`SELECT 1 FROM gca_reminders WHERE session_key LIKE ? AND last_seen >= ?
      AND status IN ('sent', 'reserved', 'failed') LIMIT 1`, `${row.user_id}:%`, row.online_since).toArray().length) {
      finish(row.session_key, 'skipped_gca');
      continue;
    }
    // A failed row may still have been delivered (a timeout or 5xx after the POST).
    if (sql.exec(`SELECT 1 FROM ${REMINDERS} WHERE user_id = ? AND status IN ('sent', 'reserved', 'failed')
      AND ended_at > ? LIMIT 1`, row.user_id, now - DAILY_WINDOW_MS).toArray().length) {
      finish(row.session_key, 'skipped_daily');
      continue;
    }
    // Never two kinds of DM from this bot in one poll.
    if (handoff.gcaAttempted) break;
    if (sends >= MAX_SENDS_PER_POLL || Date.now() >= deadline) break;
    if (await readBackoff(storage, BACKOFF_KEY, Date.now()) > Date.now()) break;
    if (!index) {
      // A lookup of its own needs time to finish within this budget.
      if (!memberCache.fetched && deadline - Date.now() < MIN_MEMBER_LIST_BUDGET_MS) return;
      const own = await storage.get<{ failures?: number; until?: number }>(MEMBER_LIST_KEY);
      if (!memberCache.fetched && typeof own?.until === 'number' && own.until > Date.now() &&
          own.until <= Date.now() + MEMBER_LIST_PAUSE_MS) return;
      let members;
      try {
        members = await sharedMembers(env, storage, limits, now, deadline, memberCache, { countDeadline: false });
      } catch (err) {
        // Other failures are logged and backed off by the shared lookup. A
        // lookup that keeps running out of this budget pauses only this feature's.
        if (err instanceof GcaDeadlineError) {
          const failures = (typeof own?.failures === 'number' ? own.failures : 0) + 1;
          await storage.put(MEMBER_LIST_KEY, failures >= MEMBER_LIST_DEADLINE_LIMIT
            ? { failures: 0, until: Date.now() + MEMBER_LIST_PAUSE_MS } : { failures });
        }
        return;
      }
      if (!members) return;
      if (own) await storage.delete(MEMBER_LIST_KEY);
      index = indexMemberVids(members, config.memberRoleId, config.verifiedRoleId);
    }
    const recipient = index.get(row.user_id);
    if (!recipient) { finish(row.session_key, 'unmapped'); continue; }
    sends++;
    let messageAttempted = false;
    try {
      const channelId = await openDm(limits, env.DISCORD_BOT_TOKEN, recipient);
      if (Date.now() >= deadline) break;
      sql.exec(`UPDATE ${REMINDERS} SET status = 'reserved', attempts = attempts + 1 WHERE session_key = ?`,
        row.session_key);
      await storage.sync();
      messageAttempted = true;
      const payload = { embeds: [buildShortSessionEmbed(row.callsign, row.duration_minutes)], allowed_mentions: { parse: [] } };
      const message = await discordJson(limits, env.DISCORD_BOT_TOKEN, `/channels/${channelId}/messages`, payload) as
        { id?: string } | null;
      // A 2xx POST delivered the DM even if the response body is unusable.
      sql.exec(`UPDATE ${REMINDERS} SET status = 'sent' WHERE session_key = ?`, row.session_key);
      console.log(JSON.stringify({ event: message?.id ? 'short_session_dm_sent' : 'short_session_dm_sent_unconfirmed' }));
    } catch (err) {
      const outcome = classifyDeliveryFailure(err, row.attempts, messageAttempted, Date.now());
      // As for GCA reminders: only a message POST that was made and not
      // explicitly rejected may have delivered. A definite non-delivery is
      // 'rejected' and does not count towards the daily cap.
      const code = outcome.statusCode;
      const rejected = outcome.status === 'failed' && (!messageAttempted || outcome.rateLimited ||
        (typeof code === 'number' && code >= 400 && code < 500));
      sql.exec(`UPDATE ${REMINDERS} SET status = ?, attempts = ?, retry_at = ? WHERE session_key = ?`,
        rejected ? 'rejected' : outcome.status, outcome.attempts, outcome.retryAt, row.session_key);
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
