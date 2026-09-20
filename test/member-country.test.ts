import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enrichMemberCountries } from '../src/member-country';
import { resetTokenCache } from '../src/ivao';
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

  it.each([401, 404, 429, 500])('backs off unavailable profiles (%s) without failing notifications', async (status) => {
    network.mockImplementation(async () => new Response(null, { status }));
    const current = [controller()];
    await expect(enrichMemberCountries(current, {}, auth)).resolves.toBeUndefined();
    expect(current[0]?.memberCountry).toEqual({ countryId: null, expiresAt: NOW + 900_000 });
    await enrichMemberCountries([controller()], {}, auth);
    expect(network).toHaveBeenCalledTimes(1);
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
