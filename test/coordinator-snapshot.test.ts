import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { COORDINATOR_NAME, POLL_SNAPSHOT_KEY } from '../src/config';
import { PollCoordinator, type PollSnapshot } from '../src/coordinator';

// S1-3: a runPoll precondition throw must keep closeouts, roster pages, their
// post budgets and role-ping cooldowns, and a failed write must not mask it.
const stub = () => env.POLL_COORDINATOR.getByName(COORDINATOR_NAME);
const CONFIG_ERROR = 'Discord bot token and notification channels are required';
const misconfigured = { ...env, DISCORD_CHANNEL_IDS: '' };
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function seededSnapshot(now: number) {
  const message = { channelId: '900000000000000001', messageId: '900000000000000101' };
  return {
    state: { 'XA_SYNTHETIC_CTR': { callsign: 'XA_SYNTHETIC_CTR', since: '2026-01-01T00:00:00.000Z', missed: 0 } },
    pendingOffline: [{
      event: { callsign: 'XA_SYNTHETIC_TWR', since: '2026-01-01T00:00:00.000Z', missed: 2,
        endedAt: '2026-01-01T01:00:00.000Z', durationSeconds: 3600 },
      messages: [message],
      channelIds: [message.channelId],
      attemptsByChannel: { [message.channelId]: 1 },
    }],
    rosterMessages: [{ ...message, messageId: '900000000000000102', parentMessageId: message.messageId, page: 0 }],
    rosterPostAttempts: [{ channelId: message.channelId, parentMessageId: message.messageId, page: 1, attempts: 2 }],
    rolePings: { [message.channelId]: now - 60_000 },
    lastPollStartedAt: now - 10 * 60_000,
    lastSuccessfulPollAt: now - 10 * 60_000,
  } as unknown as PollSnapshot;
}

it('S1-3: a config throw preserves pending closeouts, roster pages, post budgets and role pings', async () => {
  const now = Date.now();
  const seeded = seededSnapshot(now);
  await runInDurableObject(stub(), async (_, ctx) => {
    await ctx.storage.put(POLL_SNAPSHOT_KEY, seeded);
    const coordinator = new PollCoordinator(ctx, misconfigured);
    await expect(coordinator.poll()).rejects.toThrow(CONFIG_ERROR);
    const stored = await ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY);
    expect(stored).toEqual({ ...seeded, lastPollStartedAt: expect.any(Number), error: CONFIG_ERROR });
    expect(stored?.lastPollStartedAt).toBeGreaterThanOrEqual(now);
    // The recorded cadence still throttles the next trigger, which reports the stored error.
    await expect(new PollCoordinator(ctx, env).poll()).rejects.toThrow(CONFIG_ERROR);
    expect(await ctx.storage.get(POLL_SNAPSHOT_KEY)).toEqual(stored);
  });
});

it('S1-3: a failed snapshot write rethrows the original error and logs no stored contents', async () => {
  const now = Date.now();
  const seeded = seededSnapshot(now);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await runInDurableObject(stub(), async (_, ctx) => {
    await ctx.storage.put(POLL_SNAPSHOT_KEY, seeded);
    const put = vi.spyOn(ctx.storage, 'put').mockRejectedValueOnce(new Error('synthetic storage put failure'));
    const coordinator = new PollCoordinator(ctx, misconfigured);
    await expect(coordinator.poll()).rejects.toThrow(CONFIG_ERROR);
    expect(put).toHaveBeenCalledOnce();
    put.mockRestore();
    // The earlier snapshot is untouched rather than replaced by a partial one.
    expect(await ctx.storage.get(POLL_SNAPSHOT_KEY)).toEqual(seeded);
  });
  const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  expect(lines).toEqual([{ event: 'poll_snapshot_put_failed', error: 'Error: synthetic storage put failure' }]);
  const logged = JSON.stringify(log.mock.calls);
  for (const secretish of ['XA_SYNTHETIC', '900000000000000', CONFIG_ERROR]) expect(logged).not.toContain(secretish);
});

it('S11-13: a future lastPollStartedAt does not throttle polling indefinitely', async () => {
  const now = Date.now();
  const future = now + 24 * 60 * 60_000;
  await runInDurableObject(stub(), async (_, ctx) => {
    await ctx.storage.put(POLL_SNAPSHOT_KEY, { state: {}, lastPollStartedAt: future, lastSuccessfulPollAt: now - 60_000 } satisfies PollSnapshot);
    // Reaching runPoll (here, its config precondition) proves the poll was not skipped.
    await expect(new PollCoordinator(ctx, misconfigured).poll()).rejects.toThrow(CONFIG_ERROR);
    const stored = await ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY);
    expect(stored?.lastPollStartedAt).toBeGreaterThanOrEqual(now);
    expect(stored?.lastPollStartedAt).toBeLessThanOrEqual(Date.now());
  });
});

it('S11-13: a recent past lastPollStartedAt still throttles', async () => {
  await runInDurableObject(stub(), async (_, ctx) => {
    const snapshot = { state: {}, lastPollStartedAt: Date.now() - 1_000 } satisfies PollSnapshot;
    await ctx.storage.put(POLL_SNAPSHOT_KEY, snapshot);
    await expect(new PollCoordinator(ctx, misconfigured).poll()).resolves.toEqual({ skipped: true });
    expect(await ctx.storage.get(POLL_SNAPSHOT_KEY)).toEqual(snapshot);
  });
});

it.each([
  ['an empty Error', () => new Error(''), 'Error'],
  ['an empty TypeError', () => new TypeError(), 'TypeError'],
  ['an empty non-Error', () => '', 'poll failed'],
])('C60: %s from runPoll still records an error marker', async (_label, thrown, marker) => {
  const now = Date.now();
  const seeded = seededSnapshot(now);
  const throwing = Object.defineProperty({ ...env }, 'DISCORD_CHANNEL_IDS', {
    get() { throw thrown(); },
  }) as Env;
  await runInDurableObject(stub(), async (_, ctx) => {
    await ctx.storage.put(POLL_SNAPSHOT_KEY, seeded);
    await expect(new PollCoordinator(ctx, throwing).poll()).rejects.toSatisfy((err) => err === '' || err instanceof Error);
    const stored = await ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY);
    expect(stored).toEqual({ ...seeded, lastPollStartedAt: expect.any(Number), error: marker });
    // The throttled next trigger reports the failure instead of a silent skip.
    await expect(new PollCoordinator(ctx, env).poll()).rejects.toThrow(marker);
  });
});
