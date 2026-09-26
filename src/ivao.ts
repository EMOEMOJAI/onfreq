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
    station: entry.atcPosition?.atcCallsign ?? entry.subcenter?.atcCallsign ?? null,
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The feed occasionally reports frequency as a numeric string. */
function coerceFrequency(value: unknown): number | null {
  if (isFiniteNumber(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function sanitizeAirport(raw: unknown): NonNullable<IvaoAtcSummaryEntry['atcPosition']>['airport'] {
  if (!raw || typeof raw !== 'object') return null;
  const airport = raw as Record<string, unknown>;
  if (typeof airport.icao !== 'string' || !airport.icao.trim()) return null;
  return {
    icao: truncate(airport.icao.trim(), MAX_ICAO_LENGTH),
    name: typeof airport.name === 'string' ? truncate(airport.name, MAX_TEXT_LENGTH) : null,
    city: typeof airport.city === 'string' ? truncate(airport.city, MAX_TEXT_LENGTH) : null,
    countryId: typeof airport.countryId === 'string' ? truncate(airport.countryId, MAX_ICAO_LENGTH) : null,
  };
}

function sanitizeAtcPosition(raw: unknown): IvaoAtcSummaryEntry['atcPosition'] {
  if (!raw || typeof raw !== 'object') return null;
  const pos = raw as Record<string, unknown>;
  if (typeof pos.atcCallsign !== 'string' || !pos.atcCallsign.trim()) return null;
  return {
    atcCallsign: truncate(pos.atcCallsign.trim(), MAX_TEXT_LENGTH),
    airport: sanitizeAirport(pos.airport),
  };
}

function sanitizeSubcenter(raw: unknown): IvaoAtcSummaryEntry['subcenter'] {
  if (!raw || typeof raw !== 'object') return null;
  const sub = raw as Record<string, unknown>;
  if (typeof sub.atcCallsign !== 'string' || !sub.atcCallsign.trim()) return null;
  return {
    atcCallsign: truncate(sub.atcCallsign.trim(), MAX_TEXT_LENGTH),
    centerId: typeof sub.centerId === 'string' ? truncate(sub.centerId, MAX_TEXT_LENGTH) : null,
  };
}

/**
 * Validate and coerce one raw feed entry into a safe shape, or `null` when it
 * is too malformed to trust (missing identifiers, no callsign, an
 * unparseable frequency). One bad entry must never stall the whole poll.
 */
function sanitizeEntry(raw: unknown): IvaoAtcSummaryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (!isFiniteNumber(entry.id) || !isFiniteNumber(entry.userId)) return null;
  if (typeof entry.callsign !== 'string' || !entry.callsign.trim()) return null;

  const session = entry.atcSession;
  if (!session || typeof session !== 'object') return null;
  const sessionRecord = session as Record<string, unknown>;
  const frequency = coerceFrequency(sessionRecord.frequency);
  if (frequency === null) return null;
  if (typeof sessionRecord.position !== 'string' || !sessionRecord.position.trim()) return null;

  return {
    id: entry.id,
    userId: entry.userId,
    callsign: truncate(entry.callsign.trim(), MAX_CALLSIGN_LENGTH),
    connectionType: typeof entry.connectionType === 'string' ? entry.connectionType : '',
    atcSession: { frequency, position: truncate(sessionRecord.position.trim(), MAX_TEXT_LENGTH) },
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

/** Skip re-minting for a while after a failure, instead of retrying every call. */
const TOKEN_FAIL_BACKOFF_MS = 60_000;

/** access_token must be a non-empty run of printable ASCII (RFC 6750 b64token-ish). */
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Per-isolate cache, so warm invocations skip the KV read entirely. KV is the
 * cross-isolate cache — tokens live 30 minutes, so this is ~50 writes a day.
 */
let memoryToken: CachedToken | null = null;

/** Epoch ms until which a fresh mint attempt is skipped after a recent failure. */
let tokenFailedUntil = 0;

/**
 * Epoch ms of the most recently completed mint (a real IVAO_TOKEN_URL round
 * trip, not a cache hit). Lets callers such as member-country lookups tell
 * whether the token currently in hand was freshly minted during their own
 * run, so a downstream 401 against a brand-new token isn't treated as "this
 * cached token is stale" and reset again.
 */
let lastMintedAt = 0;

/** True when a token was minted (not just cache-served) at or after `timestamp`. */
export function tokenMintedAfter(timestamp: number): boolean {
  return lastMintedAt >= timestamp;
}

/** Exposed for tests; production code never needs to reach for this. */
export function resetTokenCache(): void {
  memoryToken = null;
  tokenFailedUntil = 0;
  lastMintedAt = 0;
}

function isCachedToken(value: unknown): value is CachedToken {
  return !!value && typeof value === 'object' &&
    typeof (value as Partial<CachedToken>).token === 'string' &&
    Number.isFinite((value as Partial<CachedToken>).expiresAt);
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
  const now = Date.now();
  if (!opts.forceRefresh) {
    if (memoryToken && memoryToken.expiresAt > now) return memoryToken.token;

    const stored = await auth.kv.get<CachedToken>(TOKEN_KEY, 'json');
    if (isCachedToken(stored) && stored.expiresAt > now) {
      memoryToken = stored;
      return stored.token;
    }
  }

  // A recent mint failure means credentials or the IVAO endpoint are down;
  // skip wasting more subrequests on it until the backoff expires.
  if (tokenFailedUntil > now) {
    throw new Error('IVAO token mint skipped: recent failure backoff in effect');
  }

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
    if (!res.ok) throw new Error(`IVAO token request failed with ${res.status}`);

    const body = (await res.json()) as { access_token?: unknown; expires_in?: number };
    if (typeof body.access_token !== 'string' || !ACCESS_TOKEN_PATTERN.test(body.access_token)) {
      throw new Error('IVAO token response contained no usable access_token');
    }

    const ttlSeconds = clampTtlSeconds(body.expires_in);
    const entry: CachedToken = {
      token: body.access_token,
      expiresAt: now + ttlSeconds * 1000 - TOKEN_SAFETY_MARGIN_MS,
    };
    memoryToken = entry;
    tokenFailedUntil = 0;
    lastMintedAt = now;
    try {
      await auth.kv.put(TOKEN_KEY, JSON.stringify(entry), {
        expirationTtl: Math.floor(ttlSeconds),
      });
    } catch (err) {
      // The in-memory cache above still serves this isolate for the token's
      // lifetime; only cross-isolate reuse is lost.
      console.warn(JSON.stringify({ event: 'ivao_token_cache_write_failed', error: String(err) }));
    }
    return entry.token;
  } catch (err) {
    tokenFailedUntil = now + TOKEN_FAIL_BACKOFF_MS;
    throw err;
  }
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
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!auth) return headers;
  try {
    headers.authorization = `Bearer ${await getAccessToken(auth, opts)}`;
  } catch (err) {
    // Bad or temporarily unavailable credentials must not take the bot down:
    // the tracker endpoint still serves unauthenticated callers.
    console.error(JSON.stringify({ event: 'ivao_auth_failed', error: String(err) }));
  }
  return headers;
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
): Promise<OnlineAtc[]> {
  const headers = await authHeaders(auth);
  let res = await fetchBuffered(IVAO_ATC_SUMMARY_URL, { headers });

  // A token rejected before its stated expiry (revoked, rotated) is worth
  // exactly one retry with a freshly minted one — but only when we actually
  // sent one: an anonymous request rejected with 401 is not a token problem.
  if (res.status === 401 && auth && headers.authorization) {
    resetTokenCache();
    try {
      await auth.kv.delete(TOKEN_KEY);
    } catch (err) {
      // A transient KV error here must not fail the whole poll; forceRefresh
      // below skips reading a possibly-still-present stale KV entry anyway.
      console.warn(JSON.stringify({ event: 'ivao_token_delete_failed', error: String(err) }));
    }
    res = await fetchBuffered(IVAO_ATC_SUMMARY_URL, {
      headers: await authHeaders(auth, { forceRefresh: true }),
    });
  }

  if (!res.ok) {
    throw new Error(`IVAO API responded with ${res.status}`);
  }
  const entries = (await res.json()) as unknown[];
  if (!Array.isArray(entries)) {
    throw new Error('IVAO API returned an unexpected payload');
  }
  if (entries.length === 0) {
    throw new Error('IVAO API returned zero ATC worldwide; treating as feed outage');
  }

  const sanitized: IvaoAtcSummaryEntry[] = [];
  let skipped = 0;
  for (const raw of entries) {
    const entry = sanitizeEntry(raw);
    if (entry) sanitized.push(entry); else skipped++;
  }
  if (skipped > 0) {
    console.warn(JSON.stringify({ event: 'ivao_entry_skipped', count: skipped }));
  }
  // A feed format change can make every (or nearly every) entry fail
  // validation instead of the request itself failing. Treat that the same as
  // the zero-ATC check above: an outage, not a mass real disconnect.
  if (sanitized.length === 0 || skipped > entries.length / 2) {
    throw new Error(
      `IVAO API entries mostly failed validation (${skipped}/${entries.length} skipped); treating as feed outage`,
    );
  }

  return dedupeByCallsign(
    sanitized
      .filter((e) => isDivisionCallsign(e.callsign, prefixes))
      .map(normalizeAtc),
  );
}
