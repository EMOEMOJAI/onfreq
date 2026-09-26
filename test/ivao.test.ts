import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchDivisionAtc,
  getAccessToken,
  isDivisionCallsign,
  isExcludedCallsign,
  hasFrequency,
  invalidateCachedToken,
  ivaoAuthFromEnv,
  normalizeAtc,
  parseExcludedCallsigns,
  parsePrefixes,
  resetTokenCache,
} from '../src/ivao';
import type { IvaoAtcSummaryEntry } from '../src/types';

describe('parsePrefixes', () => {
  it.each([undefined, '', ' , ,', '*', 'AA,bad-prefix', 'ABCDE', '12'])('rejects absent or malformed coverage: %s', (raw) => {
    expect(() => parsePrefixes(raw)).toThrow('FIR_PREFIXES');
  });

  it('parses, trims and uppercases a custom list', () => {
    expect(parsePrefixes(' qc, XA ,qj')).toEqual(['QC', 'XA', 'QJ']);
  });
});

describe('parseExcludedCallsigns', () => {
  it('parses into an uppercase exact-match set', () => {
    const set = parseExcludedCallsigns('XAHK_WMR_CTR, xahk_esu_ctr ,,XAHH_APS_APP');
    expect(set).toEqual(new Set(['XAHK_WMR_CTR', 'XAHK_ESU_CTR', 'XAHH_APS_APP']));
  });

  it('returns an empty set when unset', () => {
    expect(parseExcludedCallsigns(undefined)).toEqual(new Set());
    expect(parseExcludedCallsigns(' ')).toEqual(new Set());
  });
});

describe('isExcludedCallsign', () => {
  const excluded = parseExcludedCallsigns('XAHK_WMR_CTR');

  it.each(['QFKH_X_APP', 'QCTT_X_TWR', 'XAHK_X_CTR', 'qfkh_x_app'])(
    'excludes special position %s regardless of the list',
    (cs) => {
      expect(isExcludedCallsign(cs, excluded)).toBe(true);
      expect(isExcludedCallsign(cs, new Set())).toBe(true);
    },
  );

  it('excludes callsigns on the configured list', () => {
    expect(isExcludedCallsign('XAHK_WMR_CTR', excluded)).toBe(true);
    expect(isExcludedCallsign('xahk_wmr_ctr', excluded)).toBe(true);
  });

  it.each(['QFKH_APP', 'QCTT_TWR', 'XAHK_CTR', 'QFTP_X', 'X_QFTP_APP', 'QFKH_XX_APP'])(
    'keeps ordinary position %s',
    (cs) => {
      expect(isExcludedCallsign(cs, excluded)).toBe(false);
    },
  );
});

describe('isDivisionCallsign', () => {
  const prefixes = ['QC', 'QD', 'QE', 'QF', 'QG', 'XA', 'XB', 'QH']; // Synthetic test coverage.

  it.each([
    'QCTT_TWR',
    'QDAH_APP',
    'QERR_CTR',
    'QFTP_DEL',
    'QGLL_TWR',
    'XAHK_CTR',
    'XBMC_TWR',
    'QHTS_APP',
  ])('accepts monitored callsign %s', (cs) => {
    expect(isDivisionCallsign(cs, prefixes)).toBe(true);
  });

  it.each([
    'QJPE_CTR',
    'QKSS_GND',
    'QLKP_CTR',
    'QMUB_TWR',
    'EGLL_TWR',
    'VTBB_CTR',
    'KLAX_TWR',
    'WSSS_TWR',
  ])('rejects unmonitored callsign %s', (cs) => {
    expect(isDivisionCallsign(cs, prefixes)).toBe(false);
  });

  it('is case-insensitive on the callsign', () => {
    expect(isDivisionCallsign('qctt_twr', prefixes)).toBe(true);
  });
});

describe('getAccessToken', () => {
  function fakeKv() {
    const store = new Map<string, string>();
    return {
      store,
      get: vi.fn(async (key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) : null;
      }),
      put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
      delete: vi.fn(async (key: string) => void store.delete(key)),
    };
  }

  function auth(kv: ReturnType<typeof fakeKv>) {
    return { clientId: 'id', clientSecret: 'secret', kv: kv as unknown as KVNamespace };
  }

  function tokenResponse(token: string, expiresIn = 1800) {
    return Response.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn });
  }

  beforeEach(() => resetTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  it('requests a tracker-scoped token with the client credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    vi.stubGlobal('fetch', fetchMock);
    const kv = fakeKv();

    await expect(getAccessToken(auth(kv))).resolves.toBe('tok-1');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.ivao.aero/v2/oauth/token');
    expect(JSON.parse(init.body)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'id',
      client_secret: 'secret',
      scope: 'tracker',
    });
  });

  it('serves later calls from cache instead of re-authenticating', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    vi.stubGlobal('fetch', fetchMock);
    const kv = fakeKv();

    await getAccessToken(auth(kv));
    await getAccessToken(auth(kv));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reuses a token another isolate already cached in KV', async () => {
    const kv = fakeKv();
    kv.store.set(
      'ivao-token-v1',
      JSON.stringify({ token: 'from-kv', expiresAt: Date.now() + 600_000 }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAccessToken(auth(kv))).resolves.toBe('from-kv');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replaces a cached token that has expired', async () => {
    const kv = fakeKv();
    kv.store.set(
      'ivao-token-v1',
      JSON.stringify({ token: 'stale', expiresAt: Date.now() - 1000 }),
    );
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('fresh'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAccessToken(auth(kv))).resolves.toBe('fresh');
  });

  it('caches with a margin so the token is replaced before it actually expires', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse('tok', 1800)));
    const kv = fakeKv();

    await getAccessToken(auth(kv));
    const cached = JSON.parse(kv.store.get('ivao-token-v1') ?? '{}');
    const lifetimeMs = cached.expiresAt - Date.now();
    expect(lifetimeMs).toBeLessThan(1800_000);
    expect(lifetimeMs).toBeGreaterThan(1600_000);
  });

  it('throws when the credentials are rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));
    await expect(getAccessToken(auth(fakeKv()))).rejects.toThrow('IVAO token request failed');
  });

  it('clamps an out-of-range expires_in to the safe window instead of trusting it verbatim', async () => {
    // Mock Date.now so the expected expiresAt is deterministic: comparing
    // against a second, independent Date.now() call after the await was
    // flaky under real timers whenever the clock ticked between them.
    const now = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse('tok', 10)));
    const kv = fakeKv();
    await getAccessToken(auth(kv));
    const cached = JSON.parse(kv.store.get('ivao-token-v1') ?? '{}');
    // Minimum TTL sits above the safety margin, so the cached expiry always
    // lands in the future relative to when the token was minted.
    expect(cached.expiresAt).toBe(now + 180_000 - 120_000);
    dateNowSpy.mockRestore();
  });

  it.each([
    { access_token: '' },
    { access_token: 123 },
    { access_token: 'has space' },
    { access_token: 'has\ttab' },
    {},
  ])('rejects a malformed or missing access_token: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...body, expires_in: 1800 })));
    await expect(getAccessToken(auth(fakeKv()))).rejects.toThrow('no usable access_token');
  });

  it('accepts a well-formed access_token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse('valid-token.123~ABC')));
    await expect(getAccessToken(auth(fakeKv()))).resolves.toBe('valid-token.123~ABC');
  });

  it('always caches an expiry in the future relative to minting, even at the minimum TTL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse('tok', 1)));
    const kv = fakeKv();
    const before = Date.now();
    await getAccessToken(auth(kv));
    const cached = JSON.parse(kv.store.get('ivao-token-v1') ?? '{}');
    expect(cached.expiresAt).toBeGreaterThan(before);
  });

  it('ignores a malformed cached KV entry and mints a fresh token instead of trusting it', async () => {
    const kv = fakeKv();
    kv.store.set('ivao-token-v1', JSON.stringify({ token: 42, expiresAt: 'soon' }));
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('fresh'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAccessToken(auth(kv))).resolves.toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('backs off from re-minting for a while after a failure, instead of retrying every call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const kv = fakeKv();

    await expect(getAccessToken(auth(kv))).rejects.toThrow();
    await expect(getAccessToken(auth(kv))).rejects.toThrow('backoff');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the minted token even if writing it to KV fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse('tok-1')));
    const kv = fakeKv();
    kv.put.mockRejectedValueOnce(new Error('KV unavailable'));

    await expect(getAccessToken(auth(kv))).resolves.toBe('tok-1');
    await expect(getAccessToken(auth(kv))).resolves.toBe('tok-1');
  });
});

describe('invalidateCachedToken', () => {
  beforeEach(() => resetTokenCache());
  afterEach(() => vi.restoreAllMocks());

  it('rate-limits invalidation to at most once per ~30 minutes, regardless of caller', () => {
    let clock = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);

    expect(invalidateCachedToken()).toBe(true);
    clock += 60_000; // 1 minute later, well within the backoff
    expect(invalidateCachedToken()).toBe(false);
    clock += 28 * 60_000; // still short of 30 minutes total
    expect(invalidateCachedToken()).toBe(false);
    clock += 60_000; // now past the 30-minute window
    expect(invalidateCachedToken()).toBe(true);
  });
});

describe('ivaoAuthFromEnv', () => {
  it('returns undefined when either credential is missing', () => {
    expect(ivaoAuthFromEnv({ IVAO_CLIENT_ID: 'a' } as unknown as Env)).toBeUndefined();
    expect(ivaoAuthFromEnv({ IVAO_CLIENT_SECRET: 'b' } as unknown as Env)).toBeUndefined();
    expect(
      ivaoAuthFromEnv({ IVAO_CLIENT_ID: ' ', IVAO_CLIENT_SECRET: ' ' } as unknown as Env),
    ).toBeUndefined();
  });

  it('builds the auth config when both are present', () => {
    const env = { IVAO_CLIENT_ID: 'a', IVAO_CLIENT_SECRET: 'b', ATC_STATE: {} } as unknown as Env;
    expect(ivaoAuthFromEnv(env)).toMatchObject({ clientId: 'a', clientSecret: 'b' });
  });
});

describe('hasFrequency', () => {
  it('accepts a tuned frequency', () => {
    expect(hasFrequency({ frequency: 118.1 })).toBe(true);
  });

  it('rejects the 0.000 placeholder a freshly connected controller reports', () => {
    expect(hasFrequency({ frequency: 0 })).toBe(false);
    expect(hasFrequency({ frequency: -1 })).toBe(false);
    expect(hasFrequency({ frequency: Number.NaN })).toBe(false);
    expect(hasFrequency({ frequency: undefined as unknown as number })).toBe(false);
  });
});

describe('normalizeAtc', () => {
  it('normalizes an airport position using atcPosition', () => {
    const entry: IvaoAtcSummaryEntry = {
      id: 42,
      userId: 12345,
      callsign: 'QCTT_TWR',
      connectionType: 'ATC',
      atcSession: { frequency: 118.1, position: 'TWR' },
      atcPosition: {
        atcCallsign: 'Example City Tower',
        airport: { icao: 'QCTT', name: 'Example City / Example Airport', city: 'Example City', countryId: 'BR' },
      },
      subcenter: null,
    };
    expect(normalizeAtc(entry)).toEqual({
      sessionId: 42,
      userId: 12345,
      callsign: 'QCTT_TWR',
      frequency: 118.1,
      position: 'TWR',
      station: 'Example City Tower',
      location: 'Example City / Example Airport',
      airport: { icao: 'QCTT', countryId: 'BR' },
    });
  });

  it('normalizes a center position using subcenter', () => {
    const entry: IvaoAtcSummaryEntry = {
      id: 7,
      userId: 999,
      callsign: 'QCJJ_CTR',
      connectionType: 'ATC',
      atcSession: { frequency: 132.3, position: 'CTR' },
      atcPosition: null,
      subcenter: { atcCallsign: 'Example Control', centerId: 'QCJJ' },
    };
    const normalized = normalizeAtc(entry);
    expect(normalized.station).toBe('Example Control');
    expect(normalized.location).toBeNull();
  });

  it('tolerates missing position metadata', () => {
    const entry: IvaoAtcSummaryEntry = {
      id: 1,
      userId: 1,
      callsign: 'QJAA_TWR',
      connectionType: 'ATC',
      atcSession: { frequency: 118.5, position: 'TWR' },
      atcPosition: null,
      subcenter: null,
    };
    const normalized = normalizeAtc(entry);
    expect(normalized.station).toBeNull();
    expect(normalized.location).toBeNull();
  });
});

describe('fetchDivisionAtc', () => {
  function fakeKv(initial: Record<string, unknown> = {}) {
    const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
    return {
      store,
      get: vi.fn(async (key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) : null;
      }),
      put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
      delete: vi.fn(async (key: string) => void store.delete(key)),
    };
  }

  function auth(kv: ReturnType<typeof fakeKv>) {
    return { clientId: 'id', clientSecret: 'secret', kv: kv as unknown as KVNamespace };
  }

  function rawEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 1,
      userId: 100,
      callsign: 'QCTT_TWR',
      connectionType: 'ATC',
      atcSession: { frequency: 118.1, position: 'TWR' },
      atcPosition: { atcCallsign: 'Example Tower', airport: { icao: 'QCTT', name: 'Example Airport', countryId: 'BR' } },
      subcenter: null,
      ...over,
    };
  }

  beforeEach(() => resetTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  it('skips malformed entries and logs only a count, coercing a numeric frequency string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Padded with well-formed entries outside the QC prefix so malformed
    // entries stay a minority of the feed (otherwise this is a feed-outage,
    // covered separately below).
    const filler = Array.from({ length: 4 }, (_, i) => rawEntry({
      id: 1000 + i, userId: 1000 + i, callsign: `XA${i}_TWR`,
      atcPosition: null,
    }));
    const entries = [
      rawEntry({ callsign: 'QCTT_TWR' }),
      null,
      'not an object',
      { ...rawEntry({ callsign: 'QCTT_APP' }), id: 'not-a-number' },
      { ...rawEntry({ callsign: 'QCTT_GND' }), atcSession: { frequency: 'not-a-number', position: 'GND' } },
      { ...rawEntry({ callsign: 'QCTT_DEL' }), atcSession: { frequency: '121.500', position: 'DEL' } },
      ...filler,
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(entries)));

    const result = await fetchDivisionAtc(['QC']);
    expect(result.map((atc) => atc.callsign).sort()).toEqual(['QCTT_DEL', 'QCTT_TWR']);
    expect(result.find((atc) => atc.callsign === 'QCTT_DEL')?.frequency).toBe(121.5);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'ivao_entry_skipped', count: 4 }));
    // No entry content (callsigns, ids) ever reaches the log.
    expect(warn.mock.calls.every(([line]) => !String(line).includes('QCTT'))).toBe(true);
  });

  it('treats an all-malformed feed as an outage instead of a mass false offline', async () => {
    const entries = [null, 'not an object', { id: 'nope' }, { atcSession: null }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(entries)));
    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('feed outage');
  });

  it('treats a majority-malformed feed as an outage instead of a mass false offline', async () => {
    const entries = [
      rawEntry({ callsign: 'QCTT_TWR' }),
      null,
      'not an object',
      { id: 'nope' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(entries)));
    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('feed outage');
  });

  it('caps runaway string lengths from the feed', async () => {
    const longCallsign = `QCTT_${'A'.repeat(200)}_TWR`;
    const entries = [rawEntry({ callsign: longCallsign })];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(entries)));

    const [atc] = await fetchDivisionAtc(['QC']);
    expect(atc?.callsign.length).toBeLessThanOrEqual(32);
  });

  it('dedupes two sessions sharing a callsign, keeping the higher session id, and logs only a count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = [
      rawEntry({ id: 1, userId: 100, callsign: 'QCTT_TWR' }),
      rawEntry({ id: 2, userId: 200, callsign: 'qctt_twr' }),
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(entries)));

    const result = await fetchDivisionAtc(['QC']);
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe(200);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'ivao_duplicate_callsign', count: 1 }));
  });

  it('remints and retries exactly once after a 401 on an authenticated request', async () => {
    const kv = fakeKv({ 'ivao-token-v1': { token: 'stale', expiresAt: Date.now() + 600_000 } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'fresh', expires_in: 1800 }))
      .mockResolvedValueOnce(Response.json([rawEntry()]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchDivisionAtc(['QC'], auth(kv));
    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const secondCallHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(secondCallHeaders.authorization).toBe('Bearer fresh');
  });

  it('surfaces a second consecutive 401 instead of retrying forever', async () => {
    const kv = fakeKv({ 'ivao-token-v1': { token: 'stale', expiresAt: Date.now() + 600_000 } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'fresh', expires_in: 1800 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDivisionAtc(['QC'], auth(kv))).rejects.toThrow('IVAO API responded with 401');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 401 on an anonymous request, since it cannot be a token problem', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('IVAO API responded with 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to an anonymous request when the token mint fails, instead of taking the bot down', async () => {
    const kv = fakeKv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(Response.json([rawEntry()]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchDivisionAtc(['QC'], auth(kv));
    expect(result).toHaveLength(1);
    const headers = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('throws on a bad payload shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ not: 'an array' })));
    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('unexpected payload');
  });

  it('treats zero ATC worldwide as a feed outage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([])));
    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('feed outage');
  });

  it('tolerates a KV delete failure on the 401 path instead of failing the whole poll', async () => {
    const kv = fakeKv({ 'ivao-token-v1': { token: 'stale', expiresAt: Date.now() + 600_000 } });
    kv.delete.mockRejectedValueOnce(new Error('KV unavailable'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'fresh', expires_in: 1800 }))
      .mockResolvedValueOnce(Response.json([rawEntry()]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDivisionAtc(['QC'], auth(kv))).resolves.toHaveLength(1);
  });
});
