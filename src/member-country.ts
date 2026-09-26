import { TOKEN_KEY } from './config';
import { fetchBuffered } from './http';
import { getAccessToken, hasFrequency, invalidateCachedToken } from './ivao';
import type { IvaoAuth, MemberCountry, OnlineAtc, StateMap } from './types';

const COUNTRY_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
/** A short in-memory/snapshot-consistent backoff for ids that were skipped
 * entirely (never attempted) because an earlier id in the same batch stopped
 * the run — avoids hammering the same blocked-looking id every poll. */
const SKIP_BACKOFF_MS = 60 * 1000;
// Bound optional enrichment work even when many controllers connect at once.
const MAX_LOOKUPS_PER_POLL = 5;
/** No new lookup starts after this wall-clock budget elapses, even if every
 * individual request is within its own timeout. */
const LOOKUP_DEADLINE_MS = 10_000;
/** A profile request failing with one of these means the whole batch is
 * currently blocked (bad/rejected auth, or already rate-limited) — further
 * lookups in the same run would just fail the same way. */
const STOP_RUN_STATUSES = new Set([401, 403, 429]);

export function countryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'ZZ' ? code : null;
}

/** Mutates only current entries; profile failures never fail a tracker poll. */
export async function enrichMemberCountries(
  current: OnlineAtc[], previous: StateMap, auth?: IvaoAuth,
): Promise<void> {
  const now = Date.now();
  const cached = new Map<number, MemberCountry>();
  for (const atc of Object.values(previous)) {
    if (atc.memberCountry && atc.memberCountry.expiresAt > (cached.get(atc.userId)?.expiresAt ?? 0)) {
      cached.set(atc.userId, atc.memberCountry);
    }
  }
  // Explicit null prevents a callsign reused by another VID inheriting its country.
  for (const atc of current) atc.memberCountry = auth ? cached.get(atc.userId) ?? null : null;
  if (!auth) return;

  const ids = [...new Set(current.filter(hasFrequency).map((atc) => atc.userId))]
    .filter((id) => Number.isSafeInteger(id) && id > 0 && (cached.get(id)?.expiresAt ?? 0) <= now)
    .sort((a, b) => (cached.get(a)?.expiresAt ?? 0) - (cached.get(b)?.expiresAt ?? 0))
    .slice(0, MAX_LOOKUPS_PER_POLL);
  let token: Promise<string> | undefined;
  // Sequential, not Promise.all: a 401/403/429/5xx or a thrown fetch error
  // means the rest of this batch would fail the same way, so later ids in
  // the list are skipped entirely.
  let stopRun = false;
  const attempted = new Set<number>();
  const start = now;
  for (const id of ids) {
    if (stopRun || Date.now() - start >= LOOKUP_DEADLINE_MS) break;
    attempted.add(id);
    const key = `ivao-member-country-v1:${id}`;
    let value: MemberCountry;
    let persist = true;
    try {
      const stored = await auth.kv.get<MemberCountry>(key, 'json');
      if (stored && stored.expiresAt > now) {
        cached.set(id, { countryId: countryCode(stored.countryId), expiresAt: stored.expiresAt });
        continue;
      }
      token ??= getAccessToken(auth);
      let res: Response;
      try {
        res = await fetchBuffered(`https://api.ivao.aero/v2/users/${id}`, {
          headers: { accept: 'application/json', authorization: `Bearer ${await token}` },
        });
      } catch (err) {
        // A thrown fetch error (timeout, network failure) means this batch's
        // auth/network path is currently broken; further ids would just fail
        // the same way.
        stopRun = true;
        throw err;
      }
      if (!res.ok) {
        if (res.status === 401 && invalidateCachedToken()) {
          // The cached token was rejected; drop it so the next poll mints a
          // fresh one instead of failing the same way for up to
          // ~28 more minutes. Rate-limited internally: if the profile
          // endpoint rejects even freshly minted tokens, this must not churn
          // through a fresh mint on every single lookup.
          try {
            await auth.kv.delete(TOKEN_KEY);
          } catch (err) {
            console.warn(JSON.stringify({ event: 'ivao_token_delete_failed', error: String(err) }));
          }
        }
        if (STOP_RUN_STATUSES.has(res.status) || res.status >= 500) stopRun = true;
        throw new Error(`IVAO profile request failed with ${res.status}`);
      }
      const body = await res.json() as { countryId?: unknown } | null;
      value = { countryId: countryCode(body?.countryId), expiresAt: now + COUNTRY_TTL_MS };
    } catch {
      // Keep a previously known country during transient failures; retry
      // later. Not written to KV below: a failing lookup must not consume
      // the KV write quota on every poll, only this run's in-memory map and
      // the session snapshot (via `previous`) carry the backoff forward.
      console.warn(JSON.stringify({ event: 'member_country_unavailable', userId: id }));
      value = { countryId: cached.get(id)?.countryId ?? null, expiresAt: now + RETRY_MS };
      persist = false;
    }
    cached.set(id, value);
    if (persist) {
      try {
        // Store only the country and expiry, never the rest of the member profile.
        await auth.kv.put(key, JSON.stringify(value), {
          expirationTtl: Math.max(60, Math.ceil((value.expiresAt - now) / 1000)),
        });
      } catch {
        // The coordinator snapshot still retains this cache entry for the session.
        console.warn(JSON.stringify({ event: 'member_country_cache_failed', userId: id }));
      }
    }
  }
  // Ids that were never attempted (stopRun broke the loop before reaching
  // them) get a short backoff instead of being retried again next poll.
  for (const id of ids) {
    if (attempted.has(id)) continue;
    const prior = cached.get(id);
    cached.set(id, { countryId: prior?.countryId ?? null, expiresAt: now + SKIP_BACKOFF_MS });
  }
  for (const atc of current) atc.memberCountry = cached.get(atc.userId) ?? null;
}
