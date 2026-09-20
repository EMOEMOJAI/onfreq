import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { COORDINATOR_NAME, POLL_SNAPSHOT_KEY } from '../src/config';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it.each([
  ['/poll', 'POST', 'poll'],
  ['/health', 'GET', 'getHealth'],
  ['/gca-history', 'GET', 'getGcaHistory'],
  ['/gca-history/cleanup', 'GET', 'cleanupGcaHistory'],
  ['/gca-history/cleanup', 'POST', 'cleanupGcaHistory'],
])('routes %s %s to the privately configured coordinator', async (path, method, called) => {
  const coordinator = {
    poll: vi.fn(async () => ({ skipped: true })),
    getHealth: vi.fn(async () => ({ ok: true })),
    getGcaHistory: vi.fn(async () => ({ records: [], nextCursor: null })),
    cleanupGcaHistory: vi.fn(async () => ({ busy: false })),
  };
  const getByName = vi.fn(() => coordinator);
  const configured = { ...env, COORDINATOR_NAME: ' preserved-state ',
    POLL_COORDINATOR: { getByName } as unknown as Env['POLL_COORDINATOR'] };
  const response = await worker.fetch(new Request(`https://example.test${path}`, {
    method, headers: { authorization: 'Bearer test-poll-secret', 'x-onfreq-confirm': 'delete-old-copies' },
  }), configured, createExecutionContext());
  expect(response.status).toBe(200);
  expect(getByName).toHaveBeenCalledExactlyOnceWith('preserved-state');
  expect(coordinator[called as keyof typeof coordinator]).toHaveBeenCalledOnce();
});

it.each(['', '   ', 'preserved-state'])('uses the same identity for cron with override %j', async (name) => {
  const poll = vi.fn(async () => ({ skipped: true }));
  const getByName = vi.fn(() => ({ poll }));
  await worker.scheduled(createScheduledController(), { ...env, COORDINATOR_NAME: name,
    POLL_COORDINATOR: { getByName } as unknown as Env['POLL_COORDINATOR'] }, createExecutionContext());
  expect(getByName).toHaveBeenCalledExactlyOnceWith(name.trim() || COORDINATOR_NAME);
  expect(poll).toHaveBeenCalledOnce();
});

it('reads existing durable state through the override without starting a new coordinator', async () => {
  const selected = env.POLL_COORDINATOR.getByName('preserved-state');
  const lastSuccessfulPollAt = Date.now();
  await runInDurableObject(selected, (_, ctx) => ctx.storage.put(POLL_SNAPSHOT_KEY, {
    state: {}, lastPollStartedAt: lastSuccessfulPollAt, lastSuccessfulPollAt,
  }));
  const configured = { ...env, COORDINATOR_NAME: 'preserved-state' };
  const request = (path: string, method = 'GET') => worker.fetch(new Request(`https://example.test${path}`, {
    method, headers: { authorization: 'Bearer test-poll-secret' },
  }), configured, createExecutionContext());
  expect(await (await request('/health')).json()).toMatchObject({ ok: true, lastSuccessfulPollAt });
  expect(await (await request('/poll', 'POST')).json()).toMatchObject({ ok: true, skipped: true });
  expect(await runInDurableObject(env.POLL_COORDINATOR.getByName(COORDINATOR_NAME),
    (_, ctx) => ctx.storage.get(POLL_SNAPSHOT_KEY))).toBeUndefined();
});
