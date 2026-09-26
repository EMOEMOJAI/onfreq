import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enrichMemberCountries } from '../src/member-country';
import { resetTokenCache } from '../src/ivao';
import { TOKEN_KEY } from '../src/config';
import type { IvaoAuth, OnlineAtc, StateMap } from '../src/types';

const NOW = 1_800_000_000_000;
let values: Map<string, unknown>;
let auth: IvaoAuth;
let network: ReturnType<typeof vi.fn<typeof fetch>>;

function controller(userId = 100, callsign = 'QCTT_TWR'): OnlineAtc {
  return { sessionId: 1, userId, callsign, frequency: 118.1, position: 'TWR', station: null, location: null };
}

function previous(countryId: string | null, expiresAt = NOW + 60_000): StateMap {
  return { QCTT_TWR: { ...controller(), since: new Date(NOW).toISOString(), missed: 0,
    memberCountry: { countryId, expiresAt } } };
}

beforeEach(() => {
  resetTokenCache();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  values = new Map([['ivao-token-v1', { token: 'test-token', expiresAt: NOW + 600_000 }]]);
  auth = { clientId: 'test', clientSecret: 'test', kv: {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, raw: string) => { values.set(key, JSON.parse(raw)); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
  } as unknown as KVNamespace };
  network = vi.fn<typeof fetch>(async () => Response.json({ countryId: 'ca', divisionId: 'XX', publicNickname: 'Not stored' }));
  vi.stubGlobal('fetch', network);
});

afterEach(() => {
  resetTokenCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('member profile country enrichment', () => {
  it('uses authenticated profile country, deduplicates VIDs, and stores only country and expiry', async () => {
    const current = [controller(), controller(100, 'QCTT_GND')];
    await enrichMemberCountries(current, {}, auth);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]?.[0]).toBe('https://api.ivao.aero/v2/users/100');
    expect(network.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer test-token' });
    const expected = { countryId: 'CA', expiresAt: NOW + 86_400_000 };
    expect(current.map((atc) => atc.memberCountry)).toEqual([expected, expected]);
    expect(values.get('ivao-member-country-v1:100')).toEqual(expected);
  });

  it('reuses coordinator state without network or KV calls', async () => {
    const current = [controller()];
    await enrichMemberCountries(current, previous('BR'), auth);
    expect(current[0]?.memberCountry?.countryId).toBe('BR');
    expect(network).not.toHaveBeenCalled();
    expect(auth.kv.get).not.toHaveBeenCalled();
  });

  it('reuses the KV cache when the same member starts a different session', async () => {
    values.set('ivao-member-country-v1:100', { countryId: 'GB', expiresAt: NOW + 60_000 });
    const current = [controller(100, 'QESS_APP')];
    await enrichMemberCountries(current, {}, auth);
    expect(current[0]?.memberCountry?.countryId).toBe('GB');
    expect(network).not.toHaveBeenCalled();
  });

  it('does not inherit a previous controller country when a callsign changes VID', async () => {
    const current = [controller(200)];
    await enrichMemberCountries(current, previous('BR'), auth);
    expect(current[0]?.memberCountry?.countryId).toBe('CA');
    expect(network.mock.calls[0]?.[0]).toBe('https://api.ivao.aero/v2/users/200');
  });

  it('skips optional profile requests without credentials or before a frequency is tuned', async () => {
    const current = [controller()];
    await enrichMemberCountries(current, previous('BR'));
    expect(current[0]?.memberCountry).toBeNull();
    await enrichMemberCountries([{ ...controller(), frequency: 0 }], {}, auth);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([401, 404, 429, 500])('backs off unavailable profiles (%s) without failing notifications, and without persisting the failure to KV', async (status) => {
    network.mockImplementation(async () => new Response(null, { status }));
    const current = [controller()];
    await expect(enrichMemberCountries(current, {}, auth)).resolves.toBeUndefined();
    expect(current[0]?.memberCountry).toEqual({ countryId: null, expiresAt: NOW + 900_000 });
    expect(auth.kv.put).not.toHaveBeenCalled();
    // Nothing was written to KV, so a bare retry with no snapshot hits the network again...
    await enrichMemberCountries([controller()], {}, auth);
    expect(network).toHaveBeenCalledTimes(2);
    // ...but the coordinator snapshot carrying the backoff forward suppresses it, as in production.
    const state: StateMap = { QCTT_TWR: {
      ...controller(), since: new Date(NOW).toISOString(), missed: 0, memberCountry: current[0]!.memberCountry,
    } };
    await enrichMemberCountries([controller()], state, auth);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('stops the rest of the batch after a 401/403/429/5xx, but not after a 404', async () => {
    for (const status of [401, 403, 429, 500]) {
      values.set(TOKEN_KEY, { token: 'test-token', expiresAt: NOW + 600_000 });
      network.mockClear();
      network.mockImplementation(async () => new Response(null, { status }));
      const current = Array.from({ length: 3 }, (_, i) => controller(300 + i, `QCTT_${i}_TWR`));
      await enrichMemberCountries(current, {}, auth);
      expect(network).toHaveBeenCalledTimes(1);
    }
    for (const status of [404]) {
      values.set(TOKEN_KEY, { token: 'test-token', expiresAt: NOW + 600_000 });
      network.mockClear();
      network.mockImplementation(async () => new Response(null, { status }));
      const current = Array.from({ length: 3 }, (_, i) => controller(400 + i, `QDTT_${i}_TWR`));
      await enrichMemberCountries(current, {}, auth);
      expect(network).toHaveBeenCalledTimes(3);
    }
  });

  it('stops the rest of the batch after a thrown fetch error (timeout/network)', async () => {
    network.mockImplementation(async () => { throw new Error('upstream request timed out'); });
    const current = Array.from({ length: 3 }, (_, i) => controller(500 + i, `QCTT_${i}_APP`));
    await expect(enrichMemberCountries(current, {}, auth)).resolves.toBeUndefined();
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('gives ids skipped by a stopped run a short backoff instead of retrying them immediately', async () => {
    network.mockImplementation(async () => new Response(null, { status: 401 }));
    const current = Array.from({ length: 3 }, (_, i) => controller(600 + i, `QCTT_${i}_GND`));
    await enrichMemberCountries(current, {}, auth);
    expect(network).toHaveBeenCalledTimes(1);
    const skipped = current.slice(1);
    expect(skipped.every((atc) => (atc.memberCountry?.countryId ?? null) === null)).toBe(true);

    // Immediately after, the skipped ids must not be retried again: their
    // in-memory backoff keeps them out of the next lookup batch.
    network.mockClear();
    values.set(TOKEN_KEY, { token: 'test-token', expiresAt: NOW + 600_000 });
    network.mockImplementation(async () => Response.json({ countryId: 'ca' }));
    const state: StateMap = Object.fromEntries(current.map((atc) => [atc.callsign, {
      ...atc, since: new Date(NOW).toISOString(), missed: 0,
    }]));
    await enrichMemberCountries(current, state, auth);
    expect(network).not.toHaveBeenCalled();
  });

  it('rate-limits profile-401 token resets to at most once per ~30 minutes across many polls, even after an earlier mint', async () => {
    let clock = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // Every mint (the tracker feed's or a lookup's own) succeeds; every
    // profile lookup is rejected with a 401 regardless of how fresh its
    // token is — this must not reset the cache on every single poll.
    const tokenNetwork = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('token')) return Response.json({ access_token: 'brand-new', expires_in: 1800 });
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal('fetch', tokenNetwork);

    for (let i = 0; i < 20; i++) {
      await enrichMemberCountries([controller(800 + i, `QCTT_${i}_RMP`)], {}, auth);
      clock += 60_000; // one simulated poll per minute
    }
    expect(auth.kv.delete).toHaveBeenCalledTimes(1);

    // Once the ~30-minute window has elapsed, the next 401 resets again.
    clock += 29 * 60_000;
    vi.mocked(auth.kv.delete).mockClear();
    await enrichMemberCountries([controller(900, 'QCTT_RMP2')], {}, auth);
    expect(auth.kv.delete).toHaveBeenCalledTimes(1);
  });

  it('stops the batch within an overall lookup deadline even if no request itself has failed', async () => {
    let clock = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    network.mockImplementation(async () => {
      // Advance the clock past the deadline after the first lookup so the
      // remaining ids are skipped without any of them individually failing.
      clock += 11_000;
      return Response.json({ countryId: 'ca' });
    });
    const current = Array.from({ length: 3 }, (_, i) => controller(700 + i, `QCTT_${i}_DEL`));
    await enrichMemberCountries(current, {}, auth);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('resets the cached IVAO token (memory and KV) on a profile 401, but not on other statuses', async () => {
    network.mockImplementation(async () => new Response(null, { status: 401 }));
    await enrichMemberCountries([controller()], {}, auth);
    expect(auth.kv.delete).toHaveBeenCalledWith(TOKEN_KEY);
    expect(values.has(TOKEN_KEY)).toBe(false);

    values.set(TOKEN_KEY, { token: 'test-token', expiresAt: NOW + 600_000 });
    vi.mocked(auth.kv.delete).mockClear();
    network.mockImplementation(async () => new Response(null, { status: 500 }));
    await enrichMemberCountries([controller(101, 'QCTT_2_TWR')], {}, auth);
    expect(auth.kv.delete).not.toHaveBeenCalled();
  });

  it('keeps the last known country through a failed refresh', async () => {
    network.mockRejectedValue(new Error('Network failure'));
    const current = [controller()];
    await enrichMemberCountries(current, previous('BR', NOW - 1), auth);
    expect(current[0]?.memberCountry).toEqual({ countryId: 'BR', expiresAt: NOW + 900_000 });
  });

  it.each([{}, { countryId: null }, { countryId: 'not a code' }, { countryId: 'ZZ' }])(
    'omits missing or malformed countries: %j', async (body) => {
      network.mockImplementation(async () => Response.json(body));
      const current = [controller()];
      await enrichMemberCountries(current, {}, auth);
      expect(current[0]?.memberCountry?.countryId).toBeNull();
    },
  );

  it('bounds lookups per poll and picks remaining members on the next poll', async () => {
    const current = Array.from({ length: 8 }, (_, i) => controller(100 + i, `QCTT_${i}_TWR`));
    await enrichMemberCountries(current, {}, auth);
    expect(network).toHaveBeenCalledTimes(5);
    const state = Object.fromEntries(current.map((atc) => [atc.callsign, { ...atc, missed: 0, since: new Date(NOW).toISOString() }]));
    await enrichMemberCountries(current, state, auth);
    expect(network).toHaveBeenCalledTimes(8);
    expect(current.every((atc) => atc.memberCountry?.countryId === 'CA')).toBe(true);
  });

  it('retains the fetched country even if writing the optional cache fails', async () => {
    vi.mocked(auth.kv.put).mockRejectedValue(new Error('KV unavailable'));
    const current = [controller()];
    await expect(enrichMemberCountries(current, {}, auth)).resolves.toBeUndefined();
    expect(current[0]?.memberCountry?.countryId).toBe('CA');
  });
});
