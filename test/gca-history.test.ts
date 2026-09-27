import { env } from 'cloudflare:workers';
import { SELF, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { COORDINATOR_NAME } from '../src/config';
import { resetConfigInvalidLogForTests } from '../src/auth';
import { AUTH_HEADERS, callRoute, HISTORY_AUTH_HEADERS, HISTORY_ONLY, POLL_ONLY, seedGca } from './helpers';

const headers = HISTORY_AUTH_HEADERS;
beforeEach(resetConfigInvalidLogForTests);
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

const REMINDER = 'INSERT INTO gca_reminders (session_key, status, attempts, last_seen) VALUES (?, ?, ?, ?)';

async function seed(count = 1) {
  await seedGca((sql) => {
    for (let i = 0; i < count; i++) {
      const key = `600001:${123456 + i}`;
      sql.exec(REMINDER, key, 'sent', 1, 1000);
      sql.exec('INSERT INTO gca_occurrences (session_key, user_id, occurrence) VALUES (?, ?, ?)', key, 600001, i + 1);
    }
    for (const [key, status] of [['111111:1', 'baseline'], ['222222:1', 'unmapped'], ['333333:1', 'pending']]) {
      sql.exec(REMINDER, key, status, 0, 1000);
    }
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

const historyRoutes = [['/gca-history', 'GET'], ['/gca-history/cleanup', 'GET'], ['/gca-history/cleanup', 'POST']] as const;
const call = (path: string, method: string, token: string, overrides: Partial<Env>) =>
  callRoute(path, method, token, overrides, { 'x-onfreq-confirm': 'delete-old-copies' });

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
  // S1-4: distinctive 31-character value, so the non-leak assertions below are meaningful.
  const weak = 'short-history-secret-thirty-one';
  expect(weak).toHaveLength(31);
  const response = await call(path, method, weak, { HISTORY_SECRET: weak });
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).not.toMatch(/SECRET|600001/);
  expect(body).not.toContain(weak);
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: 'config_invalid', reason: 'HISTORY_SECRET_too_short' }]);
  expect(JSON.stringify(log.mock.calls)).not.toContain(weak);
});

it.each(historyRoutes)('S2-3: %s %s fails closed when HISTORY_SECRET reuses POLL_SECRET', async (path, method) => {
  await seed();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Surrounding whitespace is trimmed before comparison, like the secrets themselves.
  for (const reused of [POLL_ONLY, ` ${POLL_ONLY}\n`]) {
    const response = await call(path, method, POLL_ONLY, { POLL_SECRET: POLL_ONLY, HISTORY_SECRET: reused });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toMatch(/SECRET|600001/);
    expect(body).not.toContain(POLL_ONLY);
  }
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
    { event: 'config_invalid', reason: 'HISTORY_SECRET_reuses_POLL_SECRET' },
  ]);
  expect(JSON.stringify(log.mock.calls)).not.toContain(POLL_ONLY);
  // The poll token keeps working on its own routes.
  const health = await call('/health', 'GET', POLL_ONLY, { POLL_SECRET: POLL_ONLY, HISTORY_SECRET: POLL_ONLY });
  expect(health.status).not.toBe(401);
  expect(await health.json()).toMatchObject({ maxAgeSeconds: 300 });
});

it('S2-3: the shared test fixture uses distinct poll and history secrets', async () => {
  expect(headers.authorization).not.toBe(AUTH_HEADERS.authorization);
  expect((await SELF.fetch('https://example.com/gca-history', { headers: AUTH_HEADERS })).status).toBe(401);
  expect((await SELF.fetch('https://example.com/gca-history', { headers })).status).toBe(200);
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

it('S20-5: pagination cursors are opaque and never carry member ids', async () => {
  await seed(105);
  const first = await (await SELF.fetch('https://example.com/gca-history', { headers })).json() as { records: { sessionKey: string }[]; nextCursor: string };
  expect(first.nextCursor).toMatch(/^\d{1,12}$/);
  for (const record of first.records) expect(first.nextCursor).not.toContain(record.sessionKey.split(':')[0]);
  // The former member-id cursor shape is refused rather than silently reinterpreted.
  for (const legacy of ['600001:123555', '600001%3A123555', '1234567890123', '-1', '1.5']) {
    const response = await SELF.fetch(`https://example.com/gca-history?after=${legacy}`, { headers });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('600001');
  }
});

it('S20-5: pages follow stable first-detection order, independent of member ids and later updates', async () => {
  const keys = ['900009:1', '100001:5', '500005:3', '100001:2'];
  await seedGca((sql) => {
    for (const key of keys) sql.exec(REMINDER, key, 'sent', 1, 1000);
    for (let i = 0; i < 100; i++) sql.exec(REMINDER, `700007:${i}`, 'failed', 1, 1000);
  });
  const first = await (await SELF.fetch('https://example.com/gca-history', { headers })).json() as { records: { sessionKey: string }[]; nextCursor: string };
  expect(first.records.slice(0, 4).map((record) => record.sessionKey)).toEqual(keys);
  expect(first.records[0]).not.toHaveProperty('cursor');
  // An upsert of an already-returned row must not move it past the cursor.
  await runInDurableObject(env.POLL_COORDINATOR.getByName(COORDINATOR_NAME), (_instance, ctx) => {
    ctx.storage.sql.exec(`INSERT INTO gca_reminders (session_key, status, attempts, last_seen) VALUES ('100001:5', 'sent', 1, 2000)
      ON CONFLICT(session_key) DO UPDATE SET last_seen = excluded.last_seen, attempts = gca_reminders.attempts + 1`);
  });
  const second = await (await SELF.fetch(`https://example.com/gca-history?after=${first.nextCursor}`, { headers })).json() as { records: { sessionKey: string }[]; nextCursor: string | null };
  expect(second.records.map((record) => record.sessionKey)).toEqual(['700007:96', '700007:97', '700007:98', '700007:99']);
  expect(second.nextCursor).toBeNull();
});

it('rejects invalid cursors and write methods', async () => {
  expect((await SELF.fetch('https://example.com/gca-history?after=invalid', { headers })).status).toBe(400);
  expect((await SELF.fetch('https://example.com/gca-history', { method: 'POST', headers })).status).toBe(405);
});
