import { env } from 'cloudflare:workers';
import { SELF, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { COORDINATOR_NAME } from '../src/config';
import { AUTH_HEADERS } from './helpers';

const headers = AUTH_HEADERS;
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function seed(count = 1) {
  await runInDurableObject(env.POLL_COORDINATOR.getByName(COORDINATOR_NAME), (_instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE gca_reminders (session_key TEXT PRIMARY KEY, status TEXT, attempts INTEGER, last_seen INTEGER)');
    sql.exec('CREATE TABLE gca_occurrences (session_key TEXT PRIMARY KEY, occurrence INTEGER)');
    for (let i = 0; i < count; i++) {
      const key = `600001:${123456 + i}`;
      sql.exec('INSERT INTO gca_reminders VALUES (?, ?, ?, ?)', key, 'sent', 1, 1000);
      sql.exec('INSERT INTO gca_occurrences VALUES (?, ?)', key, i + 1);
    }
    sql.exec("INSERT INTO gca_reminders VALUES ('111111:1', 'baseline', 0, 1000), ('222222:1', 'unmapped', 0, 1000), ('333333:1', 'pending', 0, 1000)");
  });
}

it('requires authentication and never caches delivery records', async () => {
  await seed();
  for (const auth of ['', 'Bearer wrong']) {
    const response = await SELF.fetch('https://example.com/gca-history', { headers: { authorization: auth } });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('600001');
  }
});

it('is disabled without the secret', async () => {
  const response = await worker.fetch(new Request('https://example.com/gca-history', { headers }), { ...env, HISTORY_SECRET: '' }, {} as ExecutionContext);
  expect(response.status).toBe(503);
});

// Synthetic, distinct secrets: the fixture shares one value, so separation is proven here.
const POLL_ONLY = 'synthetic-poll-only-secret-0123456789';
const HISTORY_ONLY = 'synthetic-history-only-secret-01234567';
const historyRoutes = [['/gca-history', 'GET'], ['/gca-history/cleanup', 'GET'], ['/gca-history/cleanup', 'POST']] as const;
const call = (path: string, method: string, token: string, overrides: Partial<Env>) => worker.fetch(
  new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${token}`, 'x-onfreq-confirm': 'delete-old-copies' } }),
  { ...env, ...overrides }, {} as ExecutionContext);

it.each(historyRoutes)('S2-1: POLL_SECRET no longer authorizes %s %s', async (path, method) => {
  await seed();
  const response = await call(path, method, POLL_ONLY, { POLL_SECRET: POLL_ONLY, HISTORY_SECRET: HISTORY_ONLY });
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('600001');
  expect((await call(path, method, HISTORY_ONLY, { POLL_SECRET: POLL_ONLY, HISTORY_SECRET: HISTORY_ONLY })).status).toBe(200);
});

it.each(historyRoutes)('S2-1/S14-1: %s %s fails closed with a generic body when HISTORY_SECRET is unset', async (path, method) => {
  await seed();
  for (const unset of [{ HISTORY_SECRET: '' }, { HISTORY_SECRET: undefined }]) {
    const response = await call(path, method, POLL_ONLY, { POLL_SECRET: POLL_ONLY, ...unset });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toMatch(/SECRET|600001/);
  }
});

it.each(historyRoutes)('S1-1: a short HISTORY_SECRET disables %s %s even when the token matches', async (path, method) => {
  await seed();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const weak = 'a';
  const response = await call(path, method, weak, { HISTORY_SECRET: weak });
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).not.toMatch(/SECRET|600001/);
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({ event: 'config_invalid', reason: 'HISTORY_SECRET_too_short' });
  expect(JSON.stringify(log.mock.calls)).not.toContain(`"${weak}"`);
});

it('S1-1: a HISTORY_SECRET of exactly 32 characters is accepted', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const secret = 'h'.repeat(32);
  expect((await call('/gca-history', 'GET', secret, { HISTORY_SECRET: secret })).status).toBe(200);
  expect(log).not.toHaveBeenCalled();
  expect((await call('/gca-history', 'GET', secret.slice(1), { HISTORY_SECRET: secret.slice(1) })).status).toBe(503);
  expect(log).toHaveBeenCalledOnce();
});

it('returns an empty history before reminders have run', async () => {
  const response = await SELF.fetch('https://example.com/gca-history', { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ records: [], nextCursor: null });
});

it('returns attempted deliveries with occurrence and explicitly distinguishes last seen time', async () => {
  await seed();
  const response = await SELF.fetch('https://example.com/gca-history', { headers });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ records: [{ sessionKey: '600001:123456', status: 'sent', attempts: 1, lastSeenAt: 1000, occurrence: 1 }], nextCursor: null, note: expect.stringContaining('not the delivery time') });
});

it('paginates without dropping or repeating a connection', async () => {
  await seed(105);
  const first = await (await SELF.fetch('https://example.com/gca-history', { headers })).json() as { records: unknown[]; nextCursor: string };
  expect(first.records).toHaveLength(100);
  const second = await (await SELF.fetch(`https://example.com/gca-history?after=${first.nextCursor}`, { headers })).json() as { records: unknown[]; nextCursor: string | null };
  expect(second.records).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.records, ...second.records].map((row) => JSON.stringify(row))).size).toBe(105);
});

it('returns a generic failure if the coordinator is unavailable', async () => {
  await seed();
  await runInDurableObject(env.POLL_COORDINATOR.getByName(COORDINATOR_NAME), (_instance, ctx) => {
    vi.spyOn(ctx.storage.sql, 'exec').mockImplementationOnce(() => {
      throw new Error('synthetic private storage details');
    });
  });
  const response = await SELF.fetch('https://example.com/gca-history', { headers });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'coordinator unavailable' });
});

it('rejects invalid cursors and write methods', async () => {
  expect((await SELF.fetch('https://example.com/gca-history?after=invalid', { headers })).status).toBe(400);
  expect((await SELF.fetch('https://example.com/gca-history', { method: 'POST', headers })).status).toBe(405);
});
