import { env } from 'cloudflare:workers';
import { SELF, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import worker from '../src/index';
import { COORDINATOR_NAME } from '../src/config';

const headers = { authorization: 'Bearer test-poll-secret' };
afterEach(reset);

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
  const response = await worker.fetch(new Request('https://example.com/gca-history', { headers }), { ...env, POLL_SECRET: '' }, {} as ExecutionContext);
  expect(response.status).toBe(503);
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

it('rejects invalid cursors and write methods', async () => {
  expect((await SELF.fetch('https://example.com/gca-history?after=invalid', { headers })).status).toBe(400);
  expect((await SELF.fetch('https://example.com/gca-history', { method: 'POST', headers })).status).toBe(405);
});
