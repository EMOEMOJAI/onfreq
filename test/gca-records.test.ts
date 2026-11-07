import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollCoordinator } from '../src/coordinator';
import { parseGcaPolicy } from '../src/gca';
import {
  canonicalGcaRecords, loadGcaPolicy, parseGcaRecordsBody, sha256Hex, writeGcaRecords,
  type GcaRecords, type GcaSignedRequest,
} from '../src/gca-records';

const START = Date.parse('2026-01-01T00:00:00Z');
const DAY = 86_400_000;
const KEY_ID = '839683debc9ccbd0';
const stub = () => env.POLL_COORDINATOR.getByName('gca-records-tests');
// The fictional coverage of test/gca.test.ts.
const REGIONS = JSON.stringify({
  AA: { name: 'Example North', prefixes: ['XA', 'XB'], homeCountries: ['AA', 'AB'] },
  AC: { name: 'Example West', prefixes: ['XC'] },
  AD: { name: 'Example East', prefixes: ['XD'] },
  AE: { name: 'Example South', prefixes: ['XF'] },
});
const REGION_NAMES = { AA: 'Example North', AC: 'Example West', AD: 'Example East', AE: 'Example South' };
const settings = (overrides: Partial<Env> = {}): Env => ({
  ...env, GCA_REGIONS: REGIONS, GCA_APPROVALS: JSON.stringify({ 100002: [{ region: 'AD', level: 3 }] }),
  GCA_HOME_OVERRIDES: '', ...overrides,
});

// Synthetic VIDs only; keys in an order unlike both numeric and code-unit order.
const RECORD = {
  approvals: {
    4294967297: [], 99999: [{ region: 'AD', level: 1 }], 100002: [{ level: 1, region: 'AE' }, { region: 'AC', level: 2 }],
    100001: [{ region: 'AA', level: 3 }],
  },
  homeOverrides: { 100002: 'AC' },
};
const RECORD_CANONICAL = '{"approvals":{"100001":[{"level":3,"region":"AA"}],"100002":[{"level":1,"region":"AE"},' +
  '{"level":2,"region":"AC"}],"4294967297":[],"99999":[{"level":1,"region":"AD"}]},"homeOverrides":{"100002":"AC"}}';
// Independently computed: sha256 of RECORD_CANONICAL with Node crypto.
const RECORD_DIGEST = '8d92250e90a57f32b551708eedd1e72e5b8ec32f90188e79c2388e518161a99f';

let now: number;

function request(method: string, path: string, body: string | Uint8Array = '', overrides: Partial<GcaSignedRequest> = {}): GcaSignedRequest {
  return {
    method, path, keyId: KEY_ID, ts: now, nonce: crypto.randomUUID(),
    bodyBytes: typeof body === 'string' ? new TextEncoder().encode(body) : body, ...overrides,
  };
}
const put = (body: unknown, overrides: Partial<GcaSignedRequest> = {}) =>
  request('PUT', '/gca/records', typeof body === 'string' ? body : JSON.stringify(body), overrides);
const publish = (baseVersion: string | null, record: object = RECORD, overrides: Partial<GcaSignedRequest> = {}) =>
  put({ ...record, baseVersion }, overrides);
const purgeRequest = () => request('POST', '/gca/records/history/purge');
const metaRequest = () => request('GET', '/gca/records/meta');

/** Run against the real coordinator storage with the given settings. */
function withCoordinator<T>(run: (coordinator: PollCoordinator, ctx: DurableObjectState) => T | Promise<T>, config = settings()) {
  return runInDurableObject(stub(), (_instance, ctx) => run(new PollCoordinator(ctx, config), ctx));
}
const write = (req: GcaSignedRequest, config = settings()) => withCoordinator((c) => c.gcaRecordsWrite(req), config);
const purge = (req: GcaSignedRequest) => withCoordinator((c) => c.gcaRecordsPurge(req));
const meta = (req?: GcaSignedRequest, config = settings()) => withCoordinator((c) => c.gcaRecordsMeta(req), config);
const operatorDelete = () => withCoordinator((c) => c.gcaRecordsOperatorDelete());

/** Row counts of every records table (0 for a missing table). */
function rows() {
  return withCoordinator((_c, ctx) => {
    const sql = ctx.storage.sql;
    const tables = new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name));
    const count = (table: string) => tables.has(table) ? sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n : 0;
    return {
      current: count('gca_records_current'), history: count('gca_records_history'), meta: count('gca_records_meta'),
      nonces: count('gca_records_nonces'), writes: count('gca_records_writes'),
    };
  });
}
const historyVersions = () => withCoordinator((_c, ctx) =>
  ctx.storage.sql.exec<{ version: number }>('SELECT version FROM gca_records_history ORDER BY version').toArray().map((r) => r.version));
const recordsTables = () => withCoordinator((_c, ctx) =>
  ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'gca_records%'").toArray().map((r) => r.name));

function logged(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([line]) => String(line));
}

beforeEach(() => {
  now = START;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('canonical JSON and digest', () => {
  it('reproduces the fixed shared vector exactly', async () => {
    const record: GcaRecords = {
      approvals: {
        '100001': [{ level: 3, region: 'HK' }], '100002': [{ level: 1, region: 'PH' }, { level: 2, region: 'KR' }],
        '4294967297': [], '99999': [{ level: 1, region: 'TW' }],
      },
      homeOverrides: { '100002': 'PH' },
    };
    const canonical = canonicalGcaRecords(record);
    expect(canonical).toBe('{"approvals":{"100001":[{"level":3,"region":"HK"}],"100002":[{"level":1,"region":"PH"},' +
      '{"level":2,"region":"KR"}],"4294967297":[],"99999":[{"level":1,"region":"TW"}]},"homeOverrides":{"100002":"PH"}}');
    expect(await sha256Hex(canonical)).toBe('e043e384c114c723818cfdb61df29ec0dcc76ed834bceb76ea6ff60ffaa8d68c');
  });

  it('sorts keys by UTF-16 code units whatever the input order, with the exact item shape', async () => {
    const parsed = parseGcaRecordsBody(new TextEncoder().encode(JSON.stringify({ ...RECORD, baseVersion: null })), REGION_NAMES);
    expect(parsed.ok).toBe(true);
    const canonical = canonicalGcaRecords((parsed as { records: GcaRecords }).records);
    expect(canonical).toBe(RECORD_CANONICAL);
    expect(await sha256Hex(canonical)).toBe(RECORD_DIGEST);
    // A second own vector: overrides with every synthetic VID.
    const overrides = { ...(parsed as { records: GcaRecords }).records, homeOverrides: { 99999: 'US', 4294967297: 'AB', 100002: 'AC' } };
    expect(await sha256Hex(canonicalGcaRecords(overrides))).toBe('4365b14ed1008abbd6f23f4e038cec489b933cf4998e72f22c155d761b5f49ee');
  });

  it('stores the same digest through the write RPC', async () => {
    const result = await write(publish(null));
    expect(result).toEqual({ ok: true, version: '1', digest: RECORD_DIGEST, updatedAt: '2026-01-01T00:00:00.000Z' });
    const stored = await withCoordinator((_c, ctx) => ctx.storage.sql.exec('SELECT json FROM gca_records_history').one());
    expect(stored.json).toBe(RECORD_CANONICAL);
  });
});

describe('strict body validation', () => {
  const body = (extra: object = {}) => JSON.stringify({ ...RECORD, baseVersion: null, ...extra });
  const bytes = (text: string) => new TextEncoder().encode(text);
  const category = (input: string | Uint8Array) => {
    const parsed = parseGcaRecordsBody(typeof input === 'string' ? bytes(input) : input, REGION_NAMES);
    return parsed.ok ? 'ok' : parsed.error;
  };
  const vids = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [String(100001 + i), [] as unknown[]]));

  it.each([
    ['deep nesting', `{"approvals":${'['.repeat(5000)}${']'.repeat(5000)},"homeOverrides":{},"baseVersion":null}`, 'invalid_json'],
    ['nesting beyond 32 levels', `{"approvals":${'['.repeat(40)}${']'.repeat(40)},"homeOverrides":{},"baseVersion":null}`, 'invalid_json'],
    ['nesting within 32 levels', `{"approvals":${'['.repeat(20)}${']'.repeat(20)},"homeOverrides":{},"baseVersion":null}`, 'invalid_records'],
    ['a BOM', `﻿${body()}`, 'invalid_json'],
    ['not JSON', '{"approvals":', 'invalid_json'],
    ['an array', '[]', 'invalid_json'],
    ['an empty body', '', 'invalid_json'],
    ['a duplicate top-level key', `{"baseVersion":null,${body().slice(1, -1)},"baseVersion":null}`, 'invalid_json'],
    ['a duplicate VID', '{"approvals":{"100001":[],"100001":[]},"homeOverrides":{},"baseVersion":null}', 'invalid_json'],
    ['an extra top-level field', body({ extra: 1 }), 'unknown_field'],
    ['an extra item field', body({ approvals: { 100001: [{ level: 1, region: 'AA', note: 'x' }] } }), 'unknown_field'],
    ['a missing item field', body({ approvals: { 100001: [{ region: 'AA' }] } }), 'invalid_records'],
    ['a bad VID', body({ approvals: { '0100001': [] } }), 'invalid_records'],
    ['a short VID', body({ approvals: { 1234: [] } }), 'invalid_records'],
    ['an unknown region', body({ approvals: { 100001: [{ level: 1, region: 'ZZ' }] } }), 'invalid_records'],
    ['level 0', body({ approvals: { 100001: [{ level: 0, region: 'AA' }] } }), 'invalid_records'],
    ['level 4', body({ approvals: { 100001: [{ level: 4, region: 'AA' }] } }), 'invalid_records'],
    ['level 1.5', body({ approvals: { 100001: [{ level: 1.5, region: 'AA' }] } }), 'invalid_records'],
    ['a string level', body({ approvals: { 100001: [{ level: '1', region: 'AA' }] } }), 'invalid_records'],
    ['override "ph"', body({ homeOverrides: { 100001: 'ph' } }), 'invalid_records'],
    ['override "ZZ"', body({ homeOverrides: { 100001: 'ZZ' } }), 'invalid_records'],
    ['missing homeOverrides', JSON.stringify({ approvals: RECORD.approvals, baseVersion: null }), 'invalid_records'],
    ['confirmEmpty false', body({ confirmEmpty: false }), 'invalid_records'],
    ['> 2000 approval VIDs', body({ approvals: vids(2001) }), 'too_many_vids'],
    ['> 2000 override VIDs', body({ homeOverrides: Object.fromEntries(Object.keys(vids(2001)).map((vid) => [vid, 'AC'])) }), 'too_many_vids'],
    ['> 8 approvals', body({ approvals: { 100001: Array(9).fill({ level: 1, region: 'AA' }) } }), 'too_many_approvals'],
    ['{} without confirmEmpty', body({ approvals: {} }), 'empty_requires_confirm'],
    ['baseVersion 1', body({ baseVersion: 1 }), 'invalid_base_version'],
    ['baseVersion "01"', body({ baseVersion: '01' }), 'invalid_base_version'],
    ['baseVersion "0"', body({ baseVersion: '0' }), 'invalid_base_version'],
    ['a 17-digit baseVersion', body({ baseVersion: '1'.repeat(17) }), 'invalid_base_version'],
    ['no baseVersion', JSON.stringify(RECORD), 'invalid_base_version'],
  ])('refuses %s with the right category', (_name, input, expected) => {
    expect(category(input)).toBe(expected);
  });

  it('refuses invalid UTF-8', () => {
    expect(category(new Uint8Array([0x7b, 0xff, 0x7d]))).toBe('invalid_json');
  });

  it('accepts the limits exactly, "1" as a baseVersion and a confirmed empty record', () => {
    expect(category(body({ approvals: vids(2000) }))).toBe('ok');
    expect(category(body({ approvals: { 100001: Array(8).fill({ level: 1, region: 'AA' }) } }))).toBe('ok');
    expect(category(body({ baseVersion: '1' }))).toBe('ok');
    expect(category(body({ baseVersion: '9'.repeat(16) }))).toBe('ok');
    expect(category(body({ approvals: {}, confirmEmpty: true }))).toBe('ok');
    expect(category(` \n${body()}\t`)).toBe('ok');
  });

  it('keeps the secrets path lenient: no limits and extra item keys ignored', () => {
    const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [String(100001 + i), [{ region: 'AA', level: 1, note: 'x' }]]));
    const nine = { 100001: Array(9).fill({ region: 'AA', level: 1 }) };
    for (const approvals of [many, nine]) {
      expect(parseGcaPolicy(settings({ GCA_APPROVALS: JSON.stringify(approvals) }))).not.toBeNull();
    }
    expect(category(body({ approvals: nine }))).toBe('too_many_approvals');
  });
});

describe('write RPC', () => {
  it('refuses to publish while regions are unset, with no record written (real RPC)', async () => {
    // The real binding has GCA_REGIONS unset.
    const result = await stub().gcaRecordsWrite(publish(null));
    expect(result).toEqual({ ok: false, error: 'regions_invalid' });
    expect((await rows()).current).toBe(0);
    expect((await rows()).history).toBe(0);
    expect(await stub().gcaRecordsMeta()).toMatchObject({ ok: true, source: 'secrets', version: null });
  });

  it('needs a null baseVersion first, then the current version; returns typed values', async () => {
    expect(await write(publish('1'))).toEqual({ ok: false, error: 'conflict', currentVersion: null, currentDigest: null });
    const first = await write(publish(null));
    expect(first).toMatchObject({ ok: true, version: '1', digest: RECORD_DIGEST });
    now += 1000;
    const second = await write(publish('1', { ...RECORD, homeOverrides: {} }));
    expect(second).toMatchObject({ ok: true, version: '2', updatedAt: new Date(now).toISOString() });
    if (!second.ok) throw new Error('unreachable');
    expect(second.version).toMatch(/^[1-9]\d{0,15}$/);
    expect(second.digest).toMatch(/^[0-9a-f]{64}$/);
    // Stale base and a null base both get the current version and digest.
    for (const base of ['1', null]) {
      expect(await write(publish(base))).toEqual({ ok: false, error: 'conflict', currentVersion: '2', currentDigest: second.digest });
    }
  });

  it('gives a retry after commit a 409 whose digest equals the sent one', async () => {
    await write(publish(null));
    const sent = { ...RECORD, homeOverrides: { 99999: 'AC' } };
    const applied = await write(publish('1', sent));
    expect(applied.ok).toBe(true);
    const retry = await write(publish('1', sent)); // new nonce, same body
    expect(retry).toMatchObject({ ok: false, error: 'conflict', currentVersion: '2' });
    expect((retry as { currentDigest: string }).currentDigest).toBe((applied as { digest: string }).digest);
  });

  it('refuses a replay, including of a refused request, and records nothing for it', async () => {
    const req = publish(null);
    expect((await write(req)).ok).toBe(true);
    const before = await rows();
    expect(await write(req)).toEqual({ ok: false, error: 'replay' });
    expect(await rows()).toEqual(before);
    const bad = put('not json');
    expect(await write(bad)).toEqual({ ok: false, error: 'invalid_json' });
    expect(await write(bad)).toEqual({ ok: false, error: 'replay' });
  });

  it('ties nonce expiry to the signed timestamp', async () => {
    const late = publish(null, RECORD, {});
    late.ts = now + 290_000;
    const early = publish(null);
    early.ts = now - 290_000;
    await write(late);
    await write(early);
    const expiry = await withCoordinator((_c, ctx) => Object.fromEntries(ctx.storage.sql
      .exec<{ nonce: string; expires_at: number }>('SELECT nonce, expires_at FROM gca_records_nonces').toArray()
      .map((row) => [row.nonce, row.expires_at])));
    expect(expiry[late.nonce]).toBe(now + 290_000 + 360_000);
    expect(expiry[early.nonce]).toBe(now + 601_000);
    now += 600_999;
    expect(await write(early)).toEqual({ ok: false, error: 'replay' });
    now += 1;
    // Expired at the DO level (the Worker's window refuses its timestamp long before).
    expect(await write(early)).not.toEqual({ ok: false, error: 'replay' });
    expect(await write(late)).toEqual({ ok: false, error: 'replay' });
  });

  it('refuses at the nonce cap without recording, while an old replay is still a replay', async () => {
    await withCoordinator((_c, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE gca_records_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
      for (let i = 0; i < 2000; i++) {
        ctx.storage.sql.exec('INSERT INTO gca_records_nonces VALUES (?, ?)', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, now + 1);
      }
    });
    expect(await write(publish(null))).toEqual({ ok: false, error: 'rate_limited' });
    expect(await purge(purgeRequest())).toEqual({ ok: false, error: 'rate_limited' });
    expect(await meta(metaRequest())).toEqual({ ok: false, error: 'rate_limited' });
    const replay = publish(null, RECORD, { nonce: '00000000-0000-4000-8000-000000000007' });
    expect(await write(replay)).toEqual({ ok: false, error: 'replay' });
    expect(await rows()).toMatchObject({ nonces: 2000, writes: 0, current: 0 });
    now += 1; // the seeded nonces expire
    expect((await write(publish(null))).ok).toBe(true);
  });

  it('allows 30 write attempts (PUT and purge, incl. 400 and 409) per sliding hour; signed meta is not one', async () => {
    expect((await write(publish(null))).ok).toBe(true);
    for (let i = 1; i < 30; i++) {
      now += 1000;
      const req = i % 3 === 0 ? purgeRequest() : i % 3 === 1 ? put('{}') : publish(null);
      const result = i % 3 === 0 ? await purge(req) : await write(req);
      expect(result).not.toEqual({ ok: false, error: 'rate_limited' });
    }
    expect(await meta(metaRequest())).toMatchObject({ ok: true });
    now += 1000;
    const before = await rows();
    expect(await write(publish('1'))).toEqual({ ok: false, error: 'rate_limited' });
    expect(await purge(purgeRequest())).toEqual({ ok: false, error: 'rate_limited' });
    expect(await rows()).toEqual(before);
    // The first attempt leaves the window one hour after it was made.
    now = START + 3_600_000;
    expect(await write(publish('1'))).toMatchObject({ ok: true, version: '2' });
    expect(await write(publish('2'))).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('rolls back the nonce and attempt when the transaction fails', async () => {
    await withCoordinator((_c, ctx) => {
      // A damaged history table makes the final insert throw inside the transaction.
      ctx.storage.sql.exec('CREATE TABLE gca_records_history (version INTEGER PRIMARY KEY)');
    });
    const req = publish(null);
    await expect(write(req)).rejects.toThrow();
    expect(await rows()).toEqual({ current: 0, history: 0, meta: 0, nonces: 0, writes: 0 });
  });

  it.each([
    ['a purge request routed to write', () => request('POST', '/gca/records/history/purge', JSON.stringify({ ...RECORD, baseVersion: null }))],
    ['another path', () => publish(null, RECORD, { path: '/gca/records/' })],
    ['an uppercase key id', () => publish(null, RECORD, { keyId: KEY_ID.toUpperCase() })],
    ['an uppercase nonce', () => publish(null, RECORD, { nonce: crypto.randomUUID().toUpperCase() })],
    ['a non-v4 nonce', () => publish(null, RECORD, { nonce: '3f1c2b4a-5d6e-1f70-8a9b-0c1d2e3f4a5b' })],
    ['a 12-digit timestamp', () => publish(null, RECORD, { ts: 999_999_999_999 })],
    ['a body over 64 KiB', () => request('PUT', '/gca/records', new Uint8Array(64 * 1024 + 1))],
  ])('refuses %s without touching storage', async (_name, make) => {
    expect(await write(make())).toEqual({ ok: false, error: 'invalid_request' });
    expect(await recordsTables()).toEqual([]);
  });

  it('logs only the version, a digest prefix and counts', async () => {
    const log = vi.spyOn(console, 'log');
    await write(publish(null));
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      event: 'gca_records_updated', version: '1', digestPrefix: RECORD_DIGEST.slice(0, 8), counts: { approvals: 4, homeOverrides: 1 },
    }));
    expect(logged(log).join('\n')).not.toMatch(/100001|100002|99999|4294967297/);
  });
});

describe('history retention, purge and operator delete', () => {
  it('keeps at most 20 versions and drops non-current rows older than 30 days on write', async () => {
    let base: string | null = null;
    for (let i = 0; i < 22; i++) {
      const result = await write(publish(base, { ...RECORD, homeOverrides: { 99999: i % 2 ? 'AC' : 'AD' } }));
      base = (result as { version: string }).version;
      now += 1000;
    }
    expect(await historyVersions()).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
    now += 31 * DAY;
    await write(publish(base));
    expect(await historyVersions()).toEqual([23]);
  });

  it('drops a 31-day-old row on the next poll load with no write, keeping the current one', async () => {
    await write(publish(null));
    now += 60_000;
    await write(publish('1', { ...RECORD, homeOverrides: {} }));
    expect(await historyVersions()).toEqual([1, 2]);
    now += 31 * DAY;
    await withCoordinator((_c, ctx) => loadGcaPolicy(settings(), ctx.storage));
    expect(await historyVersions()).toEqual([2]);
  });

  it('purges all but the current version, kept 0 without a record', async () => {
    expect(await purge(purgeRequest())).toEqual({ ok: true, kept: 0 });
    await write(publish(null));
    await write(publish('1', { ...RECORD, homeOverrides: {} }));
    await write(publish('2'));
    expect(await historyVersions()).toEqual([1, 2, 3]);
    expect(await purge(purgeRequest())).toEqual({ ok: true, kept: 1 });
    expect(await historyVersions()).toEqual([3]);
    expect(await meta()).toMatchObject({ source: 'durable-object', version: '3' });
    const replayed = purgeRequest();
    await purge(replayed);
    expect(await purge(replayed)).toEqual({ ok: false, error: 'replay' });
    await operatorDelete();
    expect(await purge(purgeRequest())).toEqual({ ok: true, kept: 0 });
  });

  it('operator delete removes record and history, keeps the counter, and returns to the secrets', async () => {
    await write(publish(null));
    const second = await write(publish('1', { ...RECORD, homeOverrides: {} }));
    expect(await operatorDelete()).toEqual({ ok: true, deleted: 1, history: 2 });
    expect(await rows()).toMatchObject({ current: 0, history: 0, meta: 1 });
    // Rollback acceptance (Revision 2): the loader's source is the secrets again.
    expect(await meta()).toEqual({
      ok: true, source: 'secrets', version: null, digest: null, updatedAt: null, counts: { approvals: 1, homeOverrides: 0 },
    });
    const policy = await withCoordinator((_c, ctx) => loadGcaPolicy(settings(), ctx.storage));
    expect(policy).toEqual(parseGcaPolicy(settings()));
    expect(await write(publish('2'))).toEqual({ ok: false, error: 'conflict', currentVersion: null, currentDigest: null });
    const third = await write(publish(null));
    expect(third).toMatchObject({ ok: true, version: '3' });
    expect(Number((third as { version: string }).version)).toBeGreaterThan(Number((second as { version: string }).version));
    expect(await operatorDelete()).toEqual({ ok: true, deleted: 1, history: 1 });
    expect(await operatorDelete()).toEqual({ ok: true, deleted: 0, history: 0 });
  });

  it('operator delete without any records creates nothing', async () => {
    expect(await operatorDelete()).toEqual({ ok: true, deleted: 0, history: 0 });
    expect(await recordsTables()).toEqual([]);
  });
});

describe('meta and the loader', () => {
  const corrupt = (statement: string, ...bindings: SqlStorageValue[]) =>
    withCoordinator((_c, ctx) => { ctx.storage.sql.exec(statement, ...bindings); });

  it('reports the secrets, a stored record, and an invalid one from the same resolver', async () => {
    expect(await meta()).toEqual({
      ok: true, source: 'secrets', version: null, digest: null, updatedAt: null, counts: { approvals: 1, homeOverrides: 0 },
    });
    await write(publish(null));
    expect(await meta()).toEqual({
      ok: true, source: 'durable-object', version: '1', digest: RECORD_DIGEST, updatedAt: '2026-01-01T00:00:00.000Z',
      counts: { approvals: 4, homeOverrides: 1 },
    });
    // Region AE removed from GCA_REGIONS: the stored record no longer validates.
    const fewer = settings({ GCA_REGIONS: JSON.stringify({ ...JSON.parse(REGIONS), AE: undefined }) });
    expect(await meta(undefined, fewer)).toEqual({
      ok: true, source: 'invalid', version: '1', digest: RECORD_DIGEST, updatedAt: '2026-01-01T00:00:00.000Z',
      counts: { approvals: 0, homeOverrides: 0 },
    });
    expect(await withCoordinator((_c, ctx) => loadGcaPolicy(fewer, ctx.storage), fewer)).toBeNull();
  });

  it('consumes the nonce of a signed meta request', async () => {
    const req = metaRequest();
    expect(await meta(req)).toMatchObject({ ok: true, source: 'secrets' });
    expect(await meta(req)).toEqual({ ok: false, error: 'replay' });
    expect(await meta(request('GET', '/gca/records/meta', '{}'))).toEqual({ ok: false, error: 'invalid_request' });
    expect(await rows()).toMatchObject({ nonces: 1, writes: 0 });
  });

  it('serves meta over the real RPC', async () => {
    expect(await stub().gcaRecordsMeta(metaRequest())).toMatchObject({ ok: true, source: 'secrets', counts: { approvals: 0, homeOverrides: 0 } });
  });

  it('matches today\'s secrets policy and creates no tables without a stored record', async () => {
    const config = settings({ GCA_HOME_OVERRIDES: JSON.stringify({ 99999: 'AC' }), GCA_POLICY_URL: 'https://example.test/gca' });
    const policy = await withCoordinator((_c, ctx) => loadGcaPolicy(config, ctx.storage), config);
    expect(policy).toEqual(parseGcaPolicy(config));
    expect(policy).not.toBeNull();
    expect(await loadGcaPolicy(config)).toEqual(parseGcaPolicy(config));
    expect(await recordsTables()).toEqual([]);
  });

  it('prefers the stored record over the secrets, keeping the env settings', async () => {
    await write(publish(null));
    const config = settings({ GCA_POLICY_URL: 'https://example.test/gca' });
    const policy = (await withCoordinator((_c, ctx) => loadGcaPolicy(config, ctx.storage), config))!;
    expect(policy.approvals).toEqual({
      100001: [{ level: 3, region: 'AA' }], 100002: [{ level: 1, region: 'AE' }, { level: 2, region: 'AC' }],
      4294967297: [], 99999: [{ level: 1, region: 'AD' }],
    });
    expect(policy.homeOverrides).toEqual({ 100002: 'AC' });
    expect(policy.policyUrl).toBe('https://example.test/gca');
    expect(policy.regionNames).toEqual(REGION_NAMES);
  });

  it.each([
    ['unparseable approvals', 'UPDATE gca_records_current SET approvals_json = \'{"100001":\''],
    ['a digest mismatch', `UPDATE gca_records_current SET digest = '${'0'.repeat(64)}'`],
    ['non-canonical JSON', 'UPDATE gca_records_current SET home_overrides_json = \'{ "100002":"AC"}\''],
    ['a level out of range', 'UPDATE gca_records_current SET approvals_json = replace(approvals_json, \'"level":3\', \'"level":9\')'],
    ['an extra item key', 'UPDATE gca_records_current SET approvals_json = replace(approvals_json, \'"level":3,\', \'"level":3,"x":1,\')'],
    ['a text version', 'UPDATE gca_records_current SET version = \'one\''],
    ['a lost row type', 'UPDATE gca_records_current SET approvals_json = 7'],
  ])('turns GCA off for %s, with no fallback and no VID in the log', async (_name, statement) => {
    await write(publish(null));
    await corrupt(statement);
    const error = vi.spyOn(console, 'error');
    expect(await withCoordinator((_c, ctx) => loadGcaPolicy(settings(), ctx.storage))).toBeNull();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'gca_config_invalid', reason: 'records' }));
    expect(logged(error).join('\n')).not.toMatch(/100001|100002|99999|4294967297/);
    expect(await meta()).toMatchObject({ ok: true, source: 'invalid' });
  });

  it('never throws when storage fails, and does not fall back to the secrets', async () => {
    const error = vi.spyOn(console, 'error');
    const broken = { sql: { exec: () => { throw new Error('storage unavailable'); } } } as unknown as DurableObjectStorage;
    expect(parseGcaPolicy(settings())).not.toBeNull();
    await expect(loadGcaPolicy(settings(), broken)).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'gca_config_invalid', reason: 'records' }));
  });

  it('applies a valid write with the module function too (same transaction path)', async () => {
    const result = await runInDurableObject(stub(), (_i, ctx) => writeGcaRecords(ctx.storage, settings(), publish(null)));
    expect(result).toMatchObject({ ok: true, version: '1' });
  });
});
