import {
  IVAO_ATC_SUMMARY_URL,
  IVAO_SCOPE,
  IVAO_TOKEN_URL,
  TOKEN_KEY,
} from './config';
import type { CachedToken, IvaoAuth, IvaoAtcSummaryEntry, OnlineAtc } from './types';
import { fetchBuffered } from './http';

/** Require explicit coverage; never infer an operator's monitored airspace. */
export function parsePrefixes(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  if (!list.length || list.some((prefix) => !/^[A-Z]{1,4}$/.test(prefix))) {
    throw new Error('FIR_PREFIXES requires comma-separated ICAO prefixes');
  }
  return [...new Set(list)];
}

/** Parse the EXCLUDED_CALLSIGNS var into an uppercase exact-match set. */
export function parseExcludedCallsigns(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * Callsigns with a bare `X` middle segment (`XAAA_X_APP`, `XBBB_X_TWR`,
 * `XCCC_X_CTR`) are special-purpose positions, not real ATC service, so they
 * are excluded from notifications regardless of EXCLUDED_CALLSIGNS.
 */
const SPECIAL_POSITION_PATTERN = /_X_/;

/**
 * True when a callsign must never trigger online/offline notifications:
 * either listed in EXCLUDED_CALLSIGNS or a `xxxx_X_yyy` special position.
 */
export function isExcludedCallsign(callsign: string, excluded: Set<string>): boolean {
  const cs = callsign.toUpperCase();
  return excluded.has(cs) || SPECIAL_POSITION_PATTERN.test(cs);
}

/** True when a callsign belongs to one of the monitored FIRs. */
export function isDivisionCallsign(callsign: string, prefixes: string[]): boolean {
  const cs = callsign.toUpperCase();
  return prefixes.some((p) => cs.startsWith(p));
}

/**
 * True when the feed has published a real frequency.
 *
 * IVAO reports `0` for a controller that has connected but not tuned a
 * frequency yet; the real value lands a poll or two later. Such a position
 * is genuinely connected, it is just not ready to be announced.
 */
export function hasFrequency(atc: Pick<OnlineAtc, 'frequency'>): boolean {
  return Number.isFinite(atc.frequency) && atc.frequency > 0;
}

export function normalizeAtc(entry: IvaoAtcSummaryEntry): OnlineAtc {
  const airport = entry.atcPosition?.airport;
  return {
    sessionId: entry.id,
    userId: entry.userId,
    callsign: entry.callsign,
    frequency: entry.atcSession.frequency,
    position: entry.atcSession.position,
    // `||`, not `??`: an empty station name falls through to the next source.
    station: entry.atcPosition?.atcCallsign || entry.subcenter?.atcCallsign || null,
    location: entry.atcPosition?.airport?.name ?? null,
    airport: airport?.icao ? {
      icao: airport.icao.trim().toUpperCase(),
      countryId: airport.countryId?.trim().toUpperCase() || null,
    } : null,
  };
}

// --- Feed entry sanitation ---------------------------------------------------

/** Bound every string the feed contributes to embeds/roster output. */
const MAX_CALLSIGN_LENGTH = 32;
const MAX_TEXT_LENGTH = 128;
const MAX_ICAO_LENGTH = 8;
/** An airport ICAO/IATA-style code; anything else drops the airport, not the entry. */
const AIRPORT_ICAO_PATTERN = /^[A-Z0-9]{3,4}$/;
/**
 * Callsigns are plain identifiers; anything else is rejected, not rewritten.
 * A leading `__` is rejected too, so a callsign can never be `__proto__` or
 * a similar special key in the callsign-keyed session map.
 */
const CALLSIGN_PATTERN = /^(?!__)[A-Za-z0-9_-]{2,32}$/;
/** A decimal MHz value such as `118.1`, `121.500` or `0.000`; no hex, exponent or sign. */
const FREQUENCY_STRING_PATTERN = /^\d{1,3}(\.\d{1,3})?$/;
/** Frequencies at or above this many MHz are implausible and read as untuned. */
const MAX_FREQUENCY_MHZ = 1000;
/**
 * The smallest tuned frequency: one kHz, the resolution the string form
 * allows. A smaller positive number would render as 0.000 MHz, so it reads as
 * untuned instead.
 */
const MIN_FREQUENCY_MHZ = 0.001;
/** The whole-network summary is large; everything else keeps the default cap. */
const IVAO_ATC_SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
/** More entries than this is not a real network snapshot; bounds sanitising work. */
const IVAO_ATC_SUMMARY_MAX_ENTRIES = 20_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Session and member identifiers are positive integers. */
function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The feed occasionally reports frequency as a numeric string. Zero (`0`,
 * `"0.000"`) reads as 0, i.e. connected but untuned. Anything unusable — an
 * implausible number (negative, positive but below 0.001, or 1000 MHz and
 * above), a missing or non-numeric value, or a string that is not plain
 * decimal — is coerced to 0 too, so the entry is kept: an established
 * session keeps its last frequency and a new one waits, rather than the entry
 * vanishing and producing a false OFFLINE. `coerced` reports whether the raw value was unusable.
 */
function coerceFrequency(value: unknown): { frequency: number; coerced: boolean } {
  let frequency: number;
  if (isFiniteNumber(value)) frequency = value;
  else if (typeof value === 'string' && FREQUENCY_STRING_PATTERN.test(value.trim())) frequency = Number(value.trim());
  else return { frequency: 0, coerced: true };
  if (frequency === 0) return { frequency: 0, coerced: false };
  return frequency >= MIN_FREQUENCY_MHZ && frequency < MAX_FREQUENCY_MHZ
    ? { frequency, coerced: false }
    : { frequency: 0, coerced: true };
}

/**
 * The longest prefix of `text` within `maxUnits` UTF-16 code units that ends
 * on a code-point boundary, so a surrogate pair is never split into invalid text.
 */
export function sliceCodePoints(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = 0;
  for (const char of text) {
    if (end + char.length > maxUnits) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * Control characters, Unicode line/paragraph separators and unpaired
 * surrogates become spaces and invisible format characters (bidi overrides,
 * zero-width joiners) are removed, so feed text cannot forge extra lines,
 * reorder what Discord displays, or make a payload invalid text. The cut
 * never splits a surrogate pair.
 */
function cleanText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ').replace(/\p{Cf}/gu, '');
}

function truncate(value: string, max: number): string {
  return sliceCodePoints(cleanText(value), max);
}

/**
 * Required feed text (a position or station name): cleaned first, then
 * trimmed, cut to `max` and trimmed again, so text that is empty only after
 * cleaning (control or invisible characters) reads as absent, and leading
 * characters that clean to spaces cannot push the real text past the cut.
 * `null` when nothing visible remains.
 */
function requiredText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return sliceCodePoints(cleanText(value).trim(), max).trimEnd() || null;
}

function sanitizeAirport(raw: unknown): NonNullable<IvaoAtcSummaryEntry['atcPosition']>['airport'] {
  if (!raw || typeof raw !== 'object') return null;
  const airport = raw as Record<string, unknown>;
  if (typeof airport.icao !== 'string') return null;
  const icao = airport.icao.trim().toUpperCase();
  if (!AIRPORT_ICAO_PATTERN.test(icao)) return null;
  return {
    icao,
    name: typeof airport.name === 'string' ? truncate(airport.name, MAX_TEXT_LENGTH) : null,
    city: typeof airport.city === 'string' ? truncate(airport.city, MAX_TEXT_LENGTH) : null,
    countryId: typeof airport.countryId === 'string' ? truncate(airport.countryId, MAX_ICAO_LENGTH) : null,
  };
}

function sanitizeAtcPosition(raw: unknown): IvaoAtcSummaryEntry['atcPosition'] {
  if (!raw || typeof raw !== 'object') return null;
  const pos = raw as Record<string, unknown>;
  const atcCallsign = requiredText(pos.atcCallsign, MAX_TEXT_LENGTH);
  if (!atcCallsign) return null;
  return {
    atcCallsign,
    airport: sanitizeAirport(pos.airport),
  };
}

function sanitizeSubcenter(raw: unknown): IvaoAtcSummaryEntry['subcenter'] {
  if (!raw || typeof raw !== 'object') return null;
  const sub = raw as Record<string, unknown>;
  const atcCallsign = requiredText(sub.atcCallsign, MAX_TEXT_LENGTH);
  if (!atcCallsign) return null;
  return {
    atcCallsign,
    centerId: typeof sub.centerId === 'string' ? truncate(sub.centerId, MAX_TEXT_LENGTH) : null,
  };
}

/** Per-parse counts of repaired fields, logged once as counts only. */
interface SanitizeStats {
  frequencyCoerced: number;
}

/**
 * Validate and coerce one raw feed entry into a safe shape, or `null` when it
 * is too malformed to trust (missing identifiers, no callsign, no position).
 * An unusable frequency is coerced to 0 (untuned) instead. Callsigns are
 * uppercased so case variants share one session. One bad entry must never
 * stall the whole poll.
 */
function sanitizeEntry(raw: unknown, stats: SanitizeStats): IvaoAtcSummaryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (!isPositiveId(entry.id) || !isPositiveId(entry.userId)) return null;
  if (typeof entry.callsign !== 'string' || !CALLSIGN_PATTERN.test(entry.callsign.trim())) return null;

  const session = entry.atcSession;
  if (!session || typeof session !== 'object') return null;
  const sessionRecord = session as Record<string, unknown>;
  const position = requiredText(sessionRecord.position, MAX_TEXT_LENGTH);
  if (!position) return null;
  const { frequency, coerced } = coerceFrequency(sessionRecord.frequency);
  if (coerced) stats.frequencyCoerced++;

  return {
    id: entry.id,
    userId: entry.userId,
    callsign: truncate(entry.callsign.trim().toUpperCase(), MAX_CALLSIGN_LENGTH),
    atcSession: { frequency, position },
    atcPosition: sanitizeAtcPosition(entry.atcPosition),
    subcenter: sanitizeSubcenter(entry.subcenter),
  };
}

/**
 * Two VIDs can briefly share a callsign during a handover; without dedup
 * they would flap offline/online every poll. Keep the higher session id
 * (the most recently opened position) and drop the rest.
 */
function dedupeByCallsign(entries: OnlineAtc[]): OnlineAtc[] {
  const byCallsign = new Map<string, OnlineAtc>();
  let duplicates = 0;
  for (const atc of entries) {
    const key = atc.callsign.toUpperCase();
    const existing = byCallsign.get(key);
    if (!existing) {
      byCallsign.set(key, atc);
      continue;
    }
    duplicates++;
    if (atc.sessionId > existing.sessionId) byCallsign.set(key, atc);
  }
  if (duplicates > 0) {
    console.warn(JSON.stringify({ event: 'ivao_duplicate_callsign', count: duplicates }));
  }
  return [...byCallsign.values()];
}

// --- OAuth2 client credentials ----------------------------------------------

/** Refresh this long before the token actually expires. */
const TOKEN_SAFETY_MARGIN_MS = 120_000;

/**
 * Keep expires_in within a sane window regardless of what the API reports.
 * The minimum must stay above TOKEN_SAFETY_MARGIN_MS, or a short-lived token
 * would expire (by our own cached expiresAt) before it was even minted.
 */
const MIN_TOKEN_TTL_SECONDS = 180;
const MAX_TOKEN_TTL_SECONDS = 86_400;

/**
 * After a transient mint failure (5xx, 429, other 4xx, timeout, network error,
 * or a 2xx without a usable token) skip re-minting for 1, 2, 4, 8 and then at
 * most 15 minutes, instead of retrying every call. Reset by a successful mint.
 */
const TOKEN_FAIL_BACKOFF_BASE_MS = 60_000;
const TOKEN_FAIL_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * The token endpoint rejected the client credentials themselves (400, 401 or
 * 403): retrying cannot help until an operator fixes them, so minting pauses
 * for TRACKER_ANONYMOUS_MS.
 */
const TOKEN_REJECTED_STATUSES = new Set([400, 401, 403]);

/** Domain label of the token-to-credentials binding; bump it to orphan every cached token. */
const TOKEN_FINGERPRINT_LABEL = 'onfreq-ivao-token:v1\n';

/** access_token must be a non-empty run of printable ASCII (RFC 6750 b64token-ish). */
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Per-isolate cache, so warm invocations skip the KV read entirely. KV is the
 * cross-isolate cache — tokens live 30 minutes, so this is ~50 writes a day.
 */
let memoryToken: BoundToken | null = null;

/**
 * A cached token bound to the credentials that minted it. `fingerprint` is
 * hex(HMAC-SHA-256(client secret, label + client id)) cut to 32 characters:
 * a token cached under other credentials (a rotated id or secret) is a miss.
 * v2.3.3 reads `token` and `expiresAt` and ignores the extra field, so a
 * rollback keeps using entries written by this version.
 */
interface BoundToken extends CachedToken {
  fingerprint: string;
}

/** Epoch ms until which a fresh mint attempt is skipped after a recent failure. */
let tokenFailedUntil = 0;

/** Consecutive transient mint failures, for the exponential backoff. */
let tokenFailures = 0;

/** The fingerprint of the current credentials, computed once per isolate. */
let fingerprintMemo: { clientId: string; clientSecret: string; value: Promise<string> } | null = null;

/**
 * Minimum time between production cache invalidations triggered by
 * `invalidateCachedToken`, regardless of which caller most recently minted
 * the token. Without this, a downstream endpoint (e.g. member-country
 * profile lookups) that keeps rejecting even freshly minted tokens would
 * force a fresh mint on every single call in a poll.
 */
const TOKEN_INVALIDATE_BACKOFF_MS = 30 * 60 * 1000;

/**
 * Epoch ms of the most recent production token invalidation, by
 * `invalidateCachedToken` or a tracker-feed 401 in `fetchDivisionAtc`; gates
 * `invalidateCachedToken`.
 */
let lastInvalidatedAt = 0;

/**
 * Tracker only: until this epoch ms the feed is fetched anonymously, with no
 * token read, mint or KV access, because the tracker rejected our token (a
 * 401 for one minted in that same call, or a 403 for any). Profile lookups
 * keep their own token handling. In isolate memory, like the token cache.
 */
let trackerAnonymousUntil = 0;
const TRACKER_ANONYMOUS_MS = 30 * 60_000;

/**
 * Drop the in-memory cached token so the next call mints a fresh one.
 * Safe for production use by any caller whose request was rejected with a
 * token that should no longer be trusted (e.g. member-country profile
 * lookups). Rate-limited to at most one invalidation per ~30 minutes,
 * independent of which caller most recently minted the token, so a
 * downstream endpoint that rejects even freshly minted tokens cannot force a
 * fresh mint on every call. Returns whether it actually invalidated the
 * cache (`false` when skipped by the rate limit).
 */
export function invalidateCachedToken(): boolean {
  const now = Date.now();
  if (now - lastInvalidatedAt < TOKEN_INVALIDATE_BACKOFF_MS) return false;
  lastInvalidatedAt = now;
  memoryToken = null;
  return true;
}

/**
 * Test-only: clear every module-level token cache state (in-memory token,
 * mint failure backoff, invalidation rate limit) between test cases.
 * Production code must never call this — use `invalidateCachedToken()`
 * instead.
 */
export function resetTokenCache(): void {
  memoryToken = null;
  tokenFailedUntil = 0;
  tokenFailures = 0;
  fingerprintMemo = null;
  lastInvalidatedAt = 0;
  trackerAnonymousUntil = 0;
}

function isCachedToken(value: unknown): value is CachedToken {
  return !!value && typeof value === 'object' &&
    typeof (value as Partial<CachedToken>).token === 'string' &&
    ACCESS_TOKEN_PATTERN.test((value as CachedToken).token) &&
    Number.isFinite((value as Partial<CachedToken>).expiresAt);
}

/** The credentials fingerprint a cached token must carry to be used. */
function tokenFingerprint(auth: IvaoAuth): Promise<string> {
  if (fingerprintMemo?.clientId !== auth.clientId || fingerprintMemo.clientSecret !== auth.clientSecret) {
    const value = (async () => {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(auth.clientSecret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(TOKEN_FINGERPRINT_LABEL + auth.clientId));
      return [...new Uint8Array(mac, 0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    })();
    fingerprintMemo = { clientId: auth.clientId, clientSecret: auth.clientSecret, value };
    // A failed computation is retried by the next call instead of cached.
    value.catch(() => {
      if (fingerprintMemo?.value === value) fingerprintMemo = null;
    });
  }
  return fingerprintMemo.value;
}

/**
 * A mint failure, already logged once for its backoff window, or a mint
 * skipped inside that window (silent). Fixed messages only: never a response
 * body, which carries the token on success.
 */
class TokenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenUnavailableError';
  }
}

/** Why a mint attempt failed, safe to log: an HTTP status or a fixed category. */
class TokenMintFailure extends Error {
  constructor(message: string, readonly status: number | undefined, readonly category: string) {
    super(message);
    this.name = 'TokenMintFailure';
  }
}

/** Start the backoff window for a failed mint and log it once, with status or category only. */
function recordMintFailure(err: unknown, now: number): void {
  const status = err instanceof TokenMintFailure ? err.status : undefined;
  let backoffMs: number;
  if (status !== undefined && TOKEN_REJECTED_STATUSES.has(status)) {
    backoffMs = TRACKER_ANONYMOUS_MS;
  } else {
    tokenFailures++;
    backoffMs = Math.min(TOKEN_FAIL_BACKOFF_MAX_MS, TOKEN_FAIL_BACKOFF_BASE_MS * 2 ** Math.min(tokenFailures - 1, 30));
  }
  tokenFailedUntil = now + backoffMs;
  let detail: { status: number } | { error: string };
  if (status !== undefined) detail = { status };
  else if (err instanceof TokenMintFailure) detail = { error: err.category };
  else if (err instanceof Error && err.message === 'upstream request timed out') detail = { error: 'timeout' };
  else detail = { error: err instanceof Error ? err.name : typeof err };
  console.error(JSON.stringify({ event: 'ivao_auth_failed', ...detail, backoffMs }));
}

/**
 * A corrupt cache entry is treated as a miss (and re-minted) rather than
 * failing every call until it expires. Parse errors can quote the stored
 * token, so only a fixed event is logged.
 */
async function readCachedToken(kv: KVNamespace): Promise<unknown> {
  try {
    return await kv.get<unknown>(TOKEN_KEY, 'json');
  } catch {
    console.warn(JSON.stringify({ event: 'ivao_token_cache_read_failed' }));
    return null;
  }
}

function clampTtlSeconds(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1800;
  return Math.min(MAX_TOKEN_TTL_SECONDS, Math.max(MIN_TOKEN_TTL_SECONDS, n));
}

/**
 * A `tracker`-scoped access token, cached until shortly before it expires.
 * Authenticated requests are attributed to this application rather than to
 * the shared anonymous pool — which matters on Workers, where egress IPs are
 * shared with every other bot on the platform.
 *
 * `forceRefresh` skips both caches — used right after a 401, when a cached
 * token (in memory or in KV, if the cleanup delete below failed) is known bad.
 */
export async function getAccessToken(
  auth: IvaoAuth,
  opts: { forceRefresh?: boolean } = {},
): Promise<string> {
  return (await obtainToken(auth, opts)).token;
}

/** `getAccessToken`, also saying whether the token was minted by this call. */
async function obtainToken(
  auth: IvaoAuth,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ token: string; minted: boolean }> {
  const now = Date.now();
  const fingerprint = await tokenFingerprint(auth);
  if (!opts.forceRefresh) {
    if (memoryToken && memoryToken.fingerprint === fingerprint && memoryToken.expiresAt > now) {
      return { token: memoryToken.token, minted: false };
    }

    // An entry without the current fingerprint (written by v2.3.3, or under
    // other credentials) is a miss, and the mint below overwrites it.
    const stored = await readCachedToken(auth.kv);
    if (isCachedToken(stored) && (stored as Partial<BoundToken>).fingerprint === fingerprint && stored.expiresAt > now) {
      // Never trust a stored expiry beyond the longest token lifetime.
      memoryToken = {
        token: stored.token, expiresAt: Math.min(stored.expiresAt, now + MAX_TOKEN_TTL_SECONDS * 1000), fingerprint,
      };
      return { token: stored.token, minted: false };
    }
  }

  // A recent mint failure means credentials or the IVAO endpoint are down;
  // skip wasting more subrequests on it until the backoff expires. Silent:
  // the failure itself was logged once for this window.
  if (tokenFailedUntil > now) {
    throw new TokenUnavailableError('IVAO token mint skipped: recent failure backoff in effect');
  }

  let accessToken: string;
  let expiresIn: unknown;
  try {
    const res = await fetchBuffered(IVAO_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        scope: IVAO_SCOPE,
      }),
    });
    // Deliberately not echoing the body: it carries the token on success.
    if (!res.ok) throw new TokenMintFailure(`IVAO token request failed with ${res.status}`, res.status, 'status');

    // A JSON parse error message can quote the body, which carries the token.
    let body: { access_token?: unknown; expires_in?: unknown } | null;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TokenMintFailure('IVAO token response was not valid JSON', undefined, 'invalid_json');
    }
    if (typeof body?.access_token !== 'string' || !ACCESS_TOKEN_PATTERN.test(body.access_token)) {
      throw new TokenMintFailure('IVAO token response contained no usable access_token', undefined, 'no_access_token');
    }
    accessToken = body.access_token;
    expiresIn = body.expires_in;
  } catch (err) {
    recordMintFailure(err, now);
    throw new TokenUnavailableError(err instanceof TokenMintFailure ? err.message : 'IVAO token request failed');
  }

  const ttlSeconds = clampTtlSeconds(expiresIn);
  const entry: BoundToken = {
    token: accessToken,
    expiresAt: now + ttlSeconds * 1000 - TOKEN_SAFETY_MARGIN_MS,
    fingerprint,
  };
  memoryToken = entry;
  tokenFailedUntil = 0;
  tokenFailures = 0;
  try {
    await auth.kv.put(TOKEN_KEY, JSON.stringify(entry), {
      expirationTtl: Math.floor(ttlSeconds),
    });
  } catch (err) {
    // The in-memory cache above still serves this isolate for the token's
    // lifetime; only cross-isolate reuse is lost. The error's name only: its
    // message could quote the value being written.
    console.warn(JSON.stringify({
      event: 'ivao_token_cache_write_failed', error: err instanceof Error ? err.name : typeof err,
    }));
  }
  return { token: entry.token, minted: true };
}

/** Build the auth config from the environment, or undefined when unset. */
export function ivaoAuthFromEnv(env: Env): IvaoAuth | undefined {
  const clientId = env.IVAO_CLIENT_ID?.trim();
  const clientSecret = env.IVAO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret, kv: env.ATC_STATE };
}

async function authHeaders(
  auth: IvaoAuth | undefined,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ headers: Record<string, string>; minted: boolean }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!auth) return { headers, minted: false };
  try {
    const { token, minted } = await obtainToken(auth, opts);
    headers.authorization = `Bearer ${token}`;
    return { headers, minted };
  } catch (err) {
    // Bad or temporarily unavailable credentials must not take the bot down:
    // the tracker endpoint still serves unauthenticated callers. A failed
    // mint was already logged once for its backoff window; a skipped one is
    // silent. Anything else logs its name only.
    if (!(err instanceof TokenUnavailableError)) {
      console.error(JSON.stringify({ event: 'ivao_auth_failed', error: err instanceof Error ? err.name : typeof err }));
    }
  }
  return { headers, minted: false };
}

/**
 * Fetch all ATC currently online in the given FIRs.
 *
 * Throws when the API is unreachable, returns a non-2xx status, or reports
 * zero ATC worldwide (there is essentially always someone online on the
 * whole network, so an empty list means a broken feed — treating it as an
 * outage prevents a wave of false "offline" notifications).
 */
export async function fetchDivisionAtc(
  prefixes: string[],
  auth?: IvaoAuth,
  /** Filled with the VIDs of every division entry, before duplicate callsigns are merged. */
  presentVids?: number[],
  /** Filled with the (VID, IVAO session id) of the same entries. */
  presentSessions?: { userId: number; sessionId: number }[],
): Promise<OnlineAtc[]> {
  const feed = (headers: Record<string, string>) =>
    fetchBuffered(IVAO_ATC_SUMMARY_URL, { headers }, { maxBytes: IVAO_ATC_SUMMARY_MAX_BYTES });
  // While the tracker is known to reject our tokens, skip them entirely.
  const first = auth && trackerAnonymousUntil <= Date.now()
    ? await authHeaders(auth)
    : { headers: { accept: 'application/json' }, minted: false };
  let res = await feed(first.headers);
  const authRejected = (status: number) => status === 401 || status === 403;
  // A rejection of a request that carried a token: its status and whether
  // that token was minted in this call. An anonymous request's 401 or 403 is
  // never a token problem and is not retried.
  let rejected = first.headers.authorization && authRejected(res.status)
    ? { status: res.status, fresh: first.minted } : undefined;

  // A cached token rejected with 401 (revoked or rotated before its stated
  // expiry) is worth exactly one retry with a freshly minted one.
  if (rejected && rejected.status === 401 && !rejected.fresh && auth) {
    // Drop the rejected token and count this as the invalidation window, so a
    // profile 401 right after cannot discard the token minted below.
    memoryToken = null;
    lastInvalidatedAt = Date.now();
    try {
      await auth.kv.delete(TOKEN_KEY);
    } catch (err) {
      // A transient KV error here must not fail the whole poll; forceRefresh
      // below skips reading a possibly-still-present stale KV entry anyway.
      console.warn(JSON.stringify({
        event: 'ivao_token_delete_failed', error: err instanceof Error ? err.name : typeof err,
      }));
    }
    const retry = await authHeaders(auth, { forceRefresh: true });
    res = await feed(retry.headers);
    // A failed re-mint sends the retry anonymously: its result stands.
    rejected = retry.headers.authorization && authRejected(res.status)
      ? { status: res.status, fresh: retry.minted } : undefined;
  }
  // A token minted in this call rejected with 401, or any token with 403: the
  // tracker rejects our credentials, not a stale token. Fetch anonymously now
  // and for TRACKER_ANONYMOUS_MS (the KV token is kept); one authenticated
  // attempt follows the window. Logged once per window, without the body.
  if (rejected) {
    trackerAnonymousUntil = Date.now() + TRACKER_ANONYMOUS_MS;
    console.warn(JSON.stringify({
      event: 'ivao_tracker_auth_rejected', status: rejected.status, fresh: rejected.fresh, fallback: 'anonymous',
    }));
    res = await feed({ accept: 'application/json' });
  }

  if (!res.ok) {
    throw new Error(`IVAO API responded with ${res.status}`);
  }
  let entries: unknown;
  try {
    entries = await res.json();
  } catch {
    // A fixed message: the parser's own error quotes the body, which would
    // then reach the poll_failed log and the stored snapshot error.
    throw new Error('IVAO API returned invalid JSON');
  }
  if (!Array.isArray(entries)) {
    throw new Error('IVAO API returned an unexpected payload');
  }
  if (entries.length > IVAO_ATC_SUMMARY_MAX_ENTRIES) {
    throw new Error('IVAO API returned too many entries; treating as feed outage');
  }
  if (entries.length === 0) {
    throw new Error('IVAO API returned zero ATC worldwide; treating as feed outage');
  }

  const sanitized: IvaoAtcSummaryEntry[] = [];
  let skipped = 0;
  const stats: SanitizeStats = { frequencyCoerced: 0 };
  for (const raw of entries) {
    const entry = sanitizeEntry(raw, stats);
    if (entry) sanitized.push(entry); else skipped++;
  }
  if (skipped > 0) {
    console.warn(JSON.stringify({ event: 'ivao_entry_skipped', count: skipped }));
  }
  if (stats.frequencyCoerced > 0) {
    console.warn(JSON.stringify({ event: 'ivao_frequency_coerced', count: stats.frequencyCoerced }));
  }
  // A feed format change can make every (or nearly every) entry fail
  // validation instead of the request itself failing. Treat that the same as
  // the zero-ATC check above: an outage, not a mass real disconnect. Kept
  // entries whose frequency was unusable count too: a feed whose frequencies
  // all fail to parse would otherwise poll "successfully" while never
  // announcing anyone. A genuine 0 (untuned) is not coerced and does not count.
  const unusable = skipped + stats.frequencyCoerced;
  if (sanitized.length === 0 || unusable > entries.length / 2) {
    throw new Error(
      `IVAO API entries mostly failed validation (${skipped}/${entries.length} skipped, ${stats.frequencyCoerced} frequencies coerced); treating as feed outage`,
    );
  }

  const division = sanitized
    .filter((e) => isDivisionCallsign(e.callsign, prefixes))
    .map(normalizeAtc);
  presentVids?.push(...division.map((atc) => atc.userId));
  presentSessions?.push(...division.map((atc) => ({ userId: atc.userId, sessionId: atc.sessionId })));
  return dedupeByCallsign(division);
}
