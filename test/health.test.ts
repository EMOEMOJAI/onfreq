import { env } from 'cloudflare:workers';
import { SELF, reset, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { POLL_SNAPSHOT_KEY, COORDINATOR_NAME } from '../src/config';

const headers = { authorization: 'Bearer test-poll-secret' };
const stub = () => env.POLL_COORDINATOR.getByName(COORDINATOR_NAME);
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('requires authentication, disables without a secret, and never caches health', async () => {
  for (const authorization of ['', 'Bearer wrong']) {
    const response = await SELF.fetch('https://example.com/health', { headers: { authorization } });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  const response = await worker.fetch(new Request('https://example.com/health', { headers }),
    { ...env, POLL_SECRET: '' }, {} as ExecutionContext);
  expect(response.status).toBe(503);
  expect((await SELF.fetch('https://example.com/health', { method: 'POST', headers })).status).toBe(405);
});

it('is unhealthy before the first successful poll and does not seed or poll', async () => {
  const response = await SELF.fetch('https://example.com/health', { headers });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, lastSuccessfulPollAt: null, maxAgeSeconds: 300 });
  expect(await runInDurableObject(stub(), (_, ctx) => ctx.storage.get(POLL_SNAPSHOT_KEY))).toBeUndefined();
});

it('reports durable success, expires at five minutes, and never exposes stored state or errors', async () => {
  const now = Date.now();
  await runInDurableObject(stub(), (_, ctx) => ctx.storage.put(POLL_SNAPSHOT_KEY, {
    state: { private: 'synthetic private state' }, lastSuccessfulPollAt: now, error: 'synthetic private error',
  }));
  await evictDurableObject(stub());
  const response = await SELF.fetch('https://example.com/health', { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ ok: true, lastSuccessfulPollAt: now, maxAgeSeconds: 300 });
  vi.spyOn(Date, 'now').mockReturnValue(now + 300_000);
  expect((await SELF.fetch('https://example.com/health', { headers })).status).toBe(503);
  vi.spyOn(Date, 'now').mockReturnValue(now - 1);
  expect((await SELF.fetch('https://example.com/health', { headers })).status).toBe(503);
});

it('does not treat a legacy cadence timestamp as a verified success', async () => {
  await runInDurableObject(stub(), (_, ctx) => ctx.storage.put(POLL_SNAPSHOT_KEY, {
    state: {}, lastPollStartedAt: Date.now(),
  }));
  expect((await SELF.fetch('https://example.com/health', { headers })).status).toBe(503);
});

it('returns a generic failure if storage is unavailable', async () => {
  await runInDurableObject(stub(), (_, ctx) => {
    vi.spyOn(ctx.storage, 'get').mockRejectedValueOnce(new Error('synthetic private storage details'));
  });
  const response = await SELF.fetch('https://example.com/health', { headers });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'coordinator unavailable' });
});
