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
import { diffState } from '../src/state';
import { fakeKv, ivaoAuth as auth } from './helpers';
import type { IvaoAtcSummaryEntry, StateMap } from '../src/types';

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

  function tokenResponse(token: string, expiresIn = 1800) {
    return Response.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn });
  }

  beforeEach(() => resetTokenCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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

  it('re-mints instead of trusting a cached token that fails the access-token pattern', async () => {
    const kv = fakeKv();
    kv.store.set('ivao-token-v1', JSON.stringify({ token: 'bad token\r\nx', expiresAt: Date.now() + 600_000 }));
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('fresh'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAccessToken(auth(kv))).resolves.toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats an unparseable KV cache entry as a miss and logs no fragment of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kv = fakeKv();
    kv.store.set('ivao-token-v1', 'synthetic-cached-secret{');
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('fresh'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAccessToken(auth(kv))).resolves.toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'ivao_token_cache_read_failed' }));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('synthetic-cached-secret');
    warn.mockRestore();
  });

  it.each([
    new Response('synthetic-leaked-token-fragment', { status: 200 }),
    new Response('{"access_token":"synthetic-leaked-token-fragment', { status: 200 }),
  ])('fails with a fixed message when the token response is not JSON, never quoting it', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const err = await getAccessToken(auth(fakeKv())).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('IVAO token response was not valid JSON');
    expect(String(err)).not.toContain('synthetic-leaked');
  });

  it('rejects a JSON null token response as unusable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(null)));
    await expect(getAccessToken(auth(fakeKv()))).rejects.toThrow('no usable access_token');
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

  function rawEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 1,
      userId: 100,
      callsign: 'QCTT_TWR',
      // Present in the real feed; ignored by the sanitizer.
      connectionType: 'ATC',
      atcSession: { frequency: 118.1, position: 'TWR' },
      atcPosition: { atcCallsign: 'Example Tower', airport: { icao: 'QCTT', name: 'Example Airport', countryId: 'BR' } },
      subcenter: null,
      ...over,
    };
  }

  beforeEach(() => resetTokenCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('skips malformed entries and logs only counts, coercing numeric and unusable frequencies', async () => {
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
    expect(result.map((atc) => atc.callsign).sort()).toEqual(['QCTT_DEL', 'QCTT_GND', 'QCTT_TWR']);
    expect(result.find((atc) => atc.callsign === 'QCTT_DEL')?.frequency).toBe(121.5);
    // An unusable frequency reads as untuned rather than dropping the entry.
    expect(result.find((atc) => atc.callsign === 'QCTT_GND')?.frequency).toBe(0);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'ivao_entry_skipped', count: 3 }));
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'ivao_frequency_coerced', count: 1 }));
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
    const entries = [rawEntry({
      atcSession: { frequency: 118.1, position: `T${'W'.repeat(300)}R` },
      atcPosition: { atcCallsign: 'S'.repeat(300), airport: { icao: 'QCTT', name: 'N'.repeat(300), countryId: 'BR' } },
    })];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(entries)));

    const [atc] = await fetchDivisionAtc(['QC']);
    expect(atc?.position.length).toBeLessThanOrEqual(128);
    expect(atc?.station?.length).toBeLessThanOrEqual(128);
    expect(atc?.location?.length).toBe(128);
  });

  it.each(['QCTTTTTTTTTT', 'QC', 'QC\u200DTT', 'QC TT', 'QC_T', '**Q', 'QC\nT', '<@&1>', '\uFF31\uFF23\uFF34\uFF34', ''])(
    'drops an airport whose ICAO is not 3-4 letters/digits: %j', async (icao) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([rawEntry({
        atcPosition: { atcCallsign: 'Example Tower', airport: { icao, name: 'Example Airport', countryId: 'BR' } },
      })])));
      const [atc] = await fetchDivisionAtc(['QC']);
      // The entry is kept; only the untrusted airport is discarded.
      expect(atc?.callsign).toBe('QCTT_TWR');
      expect(atc?.station).toBe('Example Tower');
      expect(atc?.airport).toBeNull();
      expect(atc?.location).toBeNull();
    });

  it.each([['qctt', 'QCTT'], [' qc1 ', 'QC1'], ['Q2T4', 'Q2T4']])(
    'accepts airport ICAO %j as %j after uppercasing', async (icao, expected) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([rawEntry({
        atcPosition: { atcCallsign: 'Example Tower', airport: { icao, name: 'Example Airport', countryId: 'br' } },
      })])));
      const [atc] = await fetchDivisionAtc(['QC']);
      expect(atc?.airport).toEqual({ icao: expected, countryId: 'BR' });
    });

  /** Valid entries outside the QC prefix keep rejected entries a minority of the feed. */
  function filler(count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, i) => rawEntry({
      id: 5000 + i, userId: 5000 + i, callsign: `XA${i}_TWR`, atcPosition: null,
    }));
  }

  it.each([
    `QCTT_${'A'.repeat(200)}_TWR`, 'Q', 'QCTT TWR', 'QCTT.TWR', 'QCTT_<@&1>', 'QCTT\n_TWR', 'QCTT_TWR\u202E', 'QCTT_TŴR',
  ])('rejects a callsign that is not a plain 2-32 character identifier: %j', async (callsign) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([rawEntry({ callsign }), ...filler(2)])));
    await expect(fetchDivisionAtc(['QC'])).resolves.toEqual([]);
  });

  it.each(['__proto__', '__QCTT_TWR', '__'])('rejects a callsign %j starting with a double underscore', async (callsign) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([rawEntry({ callsign }), ...filler(2)])));
    // The prefix would otherwise admit it, so only the callsign check can drop it.
    await expect(fetchDivisionAtc(['__'])).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'ivao_entry_skipped', count: 1 }));
  });

  it.each(['QC-TT_TWR', 'qctt_twr', 'QC12_A_CTR', `QC${'A'.repeat(30)}`, 'QC__TWR', 'QC_'])('keeps a well-formed callsign: %j', async (callsign) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([rawEntry({ callsign })])));
    await expect(fetchDivisionAtc(['QC'])).resolves.toHaveLength(1);
  });

  it.each([
    { id: 0 }, { id: -1 }, { id: 1.5 }, { id: 1e300 }, { id: 2 ** 53 },
    { userId: 0 }, { userId: -100 }, { userId: 100.25 }, { userId: 1e300 }, { userId: '100' },
  ])('rejects a session or member id that is not a positive safe integer: %j', async (ids) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([rawEntry(ids), ...filler(2)])));
    await expect(fetchDivisionAtc(['QC'])).resolves.toEqual([]);
  });

  it.each<unknown>(['0x7B', '1e3', '-118.1', '118.1000', 'Infinity', '118.', '.5', '1180', '118,1', '-0', '', null,
    undefined, true, {}, { mhz: 118.1 }, [118.1]])(
    'keeps an entry whose frequency %j is not plain decimal MHz as untuned (0), logging only a count', async (frequency) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const entries = [rawEntry({ atcSession: { frequency, position: 'TWR' } }), ...filler(2)];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(entries)));
      const result = await fetchDivisionAtc(['QC']);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ callsign: 'QCTT_TWR', frequency: 0 });
      expect(hasFrequency(result[0]!)).toBe(false);
      expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'ivao_frequency_coerced', count: 1 })]]);
    });

  it('logs one coerced-frequency count per parse, however many entries were coerced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([
      rawEntry({ id: 1, callsign: 'QCTT_TWR', atcSession: { frequency: null, position: 'TWR' } }),
      rawEntry({ id: 2, callsign: 'QCTT_APP', atcSession: { frequency: '118.', position: 'APP' } }),
      rawEntry({ id: 3, callsign: 'QCTT_GND', atcSession: { frequency: 5000, position: 'GND' } }),
      rawEntry({ id: 4, callsign: 'QCTT_DEL', atcSession: { frequency: 0, position: 'DEL' } }),
      ...filler(3),
    ])));
    await expect(fetchDivisionAtc(['QC'])).resolves.toHaveLength(4);
    expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'ivao_frequency_coerced', count: 3 })]]);
  });

  it('treats a feed whose frequencies are all unusable as an outage instead of a silent success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([
      rawEntry({ id: 1, callsign: 'QCTT_TWR', atcSession: { frequency: 'x', position: 'TWR' } }),
      ...filler(3).map((entry) => ({ ...entry, atcSession: { frequency: 'x', position: 'TWR' } })),
    ])));
    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('feed outage');
    // Counts only, never entry content.
    expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'ivao_frequency_coerced', count: 4 })]]);
  });

  it('treats skipped plus coerced entries together forming a majority as an outage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([
      rawEntry({ id: 1, callsign: 'QCTT_TWR', atcSession: { frequency: 'x', position: 'TWR' } }),
      null,
      rawEntry({ id: 2, callsign: 'QCTT_APP', atcSession: { frequency: 118.1, position: 'APP' } }),
    ])));
    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('feed outage');
  });

  it('keeps polling when only a minority of frequencies are coerced, or all are a genuine 0', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([
      rawEntry({ id: 1, callsign: 'QCTT_TWR', atcSession: { frequency: 'x', position: 'TWR' } }),
      rawEntry({ id: 2, callsign: 'QCTT_APP', atcSession: { frequency: 118.1, position: 'APP' } }),
    ])));
    // Exactly half is not a majority.
    await expect(fetchDivisionAtc(['QC'])).resolves.toHaveLength(2);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([
      rawEntry({ id: 1, callsign: 'QCTT_TWR', atcSession: { frequency: 0, position: 'TWR' } }),
      rawEntry({ id: 2, callsign: 'QCTT_APP', atcSession: { frequency: '0.000', position: 'APP' } }),
    ])));
    await expect(fetchDivisionAtc(['QC'])).resolves.toHaveLength(2);
  });

  it.each([['118', 118], ['118.1', 118.1], [' 121.500 ', 121.5], ['99.9', 99.9], ['3.5', 3.5], ['1', 1], ['999.999', 999.999]])(
    'accepts a decimal MHz frequency string %j', async (frequency, expected) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([
        rawEntry({ atcSession: { frequency, position: 'TWR' } }),
      ])));
      const [atc] = await fetchDivisionAtc(['QC']);
      expect(atc?.frequency).toBe(expected);
    });

  it.each<[unknown, number, boolean]>([
    ['0', 0, false], ['0.000', 0, false], [' 0.0 ', 0, false], ['000', 0, false], [0, 0, false],
    [-118.1, 0, true], [1000, 0, true], [1e300, 0, true], [999.999, 999.999, false],
    // Below one kHz a positive number would render as 0.000 MHz: untuned, and coerced.
    [5e-324, 0, true], [1e-4, 0, true], [0.0009, 0, true], [0.001, 0.001, false],
  ])('keeps an entry with frequency %j as %j instead of dropping it (coerced: %j)', async (frequency, expected, coerced) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([
      rawEntry({ atcSession: { frequency, position: 'TWR' } }),
      ...filler(2),
    ])));
    const [atc] = await fetchDivisionAtc(['QC']);
    expect(atc?.frequency).toBe(expected);
    expect(hasFrequency(atc!)).toBe(expected > 0);
    // A genuine 0 is the feed's untuned marker; only an implausible value counts as coerced.
    expect(warn.mock.calls).toEqual(coerced ? [[JSON.stringify({ event: 'ivao_frequency_coerced', count: 1 })]] : []);
  });

  it.each<unknown>(['0.000', '0', 1e300, null, '118.', '118.1000', {}, 'garbage'])(
    'keeps a tracked session online at its last frequency when the feed reports %j', async (frequency) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([
        rawEntry({ atcSession: { frequency, position: 'TWR' } }),
        ...filler(2),
      ])));
      const current = await fetchDivisionAtc(['QC']);
      const prev: StateMap = {
        QCTT_TWR: { ...current[0]!, frequency: 118.1, since: '2026-08-16T10:00:00.000Z', missed: 0,
          messages: [{ channelId: '100000000000000123', messageId: '100000000000000999' }] },
      };
      const result = diffState(prev, current, '2026-08-16T12:00:00.000Z', 1);
      expect(result.wentOffline).toEqual([]);
      expect(result.wentOnline).toEqual([]);
      expect(result.next.QCTT_TWR).toMatchObject({ frequency: 118.1, since: '2026-08-16T10:00:00.000Z', missed: 0 });
      expect(result.next.QCTT_TWR?.pending).toBeUndefined();
    });

  it('strips Unicode line and paragraph separators from feed text at ingest', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([rawEntry({
      atcPosition: { atcCallsign: 'Example\u2028QXXX_TWR Fake\u2029Tower', airport: { icao: 'QCTT', name: 'A\u2029B', countryId: 'BR' } },
    })])));
    const [atc] = await fetchDivisionAtc(['QC']);
    expect(atc?.station).toBe('Example QXXX_TWR Fake Tower');
    expect(atc?.location).toBe('A B');
  });

  it('never splits a surrogate pair when capping feed text', async () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([rawEntry({
      atcPosition: {
        atcCallsign: `${'S'.repeat(127)}\u{1F600}`,
        airport: { icao: 'QCTT', name: `${'N'.repeat(126)}\u{1F600}x`, countryId: 'BR' },
      },
    })])));
    const [atc] = await fetchDivisionAtc(['QC']);
    expect(atc?.station).toBe('S'.repeat(127));
    expect(atc?.location).toBe(`${'N'.repeat(126)}\u{1F600}`);
    expect(`${atc?.station}${atc?.location}`).not.toMatch(lone);
  });

  it('replaces unpaired surrogates in feed text at ingest, keeping valid pairs', async () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const body = JSON.stringify([rawEntry({
      atcSession: { frequency: 118.1, position: 'TW\uD800R' },
      atcPosition: { atcCallsign: 'Example\uDC00Tower \u{1F600}', airport: { icao: 'QCTT', name: '\uDBFFA\uD83D', countryId: 'BR' } },
    })]);
    // JSON.stringify escapes lone surrogates, so they reach the parser intact.
    expect(body).toContain('\\ud800');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const [atc] = await fetchDivisionAtc(['QC']);
    // Compared as escaped JSON so a regression's failure report never itself
    // carries a lone surrogate (which the test runner cannot transport).
    const escaped = (text: string | null | undefined) => JSON.stringify(text);
    expect(escaped(atc?.position)).toBe(escaped('TW R'));
    expect(escaped(atc?.station)).toBe(escaped('Example Tower \u{1F600}'));
    expect(escaped(atc?.location)).toBe(escaped(' A '));
    expect(lone.test(`${atc?.position}${atc?.station}${atc?.location}`)).toBe(false);
  });

  it('strips control and invisible format characters from feed text at ingest', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([rawEntry({
      atcSession: { frequency: 118.1, position: 'TW\u200BR' },
      atcPosition: {
        atcCallsign: 'Example\r\nQXXX_TWR  Fake Tower  118.100\u0007',
        airport: { icao: 'QCTT', name: 'Safe\u202Eevil\u202C Airport\u2066', countryId: 'BR' },
      },
    })])));
    const [atc] = await fetchDivisionAtc(['QC']);
    expect(atc?.station).toBe('Example  QXXX_TWR  Fake Tower  118.100 ');
    expect(atc?.location).toBe('Safeevil Airport');
    expect(atc?.position).toBe('TWR');
    expect(atc?.airport?.icao).toBe('QCTT');
    expect(`${atc?.station}${atc?.location}${atc?.position}`).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it('accepts a whole-network feed larger than the default response cap', async () => {
    const entries = [rawEntry(), ...filler(3).map((entry) => ({ ...entry, padding: 'x'.repeat(512 * 1024) }))];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(entries)));
    await expect(fetchDivisionAtc(['QC'])).resolves.toHaveLength(1);
  });

  it('rejects a feed beyond its own 2 MiB size cap as a failed request', async () => {
    const entries = [rawEntry(), { padding: 'x'.repeat(2 * 1024 * 1024) }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(entries)));
    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('upstream response exceeded size limit');
  });

  it.each(['<html>synthetic-private-upstream-detail</html>', '[{"id":1,"callsign":"synthetic-private-upstream-detail"', ''])(
    'fails a 2xx feed whose body is not JSON with a fixed message that never quotes the body: %j', async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
      const err = await fetchDivisionAtc(['QC']).then(() => null, (e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toBe('IVAO API returned invalid JSON');
      expect(String(err)).not.toContain('synthetic-private-upstream-detail');
    });

  it('treats a feed with more than 20000 entries as an outage before sanitising any of them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(Array.from({ length: 20_001 }, () => 0))));
    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('IVAO API returned too many entries; treating as feed outage');
    expect(warn).not.toHaveBeenCalled();
    // At the limit the feed is sanitised as usual (here: all malformed, a different outage).
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(Array.from({ length: 20_000 }, () => 0))));
    await expect(fetchDivisionAtc(['QC'])).rejects.toThrow('mostly failed validation');
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
    expect(result[0]?.callsign).toBe('QCTT_TWR');
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'ivao_duplicate_callsign', count: 1 }));
  });

  it('uppercases feed callsigns so a case variant resumes the tracked session instead of splitting it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([
      rawEntry({ callsign: 'qctt_Twr' }),
    ])));
    const current = await fetchDivisionAtc(['QC']);
    expect(current.map((atc) => atc.callsign)).toEqual(['QCTT_TWR']);
    const prev: StateMap = {
      QCTT_TWR: { ...current[0]!, since: '2026-08-16T10:00:00.000Z', missed: 0,
        messages: [{ channelId: '100000000000000123', messageId: '100000000000000999' }] },
    };
    const result = diffState(prev, current, '2026-08-16T12:00:00.000Z', 1);
    expect(result.wentOnline).toEqual([]);
    expect(result.wentOffline).toEqual([]);
    expect(Object.keys(result.next)).toEqual(['QCTT_TWR']);
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

  it('does not let a profile 401 discard the token just reminted after a tracker 401', async () => {
    const kv = fakeKv({ 'ivao-token-v1': { token: 'stale', expiresAt: Date.now() + 600_000 } });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'fresh', expires_in: 1800 }))
      .mockResolvedValueOnce(Response.json([rawEntry()])));
    await fetchDivisionAtc(['QC'], auth(kv));
    expect(invalidateCachedToken()).toBe(false);
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
