import { env } from 'cloudflare:workers';
import { SELF, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { COORDINATOR_NAME } from '../src/config';
import { PollCoordinator } from '../src/coordinator';
import { cleanupGcaCopies } from '../src/retention';
import { HISTORY_AUTH_HEADERS } from './helpers';

const headers = HISTORY_AUTH_HEADERS;
const stub = () => env.POLL_COORDINATOR.getByName(COORDINATOR_NAME);
const endpoint = 'https://example.com/gca-history/cleanup';
const now = Date.now();
afterEach(reset);

async function seed(count = 1) {
  await runInDurableObject(stub(), (_, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE gca_reminders (session_key TEXT PRIMARY KEY, status TEXT, last_seen INTEGER, attempts INTEGER)');
    sql.exec('CREATE TABLE gca_occurrences (session_key TEXT PRIMARY KEY, occurrence INTEGER)');
    sql.exec('CREATE TABLE gca_copies (session_key TEXT PRIMARY KEY, payload TEXT, recipient_id TEXT, status TEXT)');
    for (let i = 0; i < count; i++) {
      const key = `600001:${1000 + i}`;
      sql.exec('INSERT INTO gca_reminders VALUES (?, ?, ?, ?)', key, 'sent', now - 31 * 86_400_000, 1);
      sql.exec('INSERT INTO gca_occurrences VALUES (?, ?)', key, i + 1);
      sql.exec('INSERT INTO gca_copies VALUES (?, ?, ?, ?)', key, 'synthetic message', 'synthetic recipient', 'pending');
    }
  });
}

it('requires auth and explicit confirmation; GET only previews', async () => {
  await seed();
  expect((await SELF.fetch(endpoint)).status).toBe(401);
  expect((await SELF.fetch(endpoint, { method: 'POST', headers })).status).toBe(400);
  expect((await SELF.fetch(endpoint, { method: 'DELETE', headers })).status).toBe(405);
  const preview = await SELF.fetch(endpoint, { headers });
  expect(preview.headers.get('cache-control')).toBe('no-store');
  expect(await preview.json()).toMatchObject({ applied: false, eligible: 1, deleted: 0 });
  const applied = await SELF.fetch(endpoint, { method: 'POST', headers: { ...headers, 'x-onfreq-confirm': 'delete-old-copies' } });
  expect(await applied.json()).toMatchObject({ applied: true, deleted: 1 });
  await runInDurableObject(stub(), (_, ctx) => {
    expect(ctx.storage.sql.exec('SELECT * FROM gca_reminders').toArray()).toHaveLength(1);
    expect(ctx.storage.sql.exec('SELECT * FROM gca_occurrences').toArray()).toHaveLength(1);
    expect(ctx.storage.sql.exec('SELECT * FROM gca_copies').toArray()).toHaveLength(0);
  });
});

it('keeps recent copies, copies without known age, and nonterminal reminders', async () => {
  await seed();
  await runInDurableObject(stub(), (_, ctx) => {
    const sql = ctx.storage.sql;
    for (const [key, status, lastSeen] of [
      ['600002:1', 'sent', now - 30 * 86_400_000],
      ['600003:1', 'pending', now - 40 * 86_400_000],
    ] as const) {
      sql.exec('INSERT INTO gca_reminders VALUES (?, ?, ?, 0)', key, status, lastSeen);
      sql.exec("INSERT INTO gca_copies VALUES (?, 'payload', 'recipient', 'pending')", key);
    }
    sql.exec("INSERT INTO gca_copies VALUES ('600004:1', 'payload', 'recipient', 'reserved')");
    expect(cleanupGcaCopies(ctx.storage, true, now)).toMatchObject({ deleted: 1 });
    expect(sql.exec('SELECT * FROM gca_copies').toArray()).toHaveLength(3);
  });
});

it('also removes recent unsent copies addressed to anyone but the current staff account', async () => {
  const CURRENT = '100000000000000011';
  const PREVIOUS = '100000000000000012';
  await seed(0);
  await runInDurableObject(stub(), (_instance, ctx) => {
    const sql = ctx.storage.sql;
    for (const [key, recipient, status] of [
      ['600002:1', PREVIOUS, 'pending'], ['600002:2', PREVIOUS, 'reserved'], ['600002:3', PREVIOUS, 'sent'],
      ['600002:4', CURRENT, 'pending'],
    ] as const) {
      sql.exec('INSERT INTO gca_reminders VALUES (?, ?, ?, 1)', key, 'sent', now);
      sql.exec('INSERT INTO gca_occurrences VALUES (?, 1)', key);
      sql.exec("INSERT INTO gca_copies VALUES (?, 'payload', ?, ?)", key, recipient, status);
    }
    // Without a valid current account only the age rule applies.
    expect(cleanupGcaCopies(ctx.storage, true, now, '')).toMatchObject({ deleted: 0 });
    expect(cleanupGcaCopies(ctx.storage, true, now, 'not-an-id')).toMatchObject({ deleted: 0 });
    // The coordinator passes its configured account.
    const coordinator = new PollCoordinator(ctx, { ...env, GCA_COPY_USER_ID: CURRENT });
    expect(coordinator.cleanupGcaHistory(true)).toMatchObject({ busy: false, deleted: 2 });
    expect(sql.exec('SELECT session_key FROM gca_copies ORDER BY session_key').toArray().map((row) => row.session_key))
      .toEqual(['600002:3', '600002:4']);
    expect(sql.exec('SELECT * FROM gca_reminders').toArray()).toHaveLength(4);
    expect(sql.exec('SELECT * FROM gca_occurrences').toArray()).toHaveLength(4);
  });
});

it('limits each cleanup to 500 records and supports repeated calls', async () => {
  await seed(501);
  expect(await stub().cleanupGcaHistory(true)).toMatchObject({ deleted: 500, more: true });
  expect(await stub().cleanupGcaHistory(true)).toMatchObject({ deleted: 1, more: false });
  expect(await stub().cleanupGcaHistory(true)).toMatchObject({ deleted: 0, more: false });
});

it('is safe before GCA has ever run', async () => {
  expect(await stub().cleanupGcaHistory(true)).toMatchObject({ deleted: 0, eligible: 0 });
});
