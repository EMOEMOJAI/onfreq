import { env } from 'cloudflare:workers';
import { SELF, reset, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { POLL_SNAPSHOT_KEY, COORDINATOR_NAME } from '../src/config';
import { resetConfigInvalidLogForTests } from '../src/auth';
import { AUTH_HEADERS, callRoute as callPollRoute, HISTORY_ONLY, POLL_ONLY } from './helpers';

const headers = AUTH_HEADERS;
const stub = () => env.POLL_COORDINATOR.getByName(COORDINATOR_NAME);
beforeEach(resetConfigInvalidLogForTests);
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

// POLL_SECRET-gated routes. Synthetic, distinct secrets prove separation from HISTORY_SECRET.

it('S2-1: HISTORY_SECRET does not authorize /health or /poll', async () => {
  const overrides = { POLL_SECRET: POLL_ONLY, HISTORY_SECRET: HISTORY_ONLY };
  expect((await callPollRoute('/health', 'GET', HISTORY_ONLY, overrides)).status).toBe(401);
  expect((await callPollRoute('/poll', 'POST', HISTORY_ONLY, overrides)).status).toBe(401);
  expect(await (await callPollRoute('/health', 'GET', POLL_ONLY, overrides)).json()).toMatchObject({ ok: false, lastSuccessfulPollAt: null });
});

it('S14-1: disabled poll and health responses do not name the secret', async () => {
  const poll = await callPollRoute('/poll', 'POST', 'anything', { POLL_SECRET: '' });
  expect(poll.status).toBe(503);
  // C1: every bearer-gated route shares the `{ error }` shape and no-store.
  expect(poll.headers.get('cache-control')).toBe('no-store');
  expect(await poll.json()).toEqual({ error: 'endpoint disabled' });
  const health = await callPollRoute('/health', 'GET', 'anything', { POLL_SECRET: undefined });
  expect(health.status).toBe(503);
  expect(await health.json()).toEqual({ error: 'endpoint disabled' });
});

it('S1-1: a short POLL_SECRET disables /poll and /health even when the token matches', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const weak = 'a';
  const poll = await callPollRoute('/poll', 'POST', weak, { POLL_SECRET: weak });
  expect(poll.status).toBe(503);
  expect(await poll.json()).toEqual({ error: 'endpoint disabled' });
  const almost = 'p'.repeat(31);
  const health = await callPollRoute('/health', 'GET', almost, { POLL_SECRET: ` ${almost} ` });
  expect(health.status).toBe(503);
  expect(await health.json()).toEqual({ error: 'endpoint disabled' });
  // S8-3: logged once per isolate, not once per request.
  expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
    { event: 'config_invalid', reason: 'POLL_SECRET_too_short' },
  ]);
  expect(JSON.stringify(log.mock.calls)).not.toContain(almost);
  const exact = 'p'.repeat(32);
  expect(await (await callPollRoute('/health', 'GET', exact, { POLL_SECRET: exact })).json()).toMatchObject({ ok: false, maxAgeSeconds: 300 });
});

it('S8-3: unauthenticated requests cannot multiply config_invalid log lines', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const weak = 'short-poll-secret-thirty-one-ch';
  expect(weak).toHaveLength(31);
  for (let i = 0; i < 20; i++) {
    const [path, method] = i % 2 ? ['/health', 'GET'] : ['/poll', 'POST'];
    const response = await callPollRoute(path, method, `attacker-${i}`, { POLL_SECRET: weak });
    expect(response.status).toBe(503);
  }
  expect(log).toHaveBeenCalledOnce();
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ event: 'config_invalid', reason: 'POLL_SECRET_too_short' });
  expect(JSON.stringify(log.mock.calls)).not.toContain(weak);
});
