import { EMBED_FOOTER, firOf, type FirLabel } from './config';
import { escapeMarkdown, isSnowflake, type DiscordEmbed } from './discord';
import { DiscordRateLimitError, DiscordRateLimits, type DiscordRateLimitReason } from './discord-rate-limit';
import { ResponseTooLargeError } from './http';
import { hasFrequency } from './ivao';
import { countryCode } from './member-country';
import type { OnlineAtc } from './types';

type Region = string;
const LEVELS: Record<string, number> = { DEL: 1, GND: 1, TWR: 1, APP: 2, DEP: 2, CTR: 3 };
const MAX_LEVEL = 3;
// Leave room for the reminder text within Discord's 4096-character description.
const MAX_POLICY_URL_LENGTH = 2048;
const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
const INITIALIZED_KEY = 'gca-initialized-v1'; // gitleaks:allow — storage key name, not a credential
const BACKOFF_KEY = 'gca-discord-backoff-v1';
// Gates only the member-list fetch, separately from the shared BACKOFF_KEY:
// a member-list-specific failure (a route 429, a malformed page) must not
// also block unrelated staff-copy sends, which only check BACKOFF_KEY.
const MEMBER_LIST_BACKOFF_KEY = 'gca-member-list-backoff-v1';
/** Consecutive member-list lookups that ran out of the poll deadline. */
const MEMBER_LIST_DEADLINE_KEY = 'gca-member-list-deadline-failures-v1';
/** A slow lookup is retried at once, but backs off from this many in a row. */
const MEMBER_LIST_DEADLINE_LIMIT = 2;
/** Backoff for a member-list failure that carries no Discord-reported delay. */
const MEMBER_LIST_FALLBACK_BACKOFF_MS = 5 * 60_000;
const LAST_ACTIVE_KEY = 'gca-last-active-v1';
const RETENTION_MS = 7 * 86_400_000;
const MAX_SENDS_PER_POLL = 3;
const MAX_ATTEMPTS = 5;
const OCCURRENCE_MIGRATION = 'gca-occurrences-migrated-v1';
// A gap since the last poll that actually ran reminders (valid configuration,
// tables ready) wider than this, or no record of one at all (an upgrade from a
// version without it), is treated as an outage or a disable/re-enable, not an
// ordinary retry-backoff delay (which can legitimately run into several
// minutes): brand-new sessions discovered on that first poll back are
// baselined rather than immediately warned, the same as on first-ever startup,
// so connections online throughout are not flooded with a first-ever DM. An
// existing session already due a retry is still sent.
const REBASELINE_GAP_MS = 15 * 60_000;
/**
 * No Discord-reported delay, however large, may pause reminders or staff
 * copies longer than this (the same one-hour cap as public rate limits); a
 * stored backoff further out can only be corrupt or pre-cap, and is ignored.
 */
const GCA_MAX_BACKOFF_MS = 60 * 60_000;

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
  /** Staff-assigned role a member must also hold before their nickname VID is trusted. */
  verifiedRoleId?: string;
}

/**
 * A minimal recursive-descent JSON parser used only to reject duplicate object
 * keys, which `JSON.parse` silently collapses to the last value. Private
 * policy JSON with a repeated key (e.g. two `"AA"` regions, or the same VID
 * twice in an approvals object) must disable reminders rather than silently
 * keep only one of the two entries — an approved controller could otherwise
 * be DMed, or an unapproved one could be missed.
 */
function parseJsonRejectDuplicateKeys(text: string): unknown {
  let i = 0;
  const len = text.length;
  const fail = (): never => { throw new SyntaxError('invalid or duplicate-key JSON'); };
  const skipWs = () => { while (i < len && /[ \t\n\r]/.test(text[i]!)) i++; };
  function parseValue(): unknown {
    skipWs();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    return parseNumber();
  }
  function parseObject(): Record<string, unknown> {
    i++;
    const obj: Record<string, unknown> = {};
    skipWs();
    if (text[i] === '}') { i++; return obj; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') fail();
      const key = parseString();
      skipWs();
      if (text[i] !== ':') fail();
      i++;
      const value = parseValue();
      if (Object.hasOwn(obj, key)) fail();
      // A plain `obj[key] = value` would invoke Object.prototype's `__proto__`
      // setter instead of creating an own property, unlike JSON.parse.
      Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      fail();
    }
    return obj;
  }
  function parseArray(): unknown[] {
    i++;
    const arr: unknown[] = [];
    skipWs();
    if (text[i] === ']') { i++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      fail();
    }
    return arr;
  }
  function parseString(): string {
    const start = i;
    i++;
    while (i < len) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { i++; return JSON.parse(text.slice(start, i)) as string; }
      i++;
    }
    return fail();
  }
  function parseNumber(): number {
    const start = i;
    while (i < len && /[-+0-9.eE]/.test(text[i]!)) i++;
    if (start === i) fail();
    return JSON.parse(text.slice(start, i)) as number;
  }
  const value = parseValue();
  skipWs();
  if (i !== len) fail();
  return value;
}

// `String.prototype.trim()` strips a much wider Unicode whitespace set (NBSP,
// BOM, U+2028, etc.) than JSON's own whitespace grammar (space, tab, LF, CR).
// Trimming with it would let policy text bracketed by those characters look
// valid when strict JSON would reject it as leading/trailing garbage.
function trimJsonWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && /[ \t\n\r]/.test(text[start]!)) start++;
  while (end > start && /[ \t\n\r]/.test(text[end - 1]!)) end--;
  return text.slice(start, end);
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  const text = raw === undefined ? undefined : trimJsonWhitespace(raw);
  if (!text) return null;
  try {
    const parsed = parseJsonRejectDuplicateKeys(text);
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
  if (raw === undefined || !trimJsonWhitespace(raw)) return {};
  const object = parseJsonObject(raw);
  if (!object) return null;
  const result: Record<number, string> = {};
  for (const [key, value] of Object.entries(object)) {
    if (!isVid(key) || typeof value !== 'string' || countryCode(value) !== value) return null;
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
 * Build the policy from the environment, or null when coverage, approvals or
 * home overrides are missing or malformed (including duplicate object keys,
 * which would otherwise silently keep only the last value).
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
  // A link or verified role that is set but unusable disables reminders: the
  // operator configured it, so sending without it would not be what they asked.
  const policyUrl = parsePolicyUrl(env.GCA_POLICY_URL);
  if (env.GCA_POLICY_URL?.trim() && !policyUrl) {
    console.error(JSON.stringify({ event: 'gca_config_invalid', reason: 'policy_url' }));
    return null;
  }
  const verifiedRoleId = env.GCA_VERIFIED_ROLE_ID?.trim();
  if (verifiedRoleId && !isSnowflake(verifiedRoleId)) {
    console.error(JSON.stringify({ event: 'gca_config_invalid', reason: 'verified_role' }));
    return null;
  }
  return { ...regions, approvals, homeOverrides, policyUrl, ...(verifiedRoleId ? { verifiedRoleId } : {}) };
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
  const home = countryCode(policy.homeOverrides[atc.userId] ?? atc.memberCountry?.countryId);
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
  const station = escapeMarkdown(Array.from(atc.station ?? '').slice(0, 100).join(''));
  const callsign = escapeMarkdown(atc.callsign);
  const label = `${callsign}${station ? ` — ${station}` : ''}, ${regionName}`;
  const lastTwo = occurrence % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[occurrence % 10] ?? 'th');
  const occurrenceLabel = occurrence > 1 ? `[${occurrence}${suffix} occurrence] ` : '';
  return {
    title: `⚠️ ${occurrenceLabel}${firOf(atc.callsign, labels).flag} ${callsign} — GCA approval reminder`,
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

/**
 * Without a verified role, every account counts in ambiguity detection before
 * the member role is checked. Nicknames are self-editable: with a verified
 * role configured, only members staff gave both roles are trusted with the
 * VID in their nickname, and only they count, so an unverified account
 * copying a verified member's VID cannot block that member's reminders.
 */
export function indexMemberVids(members: GuildMember[], roleId: string, verifiedRoleId?: string): Map<number, string> {
  const matches = new Map<number, GuildMember[]>();
  for (const member of members) {
    if (verifiedRoleId && !(member.roles.includes(roleId) && member.roles.includes(verifiedRoleId))) continue;
    const numbers = member.nick?.match(/\d+/g) ?? [];
    for (const vid of new Set(numbers.filter(isVid).map(Number))) {
      const list = matches.get(vid) ?? [];
      list.push(member);
      matches.set(vid, list);
    }
  }
  const result = new Map<number, string>();
  for (const [vid, list] of matches) {
    const member = list[0]!;
    if (list.length === 1 && !member.user.bot && member.roles.includes(roleId) &&
        (!verifiedRoleId || member.roles.includes(verifiedRoleId)) &&
        (member.nick?.match(/\d+/g) ?? []).length === 1) result.set(vid, member.user.id);
  }
  return result;
}


/** A deterministic failure: retrying would only repeat the exact same outcome. */
class PermanentGcaError extends Error {}

class GcaDiscordError extends Error {
  constructor(readonly status: number, readonly retryMs: number) {
    super(`Discord status ${status}`); // Never include response bodies or credentials in logs.
  }
}

/** Running out of the poll deadline, not a Discord failure: backs off only when repeated. */
class GcaDeadlineError extends Error {}

/** A member list Discord returned successfully but that cannot be used. */
class GcaMemberListError extends Error {
  constructor(readonly reason: 'page_limit' | 'invalid', message: string) {
    super(message);
  }
}

/** No inline retries: a slow Discord service must not hold the poll indefinitely. */
async function discordJson(limits: DiscordRateLimits, token: string, path: string, payload?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await limits.fetch(path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch (err) {
    if (!(err instanceof ResponseTooLargeError)) throw err;
    // Discord answered with a body over the cap: a 2xx is still a success
    // (the DM was delivered) with no usable body; any other status is that
    // HTTP failure, classified like any other.
    if (err.status >= 200 && err.status < 300) return null;
    throw new GcaDiscordError(err.status, 60_000);
  }
  if (!response.ok) {
    const seconds = Number(response.headers.get('retry-after'));
    throw new GcaDiscordError(response.status,
      Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, GCA_MAX_BACKOFF_MS) : 60_000);
  }
  // A 2xx response with an empty or non-JSON body (e.g. a 204-style empty
  // reply) is still a success: treat it as "no body" rather than a failure,
  // so callers still record sent/sent_unconfirmed instead of a retry.
  return response.json().catch(() => null);
}

async function openDm(limits: DiscordRateLimits, token: string, recipient: string): Promise<string> {
  const channel = await discordJson(limits, token, '/users/@me/channels', { recipient_id: recipient }) as {
    id?: string; type?: number; recipients?: { id: string }[];
  } | null;
  if (!channel) {
    // A 2xx with no parseable body is not proof of the wrong recipient: it may
    // just be a transient malformed reply, so it must stay retryable rather
    // than permanently drop the reminder.
    throw new Error('Unparseable DM channel response');
  }
  if (!isSnowflake(channel.id) ||
      channel.type !== 1 || !Array.isArray(channel.recipients) ||
      channel.recipients.length !== 1 || channel.recipients[0]?.id !== recipient) {
    // Deterministic for this VID/channel: retrying wastes a round trip every poll.
    throw new PermanentGcaError('Unexpected DM recipient');
  }
  return channel.id;
}

function isMember(value: unknown): value is GuildMember {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<GuildMember>;
  return !!m.user && isSnowflake(m.user.id) &&
    (m.user.bot === undefined || typeof m.user.bot === 'boolean') &&
    (m.nick === undefined || m.nick === null || typeof m.nick === 'string') &&
    Array.isArray(m.roles) && m.roles.every((role) => typeof role === 'string');
}

async function fetchMembers(limits: DiscordRateLimits, token: string, guildId: string, deadline: number): Promise<GuildMember[]> {
  const members: GuildMember[] = [];
  let after = '0';
  // Never use a partial list: a duplicate VID could occur on a later page.
  for (let page = 0; page < 10; page++) {
    if (Date.now() >= deadline) throw new GcaDeadlineError('Discord member lookup exceeded poll budget');
    const body = await discordJson(limits, token, `/guilds/${guildId}/members?limit=1000&after=${after}`);
    if (!Array.isArray(body) || !body.every(isMember)) throw new GcaMemberListError('invalid', 'Invalid Discord member list');
    members.push(...body);
    if (body.length < 1000) return members;
    const last = body.at(-1)!.user.id;
    if (BigInt(last) <= BigInt(after)) throw new GcaMemberListError('invalid', 'Discord member pagination did not advance');
    after = last;
  }
  // Up to 10,000 members; a larger server can never get a complete list.
  throw new GcaMemberListError('page_limit', 'Discord member list exceeded page limit');
}

/** A stored backoff deadline, or 0 when absent, invalid, or beyond the cap. */
async function readBackoff(storage: DurableObjectStorage, key: string, now: number): Promise<number> {
  const until = await storage.get<number>(key);
  return typeof until === 'number' && Number.isFinite(until) && until <= now + GCA_MAX_BACKOFF_MS ? until : 0;
}

type ReminderRow = { status: string; attempts: number; retry_at: number };

interface DeliveryOutcome {
  status: 'pending' | 'failed';
  attempts: number;
  retryAt: number;
  rateLimited: boolean;
  statusCode: number | 'unavailable';
}

/**
 * Shared at-most-once retry classification for both member DMs and staff
 * copies, so the two paths can never drift apart on what counts as retryable.
 */
function classifyDeliveryFailure(err: unknown, attempts: number, messageAttempted: boolean, now: number): DeliveryOutcome {
  const rateLimited = err instanceof DiscordRateLimitError;
  const permanent = err instanceof PermanentGcaError ||
    (err instanceof GcaDiscordError && err.status >= 400 && err.status < 500 && !rateLimited);
  // 429 is an explicit rejection, safe to retry after its requested delay.
  // Timeouts/5xx after the message POST may have delivered: do not retry those.
  const used = attempts + (rateLimited && !err.requestMade ? 0 : 1);
  const retry = !permanent && (!messageAttempted || rateLimited) && used < MAX_ATTEMPTS;
  const delay = Math.min(err instanceof GcaDiscordError || rateLimited ? err.retryMs : 60_000, GCA_MAX_BACKOFF_MS);
  return {
    status: retry ? 'pending' : 'failed',
    attempts: used,
    retryAt: now + delay,
    rateLimited,
    statusCode: err instanceof GcaDiscordError || rateLimited ? (err as GcaDiscordError | DiscordRateLimitError).status : 'unavailable',
  };
}

/**
 * A rate-limit error always reports status 429, even when this poll deferred
 * the request locally without contacting Discord: log what actually happened.
 */
function rateLimitDetail(err: unknown): { reason?: DiscordRateLimitReason; requestMade?: boolean } {
  return err instanceof DiscordRateLimitError ? { reason: err.reason, requestMade: err.requestMade } : {};
}

/** Same schema, created idempotently from whichever path (reminders or copies) runs first. */
function ensureGcaSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS gca_reminders (
    session_key TEXT PRIMARY KEY, status TEXT NOT NULL, last_seen INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS gca_reminders_last_seen_idx ON gca_reminders (last_seen)');
  sql.exec(`CREATE TABLE IF NOT EXISTS gca_occurrences (
    session_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, occurrence INTEGER NOT NULL,
    UNIQUE(user_id, occurrence)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS gca_copies (
    session_key TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS gca_copies_pending_idx ON gca_copies (status, retry_at)');
}

/** One-time migration from before per-VID occurrence counters existed. */
async function migrateLegacyOccurrences(storage: DurableObjectStorage, sql: SqlStorage): Promise<void> {
  if (await storage.get<boolean>(OCCURRENCE_MIGRATION)) return;
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

type Candidate = { atc: OnlineAtc; key: string; mismatch: GcaMismatch };

/**
 * Insert/refresh every current session, then return candidates due a reminder
 * right now, deduplicated by session key using the row just written (never a
 * second, stale copy of the same key). Also prunes long-settled rows.
 */
function updateSessionsAndCollectCandidates(
  storage: DurableObjectStorage, current: OnlineAtc[], policy: GcaPolicy, baselineNow: boolean, now: number,
): Map<string, Candidate> {
  const sql = storage.sql;
  const candidates = new Map<string, Candidate>();
  for (const atc of current) {
    if (!Number.isSafeInteger(atc.userId) || atc.userId <= 0 ||
        !Number.isSafeInteger(atc.sessionId) || atc.sessionId <= 0 ||
        // Accepts every feed callsign shape (hyphens, two characters) that can
        // show the public marker. The callsign is never part of the key.
        !/^[A-Z0-9_-]{2,40}$/.test(atc.callsign.toUpperCase())) continue;
    const key = `${atc.userId}:${atc.sessionId}`;
    const row = sql.exec<ReminderRow>(`INSERT INTO gca_reminders (session_key, status, last_seen) VALUES (?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET last_seen = excluded.last_seen
      RETURNING status, attempts, retry_at`, key, baselineNow ? 'baseline' : 'pending', now).one();
    const mismatch = gcaMismatch(atc, policy);
    if (row.status === 'pending' && row.retry_at <= now && row.attempts < MAX_ATTEMPTS && mismatch) {
      candidates.set(key, { atc, key, mismatch });
    }
  }
  // Keep every possible delivery permanently: even a very old connection ID
  // reappearing after a feed outage must not receive another notification.
  // A pruned row was never delivered. A deferred DM no longer keeps an
  // occurrence, but a pending or unmapped row left by an earlier version may:
  // it goes with the row, so a later warning is not numbered past it.
  // Occurrences of sent, reserved or failed reminders are never touched.
  const stale = "last_seen < ? AND status NOT IN ('sent', 'reserved', 'failed')";
  storage.transactionSync(() => {
    sql.exec(`DELETE FROM gca_occurrences WHERE session_key IN (SELECT session_key FROM gca_reminders WHERE ${stale})`,
      now - RETENTION_MS);
    sql.exec(`DELETE FROM gca_reminders WHERE ${stale}`, now - RETENTION_MS);
  });
  return candidates;
}

function validGuildAndRole(env: Env): boolean {
  return isSnowflake(env.GCA_DISCORD_GUILD_ID) && isSnowflake(env.GCA_MEMBER_ROLE_ID);
}

/**
 * Reminders are switched on and their guild/member-role IDs are usable. With
 * a valid policy (checked separately), member reminders can actually run.
 */
export function gcaRemindersEnabled(env: Env): boolean {
  return env.GCA_DM_ENABLED === 'true' && validGuildAndRole(env);
}

/**
 * The complete guild member list, or null while reminders or the member-list
 * lookup are backed off. A failed lookup records its own backoff and rethrows.
 */
async function fetchMembersWithBackoff(
  env: Env, storage: DurableObjectStorage, limits: DiscordRateLimits, now: number, deadline: number,
): Promise<GuildMember[] | null> {
  const globalBackoff = await readBackoff(storage, BACKOFF_KEY, now);
  const memberListBackoff = await readBackoff(storage, MEMBER_LIST_BACKOFF_KEY, now);
  if (Math.max(globalBackoff, memberListBackoff) > now) return null;
  const guildId = env.GCA_DISCORD_GUILD_ID ?? '';
  const members = await fetchMembers(limits, env.DISCORD_BOT_TOKEN, guildId, deadline).catch(async (err: unknown) => {
    const httpError = err instanceof GcaDiscordError || err instanceof DiscordRateLimitError;
    const reason = err instanceof GcaDeadlineError ? 'deadline' : err instanceof GcaMemberListError ? err.reason : 'http';
    console.warn(JSON.stringify({ event: 'gca_member_list_failed', reason, status: httpError ? err.status : 'unavailable' }));
    if (err instanceof GcaDeadlineError) {
      // Running out of the poll deadline is not a Discord failure: a one-off
      // slow lookup is simply retried next poll. Only a lookup that keeps
      // running out backs off, so it cannot use up every poll's budget.
      const failures = (await storage.get<number>(MEMBER_LIST_DEADLINE_KEY) ?? 0) + 1;
      await storage.put(MEMBER_LIST_DEADLINE_KEY, failures);
      if (failures >= MEMBER_LIST_DEADLINE_LIMIT) {
        await storage.put(MEMBER_LIST_BACKOFF_KEY, Date.now() + MEMBER_LIST_FALLBACK_BACKOFF_MS);
      }
      throw err;
    }
    await storage.delete(MEMBER_LIST_DEADLINE_KEY);
    // Any other member-list failure — HTTP or a malformed/incomplete page —
    // must back off, but only the member-list lookup itself; otherwise the
    // same lookup is retried on every poll indefinitely instead of roughly
    // every few minutes. Only a genuinely global rate limit also widens the
    // shared BACKOFF_KEY that gates unrelated staff copies.
    const retryMs = Math.min(httpError ? err.retryMs : MEMBER_LIST_FALLBACK_BACKOFF_MS, GCA_MAX_BACKOFF_MS);
    await storage.put(MEMBER_LIST_BACKOFF_KEY, Date.now() + retryMs);
    if (err instanceof DiscordRateLimitError && err.global) {
      await storage.put(BACKOFF_KEY, Date.now() + retryMs);
    }
    throw err;
  });
  if (await storage.get<number>(MEMBER_LIST_DEADLINE_KEY) !== undefined) await storage.delete(MEMBER_LIST_DEADLINE_KEY);
  return members;
}

/**
 * Persist the reservation BEFORE the message POST. An ambiguous timeout or
 * crash must never generate repeated warning DMs on a later poll/redeployment.
 * The durable ordinal (one per VID/connection, shared across all target
 * regions) is assigned in the same step, so only a connection whose DM is
 * actually attempted counts; reconnecting the Worker never increments it.
 */
async function reserveOccurrence(storage: DurableObjectStorage, key: string, userId: number): Promise<number> {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec(`INSERT OR IGNORE INTO gca_occurrences (session_key, user_id, occurrence)
      SELECT ?, ?, COALESCE(MAX(occurrence), 0) + 1 FROM gca_occurrences WHERE user_id = ?`,
    key, userId, userId);
    sql.exec("UPDATE gca_reminders SET status = 'reserved', attempts = attempts + 1 WHERE session_key = ?", key);
  });
  const { occurrence } = sql.exec<{ occurrence: number }>(
    'SELECT occurrence FROM gca_occurrences WHERE session_key = ?', key).one();
  await storage.sync();
  return occurrence;
}

/**
 * The message POST returned 2xx: the DM was delivered even if the response
 * body is unusable. Recording that as a retryable/failed delivery would both
 * re-warn the member and skip their staff copy.
 */
function recordSent(
  env: Env, storage: DurableObjectStorage, key: string, recipient: string, userId: number, payload: Record<string, unknown>,
): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec("UPDATE gca_reminders SET status = 'sent' WHERE session_key = ?", key);
    if (isSnowflake(env.GCA_COPY_USER_ID) && env.GCA_COPY_USER_ID !== recipient) {
      // Save the exact sent embed: later retries must not rebuild it from a new feed/profile.
      sql.exec(`INSERT OR IGNORE INTO gca_copies (session_key, recipient_id, payload, status)
        VALUES (?, ?, ?, 'pending')`, key, env.GCA_COPY_USER_ID,
      JSON.stringify({ ...payload, content: `Copy of reminder sent to <@${recipient}> · VID ${userId}` }));
    }
  });
}

/**
 * Record a failed member DM attempt. Returns true when it was rate-limited,
 * so no further reminders are attempted this poll.
 *
 * An occurrence exists only while a DM is reserved or once it was possibly
 * delivered: its message POST was made and not explicitly rejected (a timeout
 * or 5xx may have delivered it). A 4xx, a 429 (always a DiscordRateLimitError,
 * never a GcaDiscordError), a local deferral, or a failure before the POST
 * definitely did not: the occurrence is released, whether the row is retried
 * or not, so the member's next received warning is numbered by what they
 * actually got. Only this connection's occurrence is removed; the reminder
 * row keeps deduplicating it.
 */
async function recordDeliveryFailure(
  storage: DurableObjectStorage, key: string, err: unknown, attempts: number, messageAttempted: boolean,
): Promise<boolean> {
  const sql = storage.sql;
  const outcome = classifyDeliveryFailure(err, attempts, messageAttempted, Date.now());
  const possiblyDelivered = messageAttempted && !(err instanceof DiscordRateLimitError) &&
    !(err instanceof GcaDiscordError && err.status >= 400 && err.status < 500);
  storage.transactionSync(() => {
    sql.exec('UPDATE gca_reminders SET status = ?, attempts = ?, retry_at = ? WHERE session_key = ?',
      outcome.status, outcome.attempts, outcome.retryAt, key);
    if (!possiblyDelivered) sql.exec('DELETE FROM gca_occurrences WHERE session_key = ?', key);
  });
  console.warn(JSON.stringify({
    event: 'gca_dm_failed', status: outcome.statusCode, retry: outcome.status === 'pending', ...rateLimitDetail(err),
  }));
  // Only a genuinely global limit should widen the shared backoff: one
  // recipient's DM-channel cooldown must not block unrelated members'
  // reminders.
  if (outcome.rateLimited && (err as DiscordRateLimitError).global) {
    await storage.put(BACKOFF_KEY, outcome.retryAt);
  }
  return outcome.rateLimited;
}

/** Called inside the coordinator's serialized poll, before channel notifications. */
async function sendMemberReminders(
  env: Env, current: OnlineAtc[], storage: DurableObjectStorage, now: number, limits: DiscordRateLimits,
  policy: GcaPolicy | null, labels: FirLabel[], deadline: number,
): Promise<void> {
  // Missing or unusable configuration disables reminders for this poll; it
  // must never throw, or one bad setting would stop the online cards too.
  if (!validGuildAndRole(env)) {
    console.error(JSON.stringify({ event: 'gca_config_invalid', reason: 'guild_or_role' }));
    return;
  }
  if (!policy) {
    console.error(JSON.stringify({ event: 'gca_config_invalid', reason: 'policy' }));
    return;
  }
  const sql = storage.sql;
  ensureGcaSchema(sql);
  await migrateLegacyOccurrences(storage, sql);
  // See REBASELINE_GAP_MS.
  const initialized = await storage.get<boolean>(INITIALIZED_KEY);
  const lastActive = await storage.get<number>(LAST_ACTIVE_KEY);
  const stale = !!initialized && (lastActive === undefined || now - lastActive > REBASELINE_GAP_MS);
  await storage.put(LAST_ACTIVE_KEY, now);
  const candidates = updateSessionsAndCollectCandidates(storage, current, policy, !initialized || stale, now);
  if (!initialized) {
    await storage.put(INITIALIZED_KEY, true);
    console.log(JSON.stringify({ event: 'gca_baseline_seeded', sessions: current.length }));
    return;
  }
  if (stale) console.log(JSON.stringify({ event: 'gca_rebaselined', sessions: current.length }));
  if (!candidates.size) return;
  const members = await fetchMembersWithBackoff(env, storage, limits, now, deadline);
  if (!members) return;
  const index = indexMemberVids(members, env.GCA_MEMBER_ROLE_ID ?? '', policy.verifiedRoleId);
  let attemptsThisPoll = 0;
  for (const { atc, key, mismatch } of candidates.values()) {
    if (attemptsThisPoll >= MAX_SENDS_PER_POLL || Date.now() >= deadline) break;
    // Re-check the fresh row: a duplicated upstream session, or a candidate
    // already retried earlier this same poll, must not send twice, and any
    // retry_at/attempts set by that earlier attempt must not be ignored.
    const fresh = sql.exec<ReminderRow>('SELECT status, attempts, retry_at FROM gca_reminders WHERE session_key = ?', key).one();
    if (fresh.status !== 'pending' || fresh.retry_at > Date.now() || fresh.attempts >= MAX_ATTEMPTS) continue;
    const recipient = index.get(atc.userId);
    if (!recipient) {
      // Still 'pending' here, so nothing was possibly delivered. Only a row
      // left by an earlier version can still hold an occurrence.
      storage.transactionSync(() => {
        sql.exec("UPDATE gca_reminders SET status = 'unmapped' WHERE session_key = ?", key);
        sql.exec('DELETE FROM gca_occurrences WHERE session_key = ?', key);
      });
      console.log(JSON.stringify({ event: 'gca_skipped_unmapped' }));
      continue;
    }
    attemptsThisPoll++;
    let messageAttempted = false;
    try {
      const channelId = await openDm(limits, env.DISCORD_BOT_TOKEN, recipient);
      if (Date.now() >= deadline) break;
      const occurrence = await reserveOccurrence(storage, key, atc.userId);
      messageAttempted = true;
      const payload = { embeds: [buildGcaEmbed(atc, mismatch, occurrence, policy.policyUrl, labels)], allowed_mentions: { parse: [] } };
      const message = await discordJson(limits, env.DISCORD_BOT_TOKEN, `/channels/${channelId}/messages`, payload) as { id?: string } | null;
      recordSent(env, storage, key, recipient, atc.userId, payload);
      console.log(JSON.stringify({ event: message?.id ? 'gca_dm_sent' : 'gca_dm_sent_unconfirmed' }));
    } catch (err) {
      if (await recordDeliveryFailure(storage, key, err, fresh.attempts, messageAttempted)) break;
    }
  }
}

type CopyRow = ReminderRow & { session_key: string; recipient_id: string; payload: string };

async function sendPendingCopies(env: Env, storage: DurableObjectStorage, limits: DiscordRateLimits, deadline: number): Promise<void> {
  if (!isSnowflake(env.GCA_COPY_USER_ID) ||
      await readBackoff(storage, BACKOFF_KEY, Date.now()) > Date.now()) return;
  const sql = storage.sql;
  ensureGcaSchema(sql);
  const pending = sql.exec<CopyRow>(`SELECT * FROM gca_copies
    WHERE status = 'pending' AND recipient_id = ? AND retry_at <= ? AND attempts < ?
    ORDER BY rowid LIMIT ?`, env.GCA_COPY_USER_ID, Date.now(), MAX_ATTEMPTS, MAX_SENDS_PER_POLL).toArray();
  for (const row of pending) {
    if (Date.now() >= deadline) break;
    let messageAttempted = false;
    try {
      const payload: unknown = JSON.parse(row.payload);
      const channelId = await openDm(limits, env.DISCORD_BOT_TOKEN, row.recipient_id);
      if (Date.now() >= deadline) break;
      sql.exec("UPDATE gca_copies SET status = 'reserved', attempts = attempts + 1 WHERE session_key = ?", row.session_key);
      await storage.sync();
      messageAttempted = true;
      const message = await discordJson(limits, env.DISCORD_BOT_TOKEN, `/channels/${channelId}/messages`, payload) as { id?: string } | null;
      // A 2xx POST delivered the copy even if the response body is unusable.
      sql.exec("UPDATE gca_copies SET status = 'sent', payload = '' WHERE session_key = ?", row.session_key);
      console.log(JSON.stringify({ event: message?.id ? 'gca_copy_sent' : 'gca_copy_sent_unconfirmed' }));
    } catch (err) {
      const outcome = classifyDeliveryFailure(err, row.attempts, messageAttempted, Date.now());
      sql.exec('UPDATE gca_copies SET status = ?, attempts = ?, retry_at = ?, payload = ? WHERE session_key = ?',
        outcome.status, outcome.attempts, outcome.retryAt, outcome.status === 'pending' ? row.payload : '', row.session_key);
      console.warn(JSON.stringify({
        event: 'gca_copy_failed', status: outcome.statusCode, retry: outcome.status === 'pending', ...rateLimitDetail(err),
      }));
      if (outcome.rateLimited) {
        if ((err as DiscordRateLimitError).global) {
          await storage.put(BACKOFF_KEY, outcome.retryAt);
        }
        break;
      }
    }
  }
}

/** Serialized by the coordinator; copy failures never retry the member's DM. */
export async function sendGcaReminders(
  env: Env, current: OnlineAtc[], storage: DurableObjectStorage, now: number,
  policy: GcaPolicy | null, labels: FirLabel[] = [], rateLimits?: DiscordRateLimits,
): Promise<void> {
  if (env.GCA_DM_ENABLED !== 'true') return;
  const limits = rateLimits ?? await DiscordRateLimits.load(storage);
  // Single shared deadline across both member reminders and staff copies:
  // two independent 25s budgets could together delay the public online/
  // offline cards that run after this by up to 50s.
  const deadline = Date.now() + 25_000;
  try {
    await sendMemberReminders(env, current, storage, now, limits, policy, labels, deadline);
  } finally {
    await sendPendingCopies(env, storage, limits, deadline).catch(() => {
      console.warn(JSON.stringify({ event: 'gca_copy_poll_failed' }));
    });
  }
}
