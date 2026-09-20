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

// --- OAuth2 client credentials ----------------------------------------------

/** Refresh this long before the token actually expires. */
const TOKEN_SAFETY_MARGIN_MS = 120_000;

/**
 * Per-isolate cache, so warm invocations skip the KV read entirely. KV is the
 * cross-isolate cache — tokens live 30 minutes, so this is ~50 writes a day.
 */
let memoryToken: CachedToken | null = null;

/** Exposed for tests; production code never needs to reach for this. */
export function resetTokenCache(): void {
  memoryToken = null;
}

/**
 * A `tracker`-scoped access token, cached until shortly before it expires.
 * Authenticated requests are attributed to this application rather than to
 * the shared anonymous pool — which matters on Workers, where egress IPs are
 * shared with every other bot on the platform.
 */
export async function getAccessToken(auth: IvaoAuth): Promise<string> {
  const now = Date.now();
  if (memoryToken && memoryToken.expiresAt > now) return memoryToken.token;

  const stored = await auth.kv.get<CachedToken>(TOKEN_KEY, 'json');
  if (stored && stored.expiresAt > now) {
    memoryToken = stored;
    return stored.token;
  }

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

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error('IVAO token response contained no access_token');

  const ttlSeconds = typeof body.expires_in === 'number' ? body.expires_in : 1800;
  const entry: CachedToken = {
    token: body.access_token,
    expiresAt: now + ttlSeconds * 1000 - TOKEN_SAFETY_MARGIN_MS,
  };
  memoryToken = entry;
  await auth.kv.put(TOKEN_KEY, JSON.stringify(entry), {
    expirationTtl: Math.max(60, Math.floor(ttlSeconds)),
  });
  return entry.token;
}

/** Build the auth config from the environment, or undefined when unset. */
export function ivaoAuthFromEnv(env: Env): IvaoAuth | undefined {
  const clientId = env.IVAO_CLIENT_ID?.trim();
  const clientSecret = env.IVAO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret, kv: env.ATC_STATE };
}

async function authHeaders(auth: IvaoAuth | undefined): Promise<Record<string, string>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!auth) return headers;
  try {
    headers.authorization = `Bearer ${await getAccessToken(auth)}`;
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
  let res = await fetchBuffered(IVAO_ATC_SUMMARY_URL, { headers: await authHeaders(auth) });

  // A token rejected before its stated expiry (revoked, rotated) is worth
  // exactly one retry with a freshly minted one.
  if (res.status === 401 && auth) {
    resetTokenCache();
    await auth.kv.delete(TOKEN_KEY);
    res = await fetchBuffered(IVAO_ATC_SUMMARY_URL, { headers: await authHeaders(auth) });
  }

  if (!res.ok) {
    throw new Error(`IVAO API responded with ${res.status}`);
  }
  const entries = (await res.json()) as IvaoAtcSummaryEntry[];
  if (!Array.isArray(entries)) {
    throw new Error('IVAO API returned an unexpected payload');
  }
  if (entries.length === 0) {
    throw new Error('IVAO API returned zero ATC worldwide; treating as feed outage');
  }
  return entries
    .filter((e) => isDivisionCallsign(e.callsign, prefixes))
    .map(normalizeAtc);
}
