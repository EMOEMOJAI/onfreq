import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigInvalidLogForTests } from '../src/auth';
import { COORDINATOR_NAME } from '../src/config';
import { ensureGcaRecordsSchema, GCA_NONCE_CAP } from '../src/gca-records';
import { gcaKeyId, resetGcaRecordsHttpForTests } from '../src/gca-records-http';
import { HISTORY_AUTH_HEADERS } from './helpers';
import {
  KEY, NEXT_KEY, ORIGIN, recordBody, recordRows, recordsEnv, sha256, sign, START, viaSelf, viaWorker, type Signed,
} from './gca-signing';

// The fixed shared vectors with synthetic regions AA-AD (plan R234), copied verbatim. They
// were computed independently with Node crypto; the Web Crypto test signer reproduces them.
const VECTOR = {
  keyId: '839683debc9ccbd0',
  ts: '1767225600000',
  nonce: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  putBody: '{"approvals":{"100001":[{"level":3,"region":"AA"}],"100002":[{"level":1,"region":"AB"},' +
    '{"level":2,"region":"AC"}],"4294967297":[],"99999":[{"level":1,"region":"AD"}]},"baseVersion":null,' +
    '"homeOverrides":{"100002":"AB"}}',
  putBodySha256: '61490ab28c8d1f54312a2ee12cae59aea452822e8c2de7abadc62d1df4eab8ee',
  digest: 'cb3fc08995ac559f69196f1a11c2fdf9204f869b6dfd744a6db7e4d83caafb7b',
  put: '126c1478b4d0e5ba50b59b81a84c183c92120282815f64ceaf82cbaacfe410c3',
  meta: '051c715e692615e079cf78065210834f1a0a258471163fc0fd54a60e6f244054',
  purge: '3a638cc7bd5f92661a2339f2a68eca7f457dc981de015dd8b29f1959cad57b9c',
};

/** A request carrying the vector headers exactly as published (not re-signed here). */
function vectorRequest(method: string, path: string, signature: string, body?: string): Signed {
  return {
    url: `${ORIGIN}${path}`, nonce: VECTOR.nonce, signature,
    init: {
      method, body,
      headers: {
        'x-xe-gca-key-id': VECTOR.keyId, 'x-xe-gca-timestamp': VECTOR.ts, 'x-xe-gca-nonce': VECTOR.nonce,
        'x-xe-gca-signature': signature,
      },
    },
  };
}

let now: number;
let errors: { mock: { calls: unknown[][] } };

const logged = () => errors.mock.calls.map(([line]) => String(line));
const meta = (options = {}) => sign('GET', '/gca/records/meta', options);
const purge = (options = {}) => sign('POST', '/gca/records/history/purge', options);
const put = (body: string, options = {}) => sign('PUT', '/gca/records', { body, ...options });

async function expectUnauthorized(response: Response) {
  expect(response.status).toBe(401);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'unauthorized' });
}

beforeEach(() => {
  now = START;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  resetConfigInvalidLogForTests();
  resetGcaRecordsHttpForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('fixed shared vectors, end to end with the synthetic key binding and a pinned clock', () => {
  it('derives key id 839683debc9ccbd0 from the bound key', async () => {
    expect(await gcaKeyId(KEY)).toBe(VECTOR.keyId);
    expect((env as { GCA_ADMIN_HMAC_KEY?: string }).GCA_ADMIN_HMAC_KEY).toBe(KEY);
    expect(await sha256(VECTOR.putBody)).toBe(VECTOR.putBodySha256);
    // The test signer reproduces every published signature from the contract.
    const signed = await put(VECTOR.putBody, { ts: Number(VECTOR.ts), nonce: VECTOR.nonce });
    expect(signed.signature).toBe(VECTOR.put);
    expect((await meta({ ts: Number(VECTOR.ts), nonce: VECTOR.nonce })).signature).toBe(VECTOR.meta);
    expect((await purge({ ts: Number(VECTOR.ts), nonce: VECTOR.nonce })).signature).toBe(VECTOR.purge);
  });

  it('accepts the published PUT signature and stores the published digest', async () => {
    const response = await viaWorker(vectorRequest('PUT', '/gca/records', VECTOR.put, VECTOR.putBody));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ version: '1', digest: VECTOR.digest, updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(logged()).toEqual([]);
  });

  it('accepts the published PUT signature via SELF.fetch (503 regions invalid: GCA_REGIONS is unset there), then refuses its replay', async () => {
    const request = vectorRequest('PUT', '/gca/records', VECTOR.put, VECTOR.putBody);
    const first = await viaSelf(request);
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'gca regions invalid' });
    expect(await recordRows()).toEqual({ current: 0, history: 0, nonces: 1, writes: 1 });
    // The same signed request through a second SELF.fetch: the nonce was consumed.
    await expectUnauthorized(await viaSelf(request));
    expect(await recordRows()).toEqual({ current: 0, history: 0, nonces: 1, writes: 1 });
  });

  it('accepts the published meta signature via SELF.fetch', async () => {
    const response = await viaSelf(vectorRequest('GET', '/gca/records/meta', VECTOR.meta));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      version: null, digest: null, updatedAt: null, counts: { approvals: 0, homeOverrides: 0 }, source: 'secrets',
    });
    await expectUnauthorized(await viaSelf(vectorRequest('GET', '/gca/records/meta', VECTOR.meta)));
  });

  it('accepts the published purge signature via SELF.fetch', async () => {
    const response = await viaSelf(vectorRequest('POST', '/gca/records/history/purge', VECTOR.purge));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, kept: 0 });
  });

  it('refuses each vector signature on another route, body, time or nonce', async () => {
    const cases: Signed[] = [
      vectorRequest('POST', '/gca/records/history/purge', VECTOR.meta),
      vectorRequest('PUT', '/gca/records', VECTOR.put, VECTOR.putBody.replace('"AA"', '"AC"')),
      { ...vectorRequest('GET', '/gca/records/meta', VECTOR.meta) },
    ];
    (cases[2]!.init.headers as Record<string, string>)['x-xe-gca-nonce'] = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5c';
    for (const request of cases) await expectUnauthorized(await viaWorker(request));
    now = START + 1;
    const shifted = vectorRequest('GET', '/gca/records/meta', VECTOR.meta);
    (shifted.init.headers as Record<string, string>)['x-xe-gca-timestamp'] = String(START + 1);
    await expectUnauthorized(await viaWorker(shifted));
    expect(await recordRows()).toEqual({ current: 0, history: 0, nonces: 0, writes: 0 });
  });
});

describe('authentication before any coordinator state', () => {
  it('a flood of bad-signature requests leaves 0 nonce and 0 write rows; the next signed PUT is 200', async () => {
    const badSignature = '0'.repeat(64);
    for (let i = 0; i < 40; i++) {
      const signed = await put(recordBody(), { headers: { 'x-xe-gca-signature': badSignature } });
      await expectUnauthorized(await viaSelf(signed));
      await expectUnauthorized(await viaSelf(await purge({ key: 'synthetic-wrong-key-not-configured-0000000' })));
    }
    expect(await recordRows()).toEqual({ current: 0, history: 0, nonces: 0, writes: 0 });
    const response = await viaWorker(await put(recordBody()));
    expect(response.status).toBe(200);
    expect(await recordRows()).toEqual({ current: 1, history: 1, nonces: 1, writes: 1 });
  });

  it('accepts timestamps within +-300 000 ms and refuses +-300 001 and malformed ones', async () => {
    for (const ts of [START - 300_000, START + 300_000]) expect((await viaSelf(await meta({ ts }))).status).toBe(200);
    for (const ts of [START - 300_001, START + 300_001]) await expectUnauthorized(await viaSelf(await meta({ ts })));
    for (const ts of ['0', '01767225600000', '176722560000', '17672256000000', '1767225600000.0', '1767225600000x',
      '-1767225600000', '1.767225600000e12', '']) {
      await expectUnauthorized(await viaSelf(await meta({ headers: { 'x-xe-gca-timestamp': ts } })));
    }
    expect(await recordRows()).toMatchObject({ nonces: 2, writes: 0 });
  });

  it('gives an identical 401 for an unknown key id, bad signatures and bad headers', async () => {
    const good = await meta();
    const variants: Record<string, string | null>[] = [
      { 'x-xe-gca-key-id': '0123456789abcdef' },
      { 'x-xe-gca-key-id': '839683DEBC9CCBD0' },
      { 'x-xe-gca-key-id': null },
      { 'x-xe-gca-signature': good.signature.toUpperCase() },
      { 'x-xe-gca-signature': [...good.signature].reverse().join('') },
      { 'x-xe-gca-signature': good.signature.slice(0, 63) },
      { 'x-xe-gca-signature': `${good.signature}0` },
      { 'x-xe-gca-signature': `${good.signature.slice(0, 63)}g` },
      { 'x-xe-gca-signature': null },
      { 'x-xe-gca-nonce': good.nonce.toUpperCase() },
      { 'x-xe-gca-nonce': '3f1c2b4a-5d6e-1f70-8a9b-0c1d2e3f4a5b' },
      { 'x-xe-gca-nonce': null },
      { 'x-xe-gca-timestamp': null },
    ];
    const bodies = new Set<string>();
    for (const headers of variants) {
      const response = await viaSelf(await meta({ headers, nonce: good.nonce }));
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
    expect(await recordRows()).toMatchObject({ nonces: 0, writes: 0 });
    // Logs carry fixed reasons only, once per reason: never a nonce, key id or signature.
    expect(logged().map((line) => JSON.parse(line))).toEqual([
      { event: 'gca_records_rejected', reason: 'unknown_key_id' },
      { event: 'gca_records_rejected', reason: 'headers_invalid' },
      { event: 'gca_records_rejected', reason: 'signature_mismatch' },
    ]);
    const text = logged().join('\n');
    for (const secret of [good.nonce, good.signature, '839683debc9ccbd0', KEY]) expect(text).not.toContain(secret);
  });

  it('accepts both the current and the next key, and never a key id with the other key\'s signature', async () => {
    expect((await viaSelf(await meta({ key: KEY }))).status).toBe(200);
    expect((await viaSelf(await meta({ key: NEXT_KEY }))).status).toBe(200);
    const crossed = await meta({ key: KEY, headers: { 'x-xe-gca-key-id': await gcaKeyId(NEXT_KEY) } });
    await expectUnauthorized(await viaSelf(crossed));
    // Without a next key configured, the next key no longer verifies.
    await expectUnauthorized(await viaWorker(await meta({ key: NEXT_KEY }), recordsEnv({ GCA_ADMIN_HMAC_KEY_NEXT: '' })));
  });

  it('refuses a replay through a second SELF.fetch with the same 401', async () => {
    const signed = await meta();
    expect((await viaSelf(signed)).status).toBe(200);
    await expectUnauthorized(await viaSelf(signed));
    expect(logged().map((line) => JSON.parse(line))).toEqual([{ event: 'gca_records_rejected', reason: 'replay' }]);
  });

  it('refuses the 31st write in a sliding hour with 429', async () => {
    for (let i = 0; i < 30; i++) expect((await viaSelf(await purge())).status).toBe(200);
    const refused = await viaSelf(await purge());
    expect(refused.status).toBe(429);
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(await refused.json()).toEqual({ error: 'rate_limited' });
    expect((await viaWorker(await put(recordBody()))).status).toBe(429);
    // Meta is not a write.
    expect((await viaSelf(await meta())).status).toBe(200);
    // An hour after the first write, one more fits.
    now = START + 3_600_001;
    expect((await viaSelf(await purge())).status).toBe(200);
  });

  it('refuses a new nonce at the nonce cap with 429 while an old replay is still 401', async () => {
    const first = await meta();
    expect((await viaSelf(first)).status).toBe(200);
    await runInDurableObject(env.POLL_COORDINATOR.getByName(COORDINATOR_NAME), (_instance, ctx) => {
      ensureGcaRecordsSchema(ctx.storage.sql);
      for (let i = 1; i < GCA_NONCE_CAP; i++) {
        ctx.storage.sql.exec('INSERT INTO gca_records_nonces (nonce, expires_at) VALUES (?, ?)', `seed-${i}`, START + 600_000);
      }
    });
    const capped = await viaSelf(await meta());
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: 'rate_limited' });
    await expectUnauthorized(await viaSelf(first));
  });
});

describe('key configuration (503 endpoint disabled) and reuse checks both ways', () => {
  const POLL = 'synthetic-poll-only-secret-0123456789';
  const HISTORY = 'synthetic-history-only-secret-01234567';
  const OTHER = 'synthetic-other-secret-value-0123456789';
  // One character too short each.
  const short = KEY.slice(0, 31);
  const shortNext = NEXT_KEY.slice(0, 31);
  const disabledCases: [string, Partial<Env>, string][] = [
    ['primary unset', { GCA_ADMIN_HMAC_KEY: undefined, GCA_ADMIN_HMAC_KEY_NEXT: '' }, 'GCA_ADMIN_HMAC_KEY_unset'],
    ['primary empty', { GCA_ADMIN_HMAC_KEY: '  ', GCA_ADMIN_HMAC_KEY_NEXT: '' }, 'GCA_ADMIN_HMAC_KEY_unset'],
    ['primary of 31 characters', { GCA_ADMIN_HMAC_KEY: short }, 'GCA_ADMIN_HMAC_KEY_too_short'],
    ['next of 31 characters', { GCA_ADMIN_HMAC_KEY_NEXT: shortNext }, 'GCA_ADMIN_HMAC_KEY_NEXT_too_short'],
    ['next equal to current', { GCA_ADMIN_HMAC_KEY_NEXT: ` ${KEY} ` }, 'GCA_ADMIN_HMAC_KEY_NEXT_equals_GCA_ADMIN_HMAC_KEY'],
    ...(['POLL_SECRET', 'HISTORY_SECRET', 'IVAO_WEBHOOK_SECRET', 'IVAO_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'] as const)
      .flatMap((name): [string, Partial<Env>, string][] => [
        [`current equal to ${name}`, { [name]: ` ${KEY}\n` }, `GCA_ADMIN_HMAC_KEY_reuses_${name}`],
        [`next equal to ${name}`, { [name]: NEXT_KEY }, `GCA_ADMIN_HMAC_KEY_NEXT_reuses_${name}`],
      ]),
  ];

  it.each(disabledCases)('%s -> 503 before any header check, logged once by name only', async (_label, overrides, reason) => {
    const config = recordsEnv({ POLL_SECRET: POLL, HISTORY_SECRET: HISTORY, ...overrides });
    for (const request of [await meta(), await meta(), { url: `${ORIGIN}/gca/records/meta`, init: {} } as Signed,
      await put(recordBody())]) {
      const response = await viaWorker(request, config);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'endpoint disabled' });
    }
    expect(logged().map((line) => JSON.parse(line))).toEqual([
      { event: 'config_invalid', reason },
      { event: 'gca_records_rejected', reason: 'endpoint_disabled' },
    ]);
    for (const secret of [KEY, NEXT_KEY, short, shortNext]) expect(logged().join('\n')).not.toContain(secret);
    expect(await recordRows()).toEqual({ current: 0, history: 0, nonces: 0, writes: 0 });
  });

  it('a distinct next key and distinct other secrets leave the routes enabled', async () => {
    const config = recordsEnv({ POLL_SECRET: POLL, HISTORY_SECRET: HISTORY, IVAO_CLIENT_SECRET: OTHER, DISCORD_BOT_TOKEN: 'synthetic-bot' });
    expect((await viaWorker(await meta(), config)).status).toBe(200);
  });

  for (const [gcaName, gcaKey] of [['GCA_ADMIN_HMAC_KEY', KEY], ['GCA_ADMIN_HMAC_KEY_NEXT', NEXT_KEY]] as const) {
    it(`HISTORY_SECRET equal to ${gcaName} disables every /gca-history route`, async () => {
      const config = recordsEnv({ POLL_SECRET: POLL, HISTORY_SECRET: ` ${gcaKey} ` });
      for (const [path, method] of [['/gca-history', 'GET'], ['/gca-history/cleanup', 'GET'], ['/gca-history/records', 'GET'],
        ['/gca-history/records/delete', 'POST']]) {
        const response = await viaWorker(new Request(`${ORIGIN}${path}`, {
          method, headers: { authorization: `Bearer ${gcaKey}`, 'x-onfreq-confirm': 'delete-gca-records' },
        }), config);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'endpoint disabled' });
      }
      // And the signed routes refuse the reused key too.
      expect((await viaWorker(await meta(), config)).status).toBe(503);
      const reasons = logged().map((line) => JSON.parse(line).reason);
      expect(reasons).toContain(`HISTORY_SECRET_reuses_${gcaName}`);
      expect(reasons.filter((reason) => reason === `HISTORY_SECRET_reuses_${gcaName}`)).toHaveLength(1);
      expect(logged().join('\n')).not.toContain(gcaKey);
    });

    it(`POLL_SECRET equal to ${gcaName} disables /poll and /health`, async () => {
      const config = recordsEnv({ POLL_SECRET: gcaKey, HISTORY_SECRET: HISTORY });
      for (const [path, method] of [['/health', 'GET'], ['/poll', 'POST']]) {
        const response = await viaWorker(new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${gcaKey}` } }), config);
        expect(response.status).toBe(503);
      }
      expect(logged().map((line) => JSON.parse(line).reason)).toContain(`POLL_SECRET_reuses_${gcaName}`);
      // The history routes keep working with their own secret.
      expect((await viaWorker(new Request(`${ORIGIN}/gca-history/records`, { headers: { authorization: `Bearer ${HISTORY}` } }),
        config)).status).toBe(200);
    });
  }

  it('the shared bindings keep every bearer and signed route enabled', async () => {
    expect((await viaSelf({ url: `${ORIGIN}/gca-history/records`, init: { headers: HISTORY_AUTH_HEADERS }, nonce: '', signature: '' }))
      .status).toBe(200);
    expect((await viaSelf(await meta())).status).toBe(200);
  });
});
