import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { COORDINATOR_NAME, POLL_SNAPSHOT_KEY } from '../src/config';
import { AUTH_HEADERS, HISTORY_AUTH_HEADERS } from './helpers';

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
    method, headers: { ...(path.startsWith('/gca-history') ? HISTORY_AUTH_HEADERS : AUTH_HEADERS), 'x-onfreq-confirm': 'delete-old-copies' },
  }), configured, createExecutionContext());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(getByName).toHaveBeenCalledExactlyOnceWith('preserved-state');
  expect(coordinator[called as keyof typeof coordinator]).toHaveBeenCalledOnce();
});

// C1/C3: one wrapper applies method check, bearer auth, no-store and a generic
// 503 to every gated route. Wrapper errors are `{ error }` with fixed messages;
// only /poll keeps its own 500 result body (`ok: false`, mirroring `ok: true`).
const PRIVATE_DETAIL = 'synthetic private coordinator detail 600001';
const withCoordinator = (coordinator: unknown) => {
  const getByName = vi.fn(() => coordinator);
  return { getByName, env: { ...env, POLL_COORDINATOR: { getByName } as unknown as Env['POLL_COORDINATOR'] } };
};
const send = (path: string, method: string, target: Env, headers: Record<string, string> = {}) => worker.fetch(
  new Request(`https://example.test${path}`, {
    method, headers: { ...(path.startsWith('/gca-history') ? HISTORY_AUTH_HEADERS : AUTH_HEADERS), ...headers },
  }), target, createExecutionContext());

it.each([
  ['/poll', 'GET', 'POST'],
  ['/health', 'POST', 'GET'],
  ['/gca-history', 'POST', 'GET'],
  ['/gca-history/cleanup', 'DELETE', 'GET, POST'],
])('C1: %s rejects %s with one 405 shape before auth or the coordinator', async (path, method, allow) => {
  const { getByName, env: target } = withCoordinator({});
  const response = await send(path, method, target, { authorization: '' });
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe(allow);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: 'method not allowed' });
  expect(getByName).not.toHaveBeenCalled();
});

it.each([['/poll', 'POST'], ['/health', 'GET'], ['/gca-history', 'GET'], ['/gca-history/cleanup', 'GET']])(
  'C1: %s %s rejects a wrong token with one 401 shape', async (path, method) => {
    const { getByName, env: target } = withCoordinator({});
    const response = await send(path, method, target, { authorization: 'Bearer wrong' });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(getByName).not.toHaveBeenCalled();
  });

it.each(['GET', 'POST'])('C3: cleanup %s returns 409 with no-store while a poll is in flight', async (method) => {
  const cleanupGcaHistory = vi.fn(async () => ({ busy: true }));
  const { env: target } = withCoordinator({ cleanupGcaHistory });
  const response = await send('/gca-history/cleanup', method, target, { 'x-onfreq-confirm': 'delete-old-copies' });
  expect(response.status).toBe(409);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ busy: true });
  expect(cleanupGcaHistory).toHaveBeenCalledExactlyOnceWith(method === 'POST');
});

it.each([undefined, 'yes', 'DELETE-OLD-COPIES', 'delete-old-copies-now'])(
  'C3: cleanup POST with confirmation %j is refused with 400 before the coordinator', async (confirm) => {
    const cleanupGcaHistory = vi.fn(async () => ({ busy: false }));
    const { getByName, env: target } = withCoordinator({ cleanupGcaHistory });
    const response = await send('/gca-history/cleanup', 'POST', target,
      confirm === undefined ? {} : { 'x-onfreq-confirm': confirm });
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: expect.stringContaining('X-Onfreq-Confirm') });
    expect(getByName).not.toHaveBeenCalled();
    expect(cleanupGcaHistory).not.toHaveBeenCalled();
  });

it.each([
  ['/health', 'GET', 'getHealth'],
  ['/gca-history', 'GET', 'getGcaHistory'],
  ['/gca-history/cleanup', 'GET', 'cleanupGcaHistory'],
  ['/gca-history/cleanup', 'POST', 'cleanupGcaHistory'],
])('C3: %s %s returns a generic 503 when the coordinator throws', async (path, method, name) => {
  const failing = vi.fn(async () => { throw new Error(PRIVATE_DETAIL); });
  for (const target of [
    withCoordinator({ [name]: failing }).env,
    { ...env, POLL_COORDINATOR: { getByName: () => { throw new Error(PRIVATE_DETAIL); } } as unknown as Env['POLL_COORDINATOR'] },
  ]) {
    const response = await send(path, method, target, { 'x-onfreq-confirm': 'delete-old-copies' });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'coordinator unavailable' });
  }
  expect(failing).toHaveBeenCalledOnce();
});

it('C1: a thrown /poll keeps its 500 result body, now with no-store, and exposes no detail', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { env: target } = withCoordinator({ poll: vi.fn(async () => { throw new Error(PRIVATE_DETAIL); }) });
  const response = await send('/poll', 'POST', target);
  expect(response.status).toBe(500);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ ok: false, source: 'http', error: 'poll failed' });
  expect(body).not.toContain('600001');
});

it.each(['', '   ', 'preserved-state'])('uses the same identity for cron with override %j', async (name) => {
  const poll = vi.fn(async () => ({ skipped: true }));
  const getByName = vi.fn(() => ({ poll }));
  await worker.scheduled(createScheduledController(), { ...env, COORDINATOR_NAME: name,
    POLL_COORDINATOR: { getByName } as unknown as Env['POLL_COORDINATOR'] }, createExecutionContext());
  expect(getByName).toHaveBeenCalledExactlyOnceWith(name.trim() || COORDINATOR_NAME);
  expect(poll).toHaveBeenCalledOnce();
});

it('rethrows a scheduled poll failure so the invocation is recorded as failed', async () => {
  const poll = vi.fn(async () => { throw new Error('synthetic scheduled failure'); });
  const getByName = vi.fn(() => ({ poll }));
  await expect(worker.scheduled(createScheduledController(),
    { ...env, POLL_COORDINATOR: { getByName } as unknown as Env['POLL_COORDINATOR'] },
    createExecutionContext())).rejects.toThrow('synthetic scheduled failure');
});

it('reports GET / as reachable without authentication', async () => {
  const response = await worker.fetch(new Request('https://example.test/'), env, createExecutionContext());
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  expect(await response.text()).toContain('onfreq HTTP endpoint is reachable');
});

it('reads existing durable state through the override without starting a new coordinator', async () => {
  const selected = env.POLL_COORDINATOR.getByName('preserved-state');
  const lastSuccessfulPollAt = Date.now();
  await runInDurableObject(selected, (_, ctx) => ctx.storage.put(POLL_SNAPSHOT_KEY, {
    state: {}, lastPollStartedAt: lastSuccessfulPollAt, lastSuccessfulPollAt,
  }));
  const configured = { ...env, COORDINATOR_NAME: 'preserved-state' };
  const request = (path: string, method = 'GET') => worker.fetch(new Request(`https://example.test${path}`, {
    method, headers: AUTH_HEADERS,
  }), configured, createExecutionContext());
  expect(await (await request('/health')).json()).toMatchObject({ ok: true, lastSuccessfulPollAt });
  expect(await (await request('/poll', 'POST')).json()).toMatchObject({ ok: true, skipped: true });
  expect(await runInDurableObject(env.POLL_COORDINATOR.getByName(COORDINATOR_NAME),
    (_, ctx) => ctx.storage.get(POLL_SNAPSHOT_KEY))).toBeUndefined();
});
