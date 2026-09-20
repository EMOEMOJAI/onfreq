import { fetchBuffered } from './http';
import { getAccessToken, hasFrequency } from './ivao';
import type { IvaoAuth, MemberCountry, OnlineAtc, StateMap } from './types';

const COUNTRY_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
// Bound optional enrichment work even when many controllers connect at once.
const MAX_LOOKUPS_PER_POLL = 5;

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
  await Promise.all(ids.map(async (id) => {
    const key = `ivao-member-country-v1:${id}`;
    let value: MemberCountry = { countryId: cached.get(id)?.countryId ?? null, expiresAt: now + RETRY_MS };
    try {
      const stored = await auth.kv.get<MemberCountry>(key, 'json');
      if (stored && stored.expiresAt > now) {
        cached.set(id, { countryId: countryCode(stored.countryId), expiresAt: stored.expiresAt });
        return;
      }
      token ??= getAccessToken(auth);
      const res = await fetchBuffered(`https://api.ivao.aero/v2/users/${id}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${await token}` },
      });
      if (!res.ok) throw new Error(`IVAO profile request failed with ${res.status}`);
      const body = await res.json() as { countryId?: unknown } | null;
      value = { countryId: countryCode(body?.countryId), expiresAt: now + COUNTRY_TTL_MS };
    } catch {
      // Keep a previously known country during transient failures; retry later.
      console.warn(JSON.stringify({ event: 'member_country_unavailable', userId: id }));
    }
    cached.set(id, value);
    try {
      // Store only the country and expiry, never the rest of the member profile.
      await auth.kv.put(key, JSON.stringify(value), {
        expirationTtl: Math.max(60, Math.ceil((value.expiresAt - now) / 1000)),
      });
    } catch {
      // The coordinator snapshot still retains this cache entry for the session.
      console.warn(JSON.stringify({ event: 'member_country_cache_failed', userId: id }));
    }
  }));
  for (const atc of current) atc.memberCountry = cached.get(atc.userId) ?? null;
}
