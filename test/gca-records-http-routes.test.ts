import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigInvalidLogForTests } from '../src/auth';
import { resetGcaRecordsHttpForTests } from '../src/gca-records-http';
import { AUTH_HEADERS, HISTORY_AUTH_HEADERS } from './helpers';
import {
  ORIGIN, recordBody, recordRows, recordsEnv, sha256, sign, START, viaSelf, viaWorker, type Signed,
} from './gca-signing';

const VERSION = /^[1-9]\d{0,15}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SIGNED_ROUTES: [string, string][] = [['/gca/records', 'PUT'], ['/gca/records/meta', 'GET'], ['/gca/records/history/purge', 'POST']];
const OPERATOR_ROUTES: [string, string][] = [['/gca-history/records', 'GET'], ['/gca-history/records/delete', 'POST']];
let now: number;
let errors: { mock: { calls: unknown[][] } };
let infos: { mock: { calls: unknown[][] } };

const put = (body: string | Uint8Array, options = {}) => sign('PUT', '/gca/records', { body, ...options });
const meta = (options = {}) => sign('GET', '/gca/records/meta', options);
const purge = (options = {}) => sign('POST', '/gca/records/history/purge', options);
const operator = (path: string, method: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { ...HISTORY_AUTH_HEADERS, ...headers } });
const confirmDelete = () => operator('/gca-history/records/delete', 'POST', { 'x-onfreq-confirm': 'delete-gca-records' });
const reasons = () => errors.mock.calls.map(([line]) => JSON.parse(String(line)).reason as string);

async function publish(baseVersion: string | null, approvals: object = { 100001: [{ level: 3, region: 'HK' }] }) {
  return viaWorker(await put(recordBody({ approvals, baseVersion })));
}

beforeEach(() => {
  now = START;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  infos = vi.spyOn(console, 'log').mockImplementation(() => {});
  resetConfigInvalidLogForTests();
  resetGcaRecordsHttpForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('validation through HTTP', () => {
  const vids = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(1_000_001 + i), []]));
  const cases: [string, string | Uint8Array, string][] = [
    ['deep nesting', `{"approvals":${'['.repeat(5000)}${']'.repeat(5000)},"homeOverrides":{},"baseVersion":null}`, 'invalid_json'],
    ['a BOM', `﻿${recordBody()}`, 'invalid_json'],
    ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0x7d]), 'invalid_json'],
    ['a duplicate key', `{"baseVersion":null,${recordBody().slice(1, -1)}}`, 'invalid_json'],
    ['an empty body', '', 'invalid_json'],
    ['an extra field', recordBody({ extra: 1 }), 'unknown_field'],
    ['a bad VID', recordBody({ approvals: { '0100001': [] } }), 'invalid_records'],
    ['an unknown region', recordBody({ approvals: { 100001: [{ level: 1, region: 'ZZ' }] } }), 'invalid_records'],
    ['level 0', recordBody({ approvals: { 100001: [{ level: 0, region: 'HK' }] } }), 'invalid_records'],
    ['level 4', recordBody({ approvals: { 100001: [{ level: 4, region: 'HK' }] } }), 'invalid_records'],
    ['level 1.5', recordBody({ approvals: { 100001: [{ level: 1.5, region: 'HK' }] } }), 'invalid_records'],
    ['override "ph"', recordBody({ homeOverrides: { 100001: 'ph' } }), 'invalid_records'],
    ['override "ZZ"', recordBody({ homeOverrides: { 100001: 'ZZ' } }), 'invalid_records'],
    ['> 2000 VIDs', recordBody({ approvals: vids(2001) }), 'too_many_vids'],
    ['> 8 approvals', recordBody({ approvals: { 100001: Array(9).fill({ level: 1, region: 'HK' }) } }), 'too_many_approvals'],
    ['{} without confirmEmpty', recordBody({ approvals: {} }), 'empty_requires_confirm'],
    ['baseVersion 1 (a number)', recordBody({ baseVersion: 1 }), 'invalid_base_version'],
  ];

  it.each(cases)('%s -> 400 with its category, stores nothing', async (_label, body, category) => {
    const response = await viaWorker(await put(body));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: category });
    expect(await recordRows()).toMatchObject({ current: 0, history: 0 });
  });

  it('baseVersion "1" is a valid form (409 without a record), and {} with confirmEmpty publishes', async () => {
    const stale = await viaWorker(await put(recordBody({ baseVersion: '1' })));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ currentVersion: null, currentDigest: null });
    const empty = await viaWorker(await put(recordBody({ approvals: {}, confirmEmpty: true })));
    expect(empty.status).toBe(200);
  });

  it('a body over 64 KiB is 413, declared or streamed; exactly 64 KiB is read and verified', async () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    const declared = await viaSelf(await put(big));
    expect(declared.status).toBe(413);
    expect(declared.headers.get('cache-control')).toBe('no-store');
    expect(await declared.json()).toEqual({ error: 'payload too large' });
    // A streamed body without Content-Length.
    const signed = await put(big);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const streamed = await viaWorker(new Request(signed.url, { method: 'PUT', headers: signed.init.headers, body: stream }));
    expect(streamed.status).toBe(413);
    const exact = await viaWorker(await put(' '.repeat(64 * 1024)));
    expect(exact.status).toBe(400);
    expect(await exact.json()).toEqual({ error: 'invalid_json' });
    expect(await recordRows()).toMatchObject({ current: 0 });
  });

  it('GCA_REGIONS unset -> 503 gca regions invalid and no record written', async () => {
    const response = await viaWorker(await put(recordBody()), recordsEnv({}, { GCA_REGIONS: '' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'gca regions invalid' });
    expect(await recordRows()).toMatchObject({ current: 0, history: 0 });
  });
});

describe('versioning and response JSON types', () => {
  it('first publish needs null; stale base -> 409 with the current digest; a retry after commit gets 409 with an equal digest', async () => {
    const first = await publish(null);
    expect(first.status).toBe(200);
    const stored = await first.json() as { version: string; digest: string; updatedAt: string };
    expect(Object.keys(stored).sort()).toEqual(['digest', 'updatedAt', 'version']);
    expect(stored.version).toMatch(VERSION);
    expect(stored.digest).toMatch(DIGEST);
    expect(stored.updatedAt).toBe(new Date(START).toISOString());
    expect(stored.digest).toBe(await sha256('{"approvals":{"100001":[{"level":3,"region":"HK"}]},"homeOverrides":{}}'));
    // The success log: version, digest prefix and counts only.
    expect(infos.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
      event: 'gca_records_updated', version: stored.version, digestPrefix: stored.digest.slice(0, 8),
      counts: { approvals: 1, homeOverrides: 0 },
    });
    const retry = await publish(null);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ currentVersion: stored.version, currentDigest: stored.digest });
    now += 1000;
    const next = await publish(stored.version, { 100002: [{ level: 1, region: 'PH' }] });
    expect(next.status).toBe(200);
    const updated = await next.json() as { version: string };
    expect(BigInt(updated.version)).toBeGreaterThan(BigInt(stored.version));
    const stale = await publish(stored.version);
    expect(stale.status).toBe(409);
    expect((await stale.json() as { currentVersion: string }).currentVersion).toBe(updated.version);
  });

  it('meta and purge return the contract types', async () => {
    const empty = await viaWorker(await purge());
    expect(await empty.json()).toEqual({ ok: true, kept: 0 });
    await publish(null);
    const response = await viaWorker(await meta());
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({
      version: '1', digest: expect.stringMatching(DIGEST), updatedAt: '2026-01-01T00:00:00.000Z',
      counts: { approvals: 1, homeOverrides: 0 }, source: 'durable-object',
    });
    expect(Object.keys(body).sort()).toEqual(['counts', 'digest', 'source', 'updatedAt', 'version']);
    now += 1000;
    await publish('1', { 100002: [{ level: 1, region: 'PH' }] });
    const purged = await viaWorker(await purge());
    expect(await purged.json()).toEqual({ ok: true, kept: 1 });
    expect(await recordRows()).toMatchObject({ current: 1, history: 1 });
  });
});

describe('operator routes (HISTORY_SECRET bearer)', () => {
  it('need the history bearer: none or the poll bearer -> 401', async () => {
    for (const [path, method] of OPERATOR_ROUTES) {
      for (const headers of [{}, AUTH_HEADERS, { authorization: 'Bearer synthetic-gca-admin-test-key-0001-abcdef' }] as Record<string, string>[]) {
        const response = await viaWorker(new Request(`${ORIGIN}${path}`, {
          method, headers: { ...headers, 'x-onfreq-confirm': 'delete-gca-records' },
        }));
        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(await recordRows()).toMatchObject({ current: 0 });
  });

  it('delete needs X-Onfreq-Confirm: delete-gca-records', async () => {
    await publish(null);
    for (const headers of [{}, { 'x-onfreq-confirm': 'delete-old-copies' }, { 'x-onfreq-confirm': 'DELETE-GCA-RECORDS' }] as Record<string, string>[]) {
      const response = await viaWorker(operator('/gca-history/records/delete', 'POST', headers));
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(await recordRows()).toMatchObject({ current: 1, history: 1 });
  });

  it('GET reports the stored record; after delete it reports source "secrets" and version null, and versions keep increasing', async () => {
    await publish(null);
    const before = await viaWorker(operator('/gca-history/records', 'GET'));
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ source: 'durable-object', version: '1' });
    const deleted = await viaWorker(confirmDelete());
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get('cache-control')).toBe('no-store');
    expect(await deleted.json()).toEqual({ ok: true, deleted: 1, history: 1 });
    const after = await viaWorker(operator('/gca-history/records', 'GET'));
    expect(after.status).toBe(200);
    const body = await after.json() as Record<string, unknown>;
    expect(body).toMatchObject({ source: 'secrets', version: null, digest: null, updatedAt: null });
    expect(Object.keys(body).sort()).toEqual(['counts', 'digest', 'source', 'updatedAt', 'version']);
    // A stale base after delete: 409 with currentVersion null; a fresh publish gets a higher version.
    const stale = await publish('1');
    expect(await stale.json()).toEqual({ currentVersion: null, currentDigest: null });
    const fresh = await publish(null);
    expect(await fresh.json()).toMatchObject({ version: '2' });
  });

  it('the operator GET works through SELF.fetch with the shared bindings', async () => {
    const response = await viaSelf({ url: `${ORIGIN}/gca-history/records`, init: { headers: HISTORY_AUTH_HEADERS }, nonce: '', signature: '' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: 'secrets', version: null });
  });
});

describe('HTTP policy: methods, OPTIONS, queries, paths, no-store', () => {
  it.each([...SIGNED_ROUTES, ...OPERATOR_ROUTES])('OPTIONS %s -> 405 with Allow %s and no CORS headers', async (path, method) => {
    for (const fetcher of [viaSelf, (r: Signed) => viaWorker(r)]) {
      const response = await fetcher({ url: `${ORIGIN}${path}`, init: {
        method: 'OPTIONS', headers: { origin: 'https://website.example', 'access-control-request-method': method },
      }, nonce: '', signature: '' });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe(method);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect([...response.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([]);
    }
  });

  it.each(SIGNED_ROUTES)('%s refuses other methods with 405 before any signature check', async (path, method) => {
    for (const other of ['GET', 'PUT', 'POST', 'DELETE', 'PATCH'].filter((m) => m !== method)) {
      const response = await viaSelf({ url: `${ORIGIN}${path}?x=1`, init: { method: other }, nonce: '', signature: '' });
      expect(response.status).toBe(405);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it.each(SIGNED_ROUTES)('%s %s with any query, even an empty one, is 400 query_not_allowed before key and signature checks', async (path, method) => {
    for (const suffix of ['?', '?x=1', '?a']) {
      const signed = await sign(method, path, { suffix });
      for (const response of [await viaSelf(signed), await viaWorker(signed, recordsEnv({ GCA_ADMIN_HMAC_KEY: '' }))]) {
        expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ error: 'query_not_allowed' });
      }
    }
    expect(await recordRows()).toMatchObject({ nonces: 0, writes: 0 });
  });

  it('a trailing slash, another case or extra path segments are 404', async () => {
    for (const path of ['/gca/records/', '/gca/records/meta/', '/gca/records/history/purge/', '/GCA/records', '/gca/records//meta',
      '/gca/records/history', '/gca', '/gca/', '/gca-history/records/', '/gca-history/records/delete/']) {
      for (const method of ['GET', 'PUT', 'POST']) {
        const response = await viaSelf({ url: `${ORIGIN}${path}`, init: { method }, nonce: '', signature: '' });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
  });

  it('checks run in order: size before timestamp, timestamp before key id', async () => {
    const oversized = await viaSelf(await put('x'.repeat(64 * 1024 + 1), { ts: START - 999_999 }));
    expect(oversized.status).toBe(413);
    const badHeadersBig = await viaSelf(await put('x'.repeat(64 * 1024 + 1), { headers: { 'x-xe-gca-nonce': 'x' } }));
    expect(badHeadersBig.status).toBe(401);
    expect((await viaSelf(await meta({ ts: START - 300_001, headers: { 'x-xe-gca-key-id': '0123456789abcdef' } }))).status).toBe(401);
    expect(reasons()).toEqual(['payload_too_large', 'headers_invalid', 'timestamp_out_of_window']);
  });

  it('a coordinator failure is a generic 503, logged by error type only', async () => {
    const config = recordsEnv();
    config.POLL_COORDINATOR = { getByName: () => ({ gcaRecordsMeta: () => Promise.reject(new TypeError('synthetic-detail')) }) } as unknown as Env['POLL_COORDINATOR'];
    const response = await viaWorker(await meta(), config);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'coordinator unavailable' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('synthetic-detail');
  });

  it('every status of the signed and operator routes is no-store without CORS', async () => {
    const responses: Response[] = [
      await publish(null), // 200
      await viaWorker(await put(recordBody({ extra: 1 }))), // 400
      await viaWorker(await meta({ headers: { 'x-xe-gca-signature': null } })), // 401
      await viaSelf({ url: `${ORIGIN}/gca/records/`, init: {}, nonce: '', signature: '' }), // 404
      await viaSelf({ url: `${ORIGIN}/gca/records`, init: { method: 'GET' }, nonce: '', signature: '' }), // 405
      await publish(null), // 409
      await viaSelf(await put('x'.repeat(70_000))), // 413
      await viaWorker(await meta(), recordsEnv({ GCA_ADMIN_HMAC_KEY: '' })), // 503
      await viaWorker(await put(recordBody()), recordsEnv({}, { GCA_REGIONS: '' })), // 503 regions
      await viaWorker(operator('/gca-history/records', 'GET')), // 200 operator
      await viaWorker(operator('/gca-history/records/delete', 'POST')), // 400 operator
    ];
    for (let i = 0; i < 30; i++) await viaWorker(await purge());
    responses.push(await viaWorker(await purge())); // 429
    expect(responses.map((r) => r.status)).toEqual([200, 400, 401, 404, 405, 409, 413, 503, 503, 200, 400, 429]);
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});
