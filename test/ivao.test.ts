import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAccessToken,
  isDivisionCallsign,
  isExcludedCallsign,
  hasFrequency,
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
