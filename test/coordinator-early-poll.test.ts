import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import worker from '../src/index';
import {
  COORDINATOR_NAME, EARLY_POLL_KEY, IVAO_ATC_SUMMARY_URL, POLL_SNAPSHOT_KEY, SCHEDULER_SEEN_KEY,
} from '../src/config';
import { PollCoordinator, resetEarlyPollLogForTests, type PollSnapshot } from '../src/coordinator';
import { resetTokenCache } from '../src/ivao';
import { resetWebhookDebounceForTests, resetWebhookLogForTests } from '../src/webhook';
import { AUTH_HEADERS } from './helpers';

// Simulated time stays well ahead of the real clock and starts on an hour, so
// a scheduled alarm only ever runs through runDurableObjectAlarm.
const T0 = Date.UTC(2031, 0, 1, 0, 0, 0);
const SECRET = 'synthetic-ivao-webhook-signing-secret-vitest';
const stub = () => env.POLL_COORDINATOR.getByName(COORDINATOR_NAME);
const misconfigured = { ...env, DISCORD_CHANNEL_IDS: '' };

let now: number;
let network: MockInstance<typeof fetch>;
let release: (() => void) | undefined;
let entered: (() => void) | undefined;
let log: MockInstance<typeof console.error>;

beforeEach(() => {
  resetTokenCache();
  resetEarlyPollLogForTests();
  resetWebhookLogForTests();
  resetWebhookDebounceForTests();
  now = T0;
  release = undefined;
  entered = undefined;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  network = vi.fn<typeof fetch>(async (input) => {
    if (String(input) !== IVAO_ATC_SUMMARY_URL) throw new Error('Unexpected network request');
    if (entered) {
      const gate = new Promise<void>((resolve) => { release = resolve; });
      entered();
      entered = undefined;
      await gate;
    }
    // One unmonitored controller: a reachable feed with nothing to announce.
    return Response.json([{
      id: 1, userId: 100, callsign: 'EGLL_TWR', atcSession: { frequency: 118.1, position: 'TWR' },
      atcPosition: { atcCallsign: 'Test Station' }, subcenter: null,
    }]);
  });
  vi.stubGlobal('fetch', network);
});

afterEach(async () => {
  await runInDurableObject(stub(), (_, ctx) => ctx.storage.deleteAlarm());
  resetTokenCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

const feedFetches = () => network.mock.calls.filter(([url]) => String(url) === IVAO_ATC_SUMMARY_URL).length;
const storage = <T>(read: (ctx: DurableObjectState) => Promise<T> | T) => runInDurableObject(stub(), (_, ctx) => read(ctx));
const alarmAt = () => storage((ctx) => ctx.storage.getAlarm());
const budget = () => storage((ctx) => ctx.storage.get<{ hourStart: number; count: number }>(EARLY_POLL_KEY));
const snapshot = () => storage((ctx) => ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY));
const seed = (value: PollSnapshot) => storage((ctx) => ctx.storage.put(POLL_SNAPSHOT_KEY, value));
const seen = () => storage((ctx) => ctx.storage.get(SCHEDULER_SEEN_KEY));
const seedSeen = (at: number) => storage((ctx) => ctx.storage.put(SCHEDULER_SEEN_KEY, at));
const request = () => storage((ctx) => coordinator()(ctx).requestEarlyPoll());
const httpPoll = () => worker.fetch(new Request('https://example.test/poll', { method: 'POST', headers: AUTH_HEADERS }),
  env, createExecutionContext());
const coordinator = (target: Env = env) => (ctx: DurableObjectState) => new PollCoordinator(ctx, target);
const lines = () => log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

const cron = () => worker.scheduled(createScheduledController({ cron: '* * * * *' }), env, createExecutionContext());
const health = () => worker.fetch(new Request('https://example.test/health', { headers: AUTH_HEADERS }), env,
  createExecutionContext());

async function webhook(): Promise<Response> {
  const t = Math.floor(now / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'x-event-id': '00000000-0000-4000-8000-000000000002',
    'x-event-type': 'tracker.session.started',
  };
  const body = '{"sessionId":2,"callsign":"XA_SYN_CTR","userId":100,"connectionType":"ATC","resume":false}';
  const h = 'content-type x-event-id x-event-type';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key,
    encoder.encode(`${t}.${h}.${h.split(' ').map((name) => headers[name]).join('.')}.${body}`)));
  headers['x-hook0-signature'] = `t=${t},h=${h},v1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return worker.fetch(new Request('https://example.test/ivao/webhook', { method: 'POST', headers, body }), env,
    createExecutionContext());
}

/** Run the pending alarm once simulated time has reached it, as the platform would. */
async function fireDueAlarm(): Promise<boolean> {
  const at = await alarmAt();
  return at !== null && at <= now ? runDurableObjectAlarm(stub()) : false;
}

describe('requestEarlyPoll', () => {
  it('schedules one alarm 20 s ahead before any poll, and keeps it on repeated requests', async () => {
    await storage((ctx) => coordinator()(ctx).requestEarlyPoll());
    expect(await alarmAt()).toBe(T0 + 20_000);
    now += 5_000;
    await storage((ctx) => coordinator()(ctx).requestEarlyPoll());
    expect(await alarmAt()).toBe(T0 + 20_000);
  });

  it('waits at least 30 s after the last poll start', async () => {
    await seed({ state: {}, lastPollStartedAt: T0 - 2_000 });
    await storage((ctx) => coordinator()(ctx).requestEarlyPoll());
    expect(await alarmAt()).toBe(T0 + 28_000);
  });

  it.each([40_000, 30_000])('is a no-op when the next cron poll is as soon (cron %i ms ago)', async (ago) => {
    await seed({ state: {}, lastPollStartedAt: T0 - ago });
    await seedSeen(T0 - ago);
    await request();
    expect(await alarmAt()).toBeNull();
  });

  it('schedules when the next cron poll is still more than 10 s later', async () => {
    await seed({ state: {}, lastPollStartedAt: T0 - 29_999 });
    await seedSeen(T0 - 29_999);
    await request();
    expect(await alarmAt()).toBe(T0 + 20_000);
  });

  it('measures the next cron from its heartbeat, not from the last poll', async () => {
    // The last poll ran 40 s ago; the cron called 10 s ago, so its next poll is 50 s away.
    await seed({ state: {}, lastPollStartedAt: T0 - 40_000 });
    await seedSeen(T0 - 10_000);
    await request();
    expect(await alarmAt()).toBe(T0 + 20_000);
  });

  it.each([
    ['stale', T0 - 60_000],
    ['in the future', T0 + 60_000],
  ])('schedules even near the expected cron when the heartbeat is %s', async (_label, at) => {
    await seed({ state: {}, lastPollStartedAt: T0 - 45_000 });
    await seedSeen(at);
    await request();
    expect(await alarmAt()).toBe(T0 + 20_000);
  });

  it('does not trust a future poll start time', async () => {
    await seed({ state: {}, lastPollStartedAt: T0 + 24 * 60 * 60_000 });
    await storage((ctx) => coordinator()(ctx).requestEarlyPoll());
    expect(await alarmAt()).toBe(T0 + 20_000);
  });

  it('stops after 20 early polls in a clock hour and logs the cap once per hour', async () => {
    await storage((ctx) => ctx.storage.put(EARLY_POLL_KEY, { hourStart: T0, count: 20 }));
    now = T0 + 59 * 60_000;
    for (let i = 0; i < 3; i++) await request();
    expect(await alarmAt()).toBeNull();
    expect(lines()).toEqual([{ event: 'early_poll_capped' }]);
    // A new clock hour has a fresh budget.
    now = T0 + 60 * 60_000;
    await request();
    expect(await alarmAt()).toBe(now + 20_000);
    // Spending that budget too logs the cap again, once.
    await storage((ctx) => ctx.storage.deleteAlarm());
    await storage((ctx) => ctx.storage.put(EARLY_POLL_KEY, { hourStart: now, count: 20 }));
    for (let i = 0; i < 3; i++) await request();
    expect(await alarmAt()).toBeNull();
    expect(lines()).toEqual([{ event: 'early_poll_capped' }, { event: 'early_poll_capped' }]);
  });

  it('allows the 20th early poll of the hour', async () => {
    await storage((ctx) => ctx.storage.put(EARLY_POLL_KEY, { hourStart: T0, count: 19 }));
    await storage((ctx) => coordinator()(ctx).requestEarlyPoll());
    expect(await alarmAt()).toBe(T0 + 20_000);
  });

  it('is a no-op while a poll is in flight', async () => {
    await storage(async (ctx) => {
      const instance = coordinator()(ctx);
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const running = instance.poll();
      await ready;
      await instance.requestEarlyPoll();
      release!();
      await running;
    });
    expect(await alarmAt()).toBeNull();
  });
});

describe('early poll alarm', () => {
  it('runs a poll 30 s after a cron poll that the 55 s throttle would skip', async () => {
    await cron();
    expect(feedFetches()).toBe(1);
    now = T0 + 10_000;
    expect((await webhook()).status).toBe(204);
    expect(await alarmAt()).toBe(T0 + 30_000);
    now = T0 + 30_000;
    // The regular throttle still skips this trigger.
    await expect(stub().poll()).resolves.toEqual({ skipped: true });
    expect(feedFetches()).toBe(1);
    expect(await fireDueAlarm()).toBe(true);
    expect(feedFetches()).toBe(2);
    // An early poll carries the scheduled start forward instead of replacing it.
    expect(await snapshot()).toMatchObject({ lastPollStartedAt: now, lastScheduledPollStartedAt: T0, lastSuccessfulPollAt: now });
    expect(await budget()).toEqual({ hourStart: T0, count: 1 });
    expect(await alarmAt()).toBeNull();
    // Early polls are not scheduler heartbeats.
    expect(await storage((ctx) => ctx.storage.get(SCHEDULER_SEEN_KEY))).toBe(T0);
  });

  it('skips without counting when a poll ran less than 30 s ago', async () => {
    await cron();
    now = T0 + 25_000;
    await storage((ctx) => ctx.storage.setAlarm(now));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(feedFetches()).toBe(1);
    expect(await budget()).toBeUndefined();
  });

  it('stays silent when a throttled alarm only rethrows a stored error', async () => {
    await seed({ state: {}, lastPollStartedAt: T0 - 10_000, error: 'synthetic stored error' });
    await storage((ctx) => ctx.storage.setAlarm(now));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(feedFetches()).toBe(0);
    expect(lines()).toEqual([]);
    expect(await budget()).toBeUndefined();
  });

  it('catches poll errors so the platform does not retry, and counts the attempt', async () => {
    await storage(async (ctx) => {
      await expect(coordinator(misconfigured)(ctx).alarm()).resolves.toBeUndefined();
    });
    expect(lines()).toEqual([{ event: 'early_poll_failed', error: 'Error' }]);
    expect(await budget()).toEqual({ hourStart: T0, count: 1 });
    expect(await snapshot()).toMatchObject({ lastPollStartedAt: T0, error: expect.any(String) });
    // Through the runtime: a failing feed leaves no alarm behind to retry.
    now += 60_000;
    network.mockResolvedValueOnce(new Response('synthetic outage', { status: 500 }));
    await storage((ctx) => ctx.storage.setAlarm(now));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await alarmAt()).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic outage');
  });

  it('logs only the error type when the budget write fails', async () => {
    await storage(async (ctx) => {
      const put = ctx.storage.put.bind(ctx.storage);
      vi.spyOn(ctx.storage, 'put').mockImplementation(((key: string, value: unknown) => key === EARLY_POLL_KEY
        ? Promise.reject(new TypeError('synthetic private storage detail')) : put(key, value)) as typeof ctx.storage.put);
      await expect(coordinator()(ctx).alarm()).resolves.toBeUndefined();
    });
    expect(lines()).toEqual([{ event: 'early_poll_failed', error: 'TypeError' }]);
  });

  it('makes cleanup report busy while an alarm poll runs', async () => {
    await storage(async (ctx) => {
      const instance = coordinator()(ctx);
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const running = instance.alarm();
      await ready;
      try {
        expect(instance.cleanupGcaHistory(false)).toEqual({ busy: true });
      } finally {
        release!();
        await running;
      }
      expect(instance.cleanupGcaHistory(false)).toMatchObject({ busy: false });
    });
  });

  it('skips a concurrent cron during an alarm poll without a second run, and still records the heartbeat', async () => {
    await storage(async (ctx) => {
      const instance = coordinator()(ctx);
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const running = instance.alarm();
      await ready;
      const scheduled = instance.poll({ scheduled: true });
      await vi.waitFor(async () => expect(await ctx.storage.get(SCHEDULER_SEEN_KEY)).toBe(T0));
      release!();
      await expect(scheduled).resolves.toEqual({ skipped: true });
      await running;
    });
    expect(feedFetches()).toBe(1);
    expect(await budget()).toEqual({ hourStart: T0, count: 1 });
  });
});

describe('cadence', () => {
  it.each([20_000, 40_000])('without webhooks still suppresses a second scheduler %i ms after the cron', async (offset) => {
    for (let minute = 0; minute < 3; minute++) {
      now = T0 + minute * 60_000;
      await cron();
      expect(feedFetches()).toBe(minute + 1);
      now += offset;
      expect(await (await httpPoll()).json()).toMatchObject({ ok: true, skipped: true });
      expect(feedFetches()).toBe(minute + 1);
    }
  });

  it('lets the next cron poll after an early poll 30 s past the cron (cron 0, early 30, cron 60, webhook 70)', async () => {
    await cron();
    now = T0 + 10_000;
    await webhook();
    expect(await alarmAt()).toBe(T0 + 30_000);
    now = T0 + 30_000;
    expect(await fireDueAlarm()).toBe(true);
    expect(feedFetches()).toBe(2);
    now = T0 + 60_000;
    await cron();
    expect(feedFetches()).toBe(3);
    expect(await snapshot()).toMatchObject({ lastPollStartedAt: now, lastScheduledPollStartedAt: now });
    now = T0 + 70_000;
    expect((await webhook()).status).toBe(204);
    expect(await alarmAt()).toBe(T0 + 90_000);
  });

  it('lets an early poll 40 s past the cron delay the next cron poll by one minute at most', async () => {
    await cron();
    now = T0 + 20_000;
    await webhook();
    expect(await alarmAt()).toBe(T0 + 40_000);
    now = T0 + 40_000;
    expect(await fireDueAlarm()).toBe(true);
    // Less than 30 s after the early poll: skipped, but the heartbeat is recorded.
    now = T0 + 60_000;
    await cron();
    expect(feedFetches()).toBe(2);
    expect(await seen()).toBe(T0 + 60_000);
    now = T0 + 120_000;
    await cron();
    expect(feedFetches()).toBe(3);
  });

  it('falls back to the last poll start for a snapshot without a scheduled start', async () => {
    await seed({ state: {}, lastPollStartedAt: T0 - 40_000 });
    await expect(stub().poll({ scheduled: true })).resolves.toEqual({ skipped: true });
    await storage((ctx) => ctx.storage.setAlarm(now));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(feedFetches()).toBe(1);
    expect(await snapshot()).toMatchObject({ lastPollStartedAt: T0, lastScheduledPollStartedAt: T0 - 40_000 });
  });

  it('does not rewrite a heartbeat recorded less than 5 s ago', async () => {
    await cron();
    now = T0 + 4_999;
    await httpPoll();
    expect(await seen()).toBe(T0);
    now = T0 + 5_000;
    await httpPoll();
    expect(await seen()).toBe(T0 + 5_000);
  });

  it('still polls when the heartbeat cannot be stored, logging the failure once per isolate', async () => {
    await storage(async (ctx) => {
      const put = ctx.storage.put.bind(ctx.storage);
      vi.spyOn(ctx.storage, 'put').mockImplementation(((key: string, value: unknown) => key === SCHEDULER_SEEN_KEY
        ? Promise.reject(new TypeError('synthetic private storage detail')) : put(key, value)) as typeof ctx.storage.put);
      const instance = coordinator()(ctx);
      await expect(instance.poll({ scheduled: true })).resolves.toEqual({ skipped: false });
      now += 60_000;
      await expect(instance.poll({ scheduled: true })).resolves.toEqual({ skipped: false });
    });
    expect(feedFetches()).toBe(2);
    expect(lines()).toEqual([{ event: 'scheduler_heartbeat_failed', error: 'TypeError' }]);
  });
});

describe('health with webhook-driven polls', () => {
  it('stays healthy with cron every minute and webhooks every 10 s for 12 minutes, polling every cron tick', async () => {
    for (let step = 0; step <= 72; step++) {
      now = T0 + step * 10_000;
      await fireDueAlarm();
      if (step % 6 === 0) {
        // Every early poll runs at most 30 s after the cron, so no cron tick is skipped.
        const before = feedFetches();
        await cron();
        expect(feedFetches()).toBe(before + 1);
      }
      expect((await webhook()).status).toBe(204);
      const response = await health();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, lastSuccessfulPollAt: expect.any(Number), maxAgeSeconds: 300 });
    }
    // 13 cron polls, and one early poll 30 s after each of the first 12.
    expect(await budget()).toEqual({ hourStart: T0, count: 12 });
    expect(feedFetches()).toBe(13 + 12);
    expect(lines()).toEqual([]);
  });

  it('turns unhealthy within five minutes of the cron stopping while early polls continue', async () => {
    await cron();
    let step = 0;
    for (; ; step++) {
      now = T0 + step * 10_000;
      await fireDueAlarm();
      await webhook();
      if ((await health()).status === 503) break;
      expect(step).toBeLessThan(30);
    }
    expect(now - T0).toBe(300_000);
    // Polling itself is still fresh: only the missing scheduler fails health.
    expect(now - (await snapshot())!.lastSuccessfulPollAt!).toBeLessThan(60_000);
    expect(feedFetches()).toBeGreaterThan(5);
  });

  it('keeps the legacy rule while no heartbeat has been recorded', async () => {
    await seed({ state: {}, lastSuccessfulPollAt: T0 - 1_000 });
    expect((await health()).status).toBe(200);
    await stub().getHealth();
    expect(await storage((ctx) => ctx.storage.get(SCHEDULER_SEEN_KEY))).toBeUndefined();
  });

  it.each([
    ['stale', T0 - 300_000],
    ['in the future', T0 + 1],
    ['not a number', 'synthetic'],
  ])('is unhealthy with a %s heartbeat even after a recent success', async (_label, seen) => {
    await seed({ state: {}, lastSuccessfulPollAt: T0 - 1_000 });
    await storage((ctx) => ctx.storage.put(SCHEDULER_SEEN_KEY, seen));
    expect((await health()).status).toBe(503);
    await storage((ctx) => ctx.storage.put(SCHEDULER_SEEN_KEY, T0 - 299_999));
    expect((await health()).status).toBe(200);
  });

  it('records the heartbeat from POST /poll and cron, never from health reads', async () => {
    await health();
    expect(await storage((ctx) => ctx.storage.get(SCHEDULER_SEEN_KEY))).toBeUndefined();
    await worker.fetch(new Request('https://example.test/poll', { method: 'POST', headers: AUTH_HEADERS }), env,
      createExecutionContext());
    expect(await storage((ctx) => ctx.storage.get(SCHEDULER_SEEN_KEY))).toBe(T0);
    now += 10_000;
    await cron();
    expect(await storage((ctx) => ctx.storage.get(SCHEDULER_SEEN_KEY))).toBe(T0 + 10_000);
    expect(feedFetches()).toBe(1);
  });
});
