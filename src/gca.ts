import { EMBED_FOOTER, firOf, parseFirLabels, type FirLabel } from './config';
import type { DiscordEmbed } from './discord';
import { fetchBuffered } from './http';
import { hasFrequency } from './ivao';
import { countryCode } from './member-country';
import type { OnlineAtc } from './types';

type Region = string;
const LEVELS: Record<string, number> = { DEL: 1, GND: 1, TWR: 1, APP: 2, DEP: 2, CTR: 3 };
const MAX_LEVEL = 3;
// Leave room for the reminder text within Discord's 4096-character description.
const MAX_POLICY_URL_LENGTH = 2048;
const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
const API = 'https://discord.com/api/v10';
const INITIALIZED_KEY = 'gca-initialized-v1'; // gitleaks:allow — storage key name, not a credential
const BACKOFF_KEY = 'gca-discord-backoff-v1';
const RETENTION_MS = 7 * 86_400_000;
const MAX_SENDS_PER_POLL = 3;
const MAX_ATTEMPTS = 5;
const OCCURRENCE_MIGRATION = 'gca-occurrences-migrated-v1';

export interface GcaApproval {
  region: Region;
  level: number;
}

/**
 * Operator-supplied coverage and member records belong in private secrets.
 */
export interface GcaPolicy {
  regionNames: Record<Region, string>;
  regionByPrefix: Record<string, Region>;
  homeRegions: Record<string, Region>;
  approvals: Record<number, GcaApproval[]>;
  homeOverrides: Record<number, string>;
  policyUrl?: string;
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** IVAO member IDs are positive and have no leading zero. */
function isVid(key: string): boolean {
  return /^[1-9]\d{4,9}$/.test(key);
}

/** No built-in deployment policy; ambiguous or malformed coverage disables DMs. */
function parseRegions(raw: string | undefined): Pick<GcaPolicy, 'regionNames' | 'regionByPrefix' | 'homeRegions'> | null {
  const object = parseJsonObject(raw);
  if (!object || !Object.keys(object).length) return null;
  const regionNames: Record<string, string> = {};
  const regionByPrefix: Record<string, string> = {};
  const homeRegions: Record<string, string> = {};
  for (const [region, value] of Object.entries(object)) {
    if (countryCode(region) !== region || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { name, prefixes, homeCountries = [region] } = value as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f\\`*_~|\[\]<>]/.test(name)) return null;
    if (!Array.isArray(prefixes) || !prefixes.length || !Array.isArray(homeCountries) || !homeCountries.includes(region)) return null;
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string' || !/^[A-Z]{1,4}$/.test(prefix)) return null;
      if (Object.keys(regionByPrefix).some((existing) => existing.startsWith(prefix) || prefix.startsWith(existing))) return null;
      regionByPrefix[prefix] = region;
    }
    for (const home of homeCountries) {
      if (typeof home !== 'string' || countryCode(home) !== home || Object.hasOwn(homeRegions, home)) return null;
      homeRegions[home] = region;
    }
    regionNames[region] = name.trim();
  }
  return { regionNames, regionByPrefix, homeRegions };
}

/** `{"123456":[{"region":"AA","level":3}]}`; `{}` means nobody is approved. */
function parseApprovals(raw: string | undefined, regionNames: Record<Region, string>): Record<number, GcaApproval[]> | null {
  const object = parseJsonObject(raw);
  if (!object) return null;
  const result: Record<number, GcaApproval[]> = {};
  for (const [key, value] of Object.entries(object)) {
    if (!isVid(key) || !Array.isArray(value)) return null;
    const list: GcaApproval[] = [];
    for (const item of value as unknown[]) {
      const { region, level } = (item ?? {}) as { region?: unknown; level?: unknown };
      if (typeof region !== 'string' || !Object.hasOwn(regionNames, region)) return null;
      if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > MAX_LEVEL) return null;
      list.push({ region: region as Region, level: level as number });
    }
    result[Number(key)] = list;
  }
  return result;
}

/** `{"123456":"AA"}`; absent is fine, malformed is not. */
function parseHomeOverrides(raw: string | undefined): Record<number, string> | null {
  if (!raw?.trim()) return {};
  const object = parseJsonObject(raw);
  if (!object) return null;
  const result: Record<number, string> = {};
  for (const [key, value] of Object.entries(object)) {
    if (!isVid(key) || typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) return null;
    result[Number(key)] = value;
  }
  return result;
}

/**
 * Only an https link is embedded, and only one free of characters that would
 * break out of the markdown link: the DM goes to members, so a policy link
 * must never be attacker- or typo-shaped. A trailing backslash would escape
 * the closing paren and swallow the rest of the paragraph, so it is rejected
 * alongside the bracket and backtick forms.
 */
function parsePolicyUrl(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text || text.length > MAX_POLICY_URL_LENGTH || /[()[\]\\`\s<>]/.test(text)) return undefined;
  try {
    return new URL(text).protocol === 'https:' ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the policy from the environment, or null when coverage or approvals are missing
 * or malformed.
 *
 * Reminders are then skipped rather than sent with an empty record: telling
 * approved controllers they lack approval is far worse than staying quiet.
 */
export function parseGcaPolicy(env: Env): GcaPolicy | null {
  const regions = parseRegions(env.GCA_REGIONS);
  if (!regions) return null;
  const approvals = parseApprovals(env.GCA_APPROVALS, regions.regionNames);
  const homeOverrides = parseHomeOverrides(env.GCA_HOME_OVERRIDES);
  if (!approvals || !homeOverrides) return null;
  return { ...regions, approvals, homeOverrides, policyUrl: parsePolicyUrl(env.GCA_POLICY_URL) };
}

export interface GcaMismatch {
  region: Region;
  regionName: string;
  homeName: string;
  position: string;
}

/** Profile country is a fallback for home region, not proof of missing approval. */
export function gcaMismatch(atc: OnlineAtc, policy: GcaPolicy): GcaMismatch | null {
  const callsign = atc.callsign.toUpperCase();
  const region = Object.entries(policy.regionByPrefix).find(([prefix]) => callsign.startsWith(prefix))?.[1];
  const position = atc.position.toUpperCase();
  const level = LEVELS[position];
  // Unconfigured regions and unknown position types are excluded.
  if (!region || !level || !hasFrequency(atc)) return null;
  const home = policy.homeOverrides[atc.userId] ?? countryCode(atc.memberCountry?.countryId);
  if (!home) return null;
  const normalizedHome = policy.homeRegions[home] ?? home;
  if (normalizedHome === region) return null;
  const homeName = policy.regionNames[normalizedHome] ?? names.of(normalizedHome);
  if (!homeName) return null;
  if (policy.approvals[atc.userId]?.some((gca) => gca.region === region && gca.level >= level)) return null;
  return { region, regionName: policy.regionNames[region]!, homeName, position };
}

/** The approved paragraph-only warning card; no frequency/position/controller fields. */
export function buildGcaEmbed(
  atc: OnlineAtc, mismatch: GcaMismatch, occurrence = 1, policyUrl?: string, labels: FirLabel[] = [],
): DiscordEmbed {
  const regionName = mismatch.regionName;
  // IVAO text is external input: escape Discord formatting and cap its size.
  const station = (atc.station ?? '').slice(0, 100).replace(/[\\`*_~|\[\]<>]/g, '\\$&').replace(/[\r\n]/g, ' ');
  const label = `${atc.callsign}${station ? ` — ${station}` : ''}, ${regionName}`;
  const lastTwo = occurrence % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[occurrence % 10] ?? 'th');
  const occurrenceLabel = occurrence > 1 ? `[${occurrence}${suffix} occurrence] ` : '';
  return {
    title: `⚠️ ${occurrenceLabel}${firOf(atc.callsign, labels).flag} ${atc.callsign} — GCA approval reminder`,
    description: [
      'Hello,',
      `Our ATC monitor detected you online as **${label}**. Your recorded home region is **${mismatch.homeName}**, and our configured Guest Controller Approval (GCA) records do not show approval covering **${regionName} at ${mismatch.position} level**.`,
      `Controlling outside your home region requires an approval covering the region and position concerned.${policyUrl ? ` See the [GCA policy and application information](${policyUrl}).` : ''}`,
      '**If you do not hold the required approval, please disconnect from this position and obtain the appropriate GCA before reconnecting.** Operating without that approval violates the policy.',
      'If you already hold valid approval, or your home region is recorded incorrectly, please contact division staff so they can verify and update our records.',
    ].join('\n\n'),
    color: 0xfee75c,
    footer: { text: `${EMBED_FOOTER} · Automated notification` },
  };
}

export interface GuildMember {
  user: { id: string; bot?: boolean };
  nick?: string | null;
  roles: string[];
}

/** Include all accounts in ambiguity detection before checking the member role. */
export function indexMemberVids(members: GuildMember[], roleId: string): Map<number, string> {
  const matches = new Map<number, GuildMember[]>();
  for (const member of members) {
    const numbers = member.nick?.match(/\d+/g) ?? [];
    for (const vid of new Set(numbers.filter((n) => /^[1-9]\d{5}$/.test(n)).map(Number))) {
      const list = matches.get(vid) ?? [];
      list.push(member);
      matches.set(vid, list);
    }
  }
  const result = new Map<number, string>();
  for (const [vid, list] of matches) {
    const member = list[0]!;
    if (list.length === 1 && !member.user.bot && member.roles.includes(roleId) &&
        (member.nick?.match(/\d+/g) ?? []).length === 1) result.set(vid, member.user.id);
  }
  return result;
}

class GcaDiscordError extends Error {
  constructor(readonly status: number, readonly retryMs: number) {
    super(`Discord status ${status}`); // Never include response bodies or credentials in logs.
  }
}

/** No inline retries: a slow Discord service must not hold the poll indefinitely. */
async function discordJson(token: string, path: string, payload?: unknown): Promise<unknown> {
  const response = await fetchBuffered(`${API}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  if (!response.ok) {
    let seconds = Number(response.headers.get('retry-after'));
    if (response.status === 429) {
      const body = await response.json().catch(() => null) as { retry_after?: unknown } | null;
      if (typeof body?.retry_after === 'number') seconds = Math.max(seconds, body.retry_after);
    }
    throw new GcaDiscordError(response.status, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000);
  }
  return response.json();
}

async function openDm(token: string, recipient: string): Promise<string> {
  const channel = await discordJson(token, '/users/@me/channels', { recipient_id: recipient }) as {
    id?: string; type?: number; recipients?: { id: string }[];
  } | null;
  if (!channel || typeof channel.id !== 'string' || !/^\d{17,20}$/.test(channel.id) ||
      channel.type !== 1 || !Array.isArray(channel.recipients) ||
      channel.recipients.length !== 1 || channel.recipients[0]?.id !== recipient) {
    throw new Error('Unexpected DM recipient');
  }
  return channel.id;
}

function isMember(value: unknown): value is GuildMember {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<GuildMember>;
  return !!m.user && typeof m.user.id === 'string' && /^\d{17,20}$/.test(m.user.id) &&
    (m.user.bot === undefined || typeof m.user.bot === 'boolean') &&
    (m.nick === undefined || m.nick === null || typeof m.nick === 'string') &&
    Array.isArray(m.roles) && m.roles.every((role) => typeof role === 'string');
}

async function fetchMembers(token: string, guildId: string, deadline: number): Promise<GuildMember[]> {
  const members: GuildMember[] = [];
  let after = '0';
  // Never use a partial list: a duplicate VID could occur on a later page.
  for (let page = 0; page < 10; page++) {
    if (Date.now() >= deadline) throw new Error('Discord member lookup exceeded poll budget');
    const body = await discordJson(token, `/guilds/${guildId}/members?limit=1000&after=${after}`);
    if (!Array.isArray(body) || !body.every(isMember)) throw new Error('Invalid Discord member list');
    members.push(...body);
    if (body.length < 1000) return members;
    const last = body.at(-1)!.user.id;
    if (BigInt(last) <= BigInt(after)) throw new Error('Discord member pagination did not advance');
    after = last;
  }
  throw new Error('Discord member list exceeded page limit');
}

type ReminderRow = { status: string; attempts: number; retry_at: number };

/** Called inside the coordinator's serialized poll, before channel notifications. */
async function sendMemberReminders(
  env: Env, current: OnlineAtc[], storage: DurableObjectStorage, now: number,
): Promise<void> {
  if (env.GCA_DM_ENABLED !== 'true') return;
  // Missing or unusable configuration disables reminders for this poll; it
  // must never throw, or one bad setting would stop the online cards too.
  if (!/^\d{17,20}$/.test(env.GCA_DISCORD_GUILD_ID ?? '') || !/^\d{17,20}$/.test(env.GCA_MEMBER_ROLE_ID ?? '')) {
    console.error(JSON.stringify({ event: 'gca_config_invalid', reason: 'guild_or_role' }));
    return;
  }
  const policy = parseGcaPolicy(env);
  if (!policy) {
    console.error(JSON.stringify({ event: 'gca_config_invalid', reason: 'policy' }));
    return;
  }
  const labels = parseFirLabels(env.FIR_LABELS);
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS gca_reminders (
    session_key TEXT PRIMARY KEY, status TEXT NOT NULL, last_seen INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS gca_occurrences (
    session_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, occurrence INTEGER NOT NULL,
    UNIQUE(user_id, occurrence)
  )`);
  if (!await storage.get<boolean>(OCCURRENCE_MIGRATION)) {
    // Preserve known qualifying connections from before occurrence labels existed.
    // Failed attempts count as detections, not as proof of delivery or misconduct.
    // Baseline, unmapped and never-attempted pending connections do not count.
    sql.exec(`INSERT OR IGNORE INTO gca_occurrences (session_key, user_id, occurrence)
      SELECT session_key, CAST(substr(session_key, 1, instr(session_key, ':') - 1) AS INTEGER),
        ROW_NUMBER() OVER (
          PARTITION BY substr(session_key, 1, instr(session_key, ':') - 1)
          ORDER BY last_seen, session_key
        )
      FROM gca_reminders
      WHERE status IN ('sent', 'reserved', 'failed') OR (status = 'pending' AND attempts > 0)`);
    await storage.put(OCCURRENCE_MIGRATION, true);
  }
  const initialized = await storage.get<boolean>(INITIALIZED_KEY);
  const candidates: { atc: OnlineAtc; key: string; mismatch: GcaMismatch; attempts: number }[] = [];
  for (const atc of current) {
    if (!Number.isSafeInteger(atc.userId) || atc.userId <= 0 ||
        !Number.isSafeInteger(atc.sessionId) || atc.sessionId <= 0 ||
        !/^[A-Z0-9_]{3,40}$/.test(atc.callsign)) continue;
    const key = `${atc.userId}:${atc.sessionId}`;
    sql.exec(`INSERT INTO gca_reminders (session_key, status, last_seen) VALUES (?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET last_seen = excluded.last_seen`, key, initialized ? 'pending' : 'baseline', now);
    const row = sql.exec<ReminderRow>('SELECT status, attempts, retry_at FROM gca_reminders WHERE session_key = ?', key).one();
    const mismatch = gcaMismatch(atc, policy);
    if (row.status === 'pending' && row.retry_at <= now && row.attempts < MAX_ATTEMPTS && mismatch) {
      candidates.push({ atc, key, mismatch, attempts: row.attempts });
    }
  }
  // Keep every possible delivery permanently: even a very old connection ID
  // reappearing after a feed outage must not receive another notification.
  sql.exec("DELETE FROM gca_reminders WHERE last_seen < ? AND status NOT IN ('sent', 'reserved', 'failed')", now - RETENTION_MS);
  if (!initialized) {
    await storage.put(INITIALIZED_KEY, true);
    console.log(JSON.stringify({ event: 'gca_baseline_seeded', sessions: current.length }));
    return;
  }
  if (!candidates.length || (await storage.get<number>(BACKOFF_KEY) ?? 0) > now) return;
  const deadline = Date.now() + 25_000;
  const members = await fetchMembers(env.DISCORD_BOT_TOKEN, env.GCA_DISCORD_GUILD_ID, deadline).catch(async (err: unknown) => {
    if (err instanceof GcaDiscordError) await storage.put(BACKOFF_KEY, Date.now() + err.retryMs);
    throw err;
  });
  const index = indexMemberVids(members, env.GCA_MEMBER_ROLE_ID);
  let attemptsThisPoll = 0;
  for (const { atc, key, mismatch, attempts } of candidates) {
    if (attemptsThisPoll >= MAX_SENDS_PER_POLL || Date.now() >= deadline) break;
    // A duplicated upstream session must not send twice within one poll either.
    if (sql.exec<ReminderRow>('SELECT status, attempts, retry_at FROM gca_reminders WHERE session_key = ?', key).one().status !== 'pending') continue;
    const recipient = index.get(atc.userId);
    if (!recipient) {
      sql.exec("UPDATE gca_reminders SET status = 'unmapped' WHERE session_key = ?", key);
      console.log(JSON.stringify({ event: 'gca_skipped_unmapped', userId: atc.userId }));
      continue;
    }
    // One durable ordinal per VID/connection, shared across all target regions.
    // Retrying a rejected request or reconnecting the Worker never increments it.
    sql.exec(`INSERT OR IGNORE INTO gca_occurrences (session_key, user_id, occurrence)
      SELECT ?, ?, COALESCE(MAX(occurrence), 0) + 1 FROM gca_occurrences WHERE user_id = ?`,
    key, atc.userId, atc.userId);
    const { occurrence } = sql.exec<{ occurrence: number }>(
      'SELECT occurrence FROM gca_occurrences WHERE session_key = ?', key).one();
    attemptsThisPoll++;
    const payload = { embeds: [buildGcaEmbed(atc, mismatch, occurrence, policy.policyUrl, labels)], allowed_mentions: { parse: [] } };
    let messageAttempted = false;
    try {
      const channelId = await openDm(env.DISCORD_BOT_TOKEN, recipient);
      if (Date.now() >= deadline) break;
      // Persist reservation BEFORE the message POST. An ambiguous timeout or crash
      // must never generate repeated warning DMs on a later poll/redeployment.
      sql.exec("UPDATE gca_reminders SET status = 'reserved', attempts = attempts + 1 WHERE session_key = ?", key);
      await storage.sync();
      messageAttempted = true;
      const message = await discordJson(env.DISCORD_BOT_TOKEN, `/channels/${channelId}/messages`, payload) as { id?: string } | null;
      if (!message?.id) throw new Error('Discord message response missing id');
      storage.transactionSync(() => {
        sql.exec("UPDATE gca_reminders SET status = 'sent' WHERE session_key = ?", key);
        if (/^\d{17,20}$/.test(env.GCA_COPY_USER_ID ?? '') && env.GCA_COPY_USER_ID !== recipient) {
          // Save the exact sent embed: later retries must not rebuild it from a new feed/profile.
          sql.exec(`INSERT OR IGNORE INTO gca_copies (session_key, recipient_id, payload, status)
            VALUES (?, ?, ?, 'pending')`, key, env.GCA_COPY_USER_ID,
          JSON.stringify({ ...payload, content: `Copy of reminder sent to <@${recipient}> · VID ${atc.userId}` }));
        }
      });
      console.log(JSON.stringify({ event: 'gca_dm_sent', userId: atc.userId, callsign: atc.callsign, occurrence }));
    } catch (err) {
      const rateLimited = err instanceof GcaDiscordError && err.status === 429;
      const permanent = err instanceof GcaDiscordError && err.status >= 400 && err.status < 500 && !rateLimited;
      // 429 is an explicit rejection, safe to retry after its requested delay.
      // Timeouts/5xx after the message POST may have delivered: do not retry those.
      const retry = !permanent && (!messageAttempted || rateLimited) && attempts + 1 < MAX_ATTEMPTS;
      const delay = err instanceof GcaDiscordError ? err.retryMs : 60_000;
      sql.exec('UPDATE gca_reminders SET status = ?, attempts = ?, retry_at = ? WHERE session_key = ?',
        retry ? 'pending' : 'failed', attempts + 1, Date.now() + delay, key);
      console.warn(JSON.stringify({ event: 'gca_dm_failed', userId: atc.userId,
        status: err instanceof GcaDiscordError ? err.status : 'unavailable', retry }));
      if (rateLimited) {
        await storage.put(BACKOFF_KEY, Date.now() + delay);
        break;
      }
    }
  }
}

type CopyRow = ReminderRow & { session_key: string; recipient_id: string; payload: string };

async function sendPendingCopies(env: Env, storage: DurableObjectStorage): Promise<void> {
  if (!/^\d{17,20}$/.test(env.GCA_COPY_USER_ID ?? '') ||
      (await storage.get<number>(BACKOFF_KEY) ?? 0) > Date.now()) return;
  const sql = storage.sql;
  const deadline = Date.now() + 25_000;
  const pending = sql.exec<CopyRow>(`SELECT * FROM gca_copies
    WHERE status = 'pending' AND recipient_id = ? AND retry_at <= ? AND attempts < ?
    ORDER BY rowid LIMIT ?`, env.GCA_COPY_USER_ID, Date.now(), MAX_ATTEMPTS, MAX_SENDS_PER_POLL).toArray();
  for (const row of pending) {
    if (Date.now() >= deadline) break;
    let messageAttempted = false;
    try {
      const payload: unknown = JSON.parse(row.payload);
      const channelId = await openDm(env.DISCORD_BOT_TOKEN, row.recipient_id);
      if (Date.now() >= deadline) break;
      sql.exec("UPDATE gca_copies SET status = 'reserved', attempts = attempts + 1 WHERE session_key = ?", row.session_key);
      await storage.sync();
      messageAttempted = true;
      const message = await discordJson(env.DISCORD_BOT_TOKEN, `/channels/${channelId}/messages`, payload) as { id?: string } | null;
      if (!message?.id) throw new Error('Discord message response missing id');
      sql.exec("UPDATE gca_copies SET status = 'sent', payload = '' WHERE session_key = ?", row.session_key);
      console.log(JSON.stringify({ event: 'gca_copy_sent', sessionKey: row.session_key }));
    } catch (err) {
      const rateLimited = err instanceof GcaDiscordError && err.status === 429;
      const permanent = err instanceof GcaDiscordError && err.status >= 400 && err.status < 500 && !rateLimited;
      const retry = !permanent && (!messageAttempted || rateLimited) && row.attempts + 1 < MAX_ATTEMPTS;
      const delay = err instanceof GcaDiscordError ? err.retryMs : 60_000;
      sql.exec('UPDATE gca_copies SET status = ?, attempts = ?, retry_at = ?, payload = ? WHERE session_key = ?',
        retry ? 'pending' : 'failed', row.attempts + 1, Date.now() + delay, retry ? row.payload : '', row.session_key);
      console.warn(JSON.stringify({ event: 'gca_copy_failed', sessionKey: row.session_key,
        status: err instanceof GcaDiscordError ? err.status : 'unavailable', retry }));
      if (rateLimited) {
        await storage.put(BACKOFF_KEY, Date.now() + delay);
        break;
      }
    }
  }
}

/** Serialized by the coordinator; copy failures never retry the member's DM. */
export async function sendGcaReminders(
  env: Env, current: OnlineAtc[], storage: DurableObjectStorage, now: number,
): Promise<void> {
  if (env.GCA_DM_ENABLED !== 'true') return;
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS gca_copies (
    session_key TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
  )`);
  try {
    await sendMemberReminders(env, current, storage, now);
  } finally {
    await sendPendingCopies(env, storage).catch(() => {
      console.warn(JSON.stringify({ event: 'gca_copy_poll_failed' }));
    });
  }
}
