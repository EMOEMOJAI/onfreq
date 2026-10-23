import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordRateLimitError, DiscordRateLimits, MAX_RATE_LIMIT_COOLDOWN_MS, trackPosts } from '../src/discord-rate-limit';
import { postMessage } from '../src/discord';

const START = 1_800_000_000_000;
const stub = () => env.POLL_COORDINATOR.getByName('discord-rate-tests');
let now: number;
beforeEach(() => { now = START; vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

function request(path: string, method = 'POST') {
  return runInDurableObject(stub(), async (_, ctx) => {
    const limits = await DiscordRateLimits.load(ctx.storage);
    const response = await limits.fetch(path, { method });
    return response.status;
  });
}

it.each([
  { body: { global: true }, headers: new Headers() },
  { body: {}, headers: new Headers({ 'x-ratelimit-global': 'true' }) },
  { body: {}, headers: new Headers({ 'x-ratelimit-scope': 'global' }) },
])('persists global cooldowns identified by %j and resumes at expiry', async ({ body, headers }) => {
  const network = vi.fn()
    .mockImplementationOnce(async () => Response.json({ retry_after: 65, ...body }, { status: 429, headers }))
    .mockImplementation(async () => Response.json({ id: 'synthetic' }));
  vi.stubGlobal('fetch', network);
  await expect(request('/channels/a/messages')).rejects.toMatchObject({ retryAt: START + 65_000, requestMade: true, global: true });
  await evictDurableObject(stub());
  now += 64_999;
  await expect(request('/guilds/example/members?limit=1000&after=0', 'GET'))
    .rejects.toMatchObject({ requestMade: false, global: true });
  expect(network).toHaveBeenCalledTimes(1);
  now++;
  await expect(request('/channels/b/messages')).resolves.toBe(200);
  expect(network).toHaveBeenCalledTimes(2);
});

it('shares route cooldowns across message methods but leaves other channels usable', async () => {
  const network = vi.fn()
    .mockImplementationOnce(async () => Response.json({ retry_after: 1.2501 }, { status: 429, headers: { 'retry-after': '1' } }))
    .mockImplementation(async () => Response.json({ id: 'synthetic' }));
  vi.stubGlobal('fetch', network);
  await expect(request('/channels/a/messages')).rejects.toMatchObject({ retryAt: START + 1251 });
  await evictDurableObject(stub());
  for (const method of ['PATCH', 'DELETE']) {
    await expect(request('/channels/a/messages/old', method)).rejects.toMatchObject({ requestMade: false });
  }
  await expect(request('/channels/b/messages')).resolves.toBe(200);
  expect(network).toHaveBeenCalledTimes(2);
  now += 1251;
  await expect(request('/channels/a/messages/old', 'PATCH')).resolves.toBe(200);
});

it('shares member-list cooldowns across pagination cursors', async () => {
  const network = vi.fn().mockImplementation(async () => Response.json({ retry_after: 65 }, { status: 429 }));
  vi.stubGlobal('fetch', network);
  await expect(request('/guilds/example/members?after=0', 'GET')).rejects.toMatchObject({ requestMade: true });
  await expect(request('/guilds/example/members?after=100', 'GET')).rejects.toMatchObject({ requestMade: false });
  expect(network).toHaveBeenCalledTimes(1);
});

it('defers standalone public requests instead of shortening a 65-second cooldown', async () => {
  const network = vi.fn().mockImplementation(async () => Response.json({ retry_after: 65 }, { status: 429 }));
  vi.stubGlobal('fetch', network);
  await expect(postMessage('test-token', '100000000000000123', { title: 'Synthetic' }, undefined, undefined, new DiscordRateLimits()))
    .rejects.toMatchObject({ retryAt: START + 65_000 });
  expect(network).toHaveBeenCalledTimes(1);
});

it.each([null, { retry_after: -5 }, { retry_after: 'invalid' }])(
  'uses a safe cooldown for an unusable 429 payload: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(body, { status: 429 })));
    await expect(request('/channels/a/messages')).rejects.toMatchObject({ retryAt: START + 60_000 });
  });

it('persists a conservative 60-second route cooldown for a 429 whose body exceeded the size cap', async () => {
  const network = vi.fn()
    .mockImplementationOnce(async () => new Response('x', {
      status: 429, headers: { 'content-length': String(4 * 1024 * 1024 + 1), 'retry-after': '1' },
    }))
    .mockImplementation(async () => Response.json({ id: 'synthetic' }));
  vi.stubGlobal('fetch', network);
  await expect(request('/channels/a/messages')).rejects.toMatchObject({
    name: 'DiscordRateLimitError', retryAt: START + 60_000, requestMade: true, global: false, reason: 'rate_limit',
  });
  await evictDurableObject(stub());
  now += 59_999;
  await expect(request('/channels/a/messages/old', 'PATCH')).rejects.toMatchObject({ requestMade: false, global: false });
  await expect(request('/channels/b/messages')).resolves.toBe(200);
  expect(network).toHaveBeenCalledTimes(2);
  now++;
  await expect(request('/channels/a/messages')).resolves.toBe(200);
  expect(network).toHaveBeenCalledTimes(3);
});

it.each([200, 404, 503])('leaves an oversized %i response to the caller without recording a cooldown', async (status) => {
  const network = vi.fn()
    .mockImplementationOnce(async () => new Response('x', { status, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }))
    .mockImplementation(async () => Response.json({ id: 'synthetic' }));
  vi.stubGlobal('fetch', network);
  await expect(request('/channels/a/messages')).rejects.toMatchObject({ name: 'ResponseTooLargeError', status });
  await expect(request('/channels/a/messages')).resolves.toBe(200);
  expect(network).toHaveBeenCalledTimes(2);
});

it('does not mask the rate-limit error when persisting the cooldown fails', async () => {
  const network = vi.fn().mockImplementation(async () => Response.json({ retry_after: 65 }, { status: 429 }));
  vi.stubGlobal('fetch', network);
  const storage = { put: vi.fn().mockRejectedValue(new Error('storage unavailable')) } as unknown as DurableObjectStorage;
  const limits = new DiscordRateLimits(storage);

  await expect(limits.fetch('/channels/a/messages', { method: 'POST' }))
    .rejects.toMatchObject({ status: 429, requestMade: true, retryAt: START + 65_000 });
  expect(storage.put).toHaveBeenCalledTimes(1);
});

/** Soft waits (at most 5 s) run instantly and advance the mocked clock; other timers are untouched. */
function instantSoftWaits() {
  const waits: number[] = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === undefined || ms > 5_000) return real(fn, ms);
    waits.push(ms);
    now += ms;
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  return waits;
}

const exhausted = (resetAfter: string, id = 'first') => async () => Response.json({ id }, {
  headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': resetAfter },
});

it('waits out a short in-memory-only soft cooldown from a 2xx with an exhausted bucket, then sends the request', async () => {
  const waits = instantSoftWaits();
  const network = vi.fn()
    .mockImplementationOnce(exhausted('2.5'))
    .mockImplementation(async () => Response.json({ id: 'second' }));
  vi.stubGlobal('fetch', network);
  const storage = { put: vi.fn(), get: vi.fn().mockResolvedValue(undefined) } as unknown as DurableObjectStorage;
  const limits = new DiscordRateLimits(storage);

  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  expect(waits).toEqual([]);
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  expect(waits).toEqual([2500]);
  expect(now).toBe(START + 2500);
  expect(network).toHaveBeenCalledTimes(2);
  expect(storage.put).not.toHaveBeenCalled();
});

it('still defers a soft cooldown longer than 5 seconds, in memory only', async () => {
  const waits = instantSoftWaits();
  const network = vi.fn()
    .mockImplementationOnce(exhausted('5.001'))
    .mockImplementation(async () => Response.json({ id: 'second' }));
  vi.stubGlobal('fetch', network);
  const storage = { put: vi.fn(), get: vi.fn().mockResolvedValue(undefined) } as unknown as DurableObjectStorage;
  const limits = new DiscordRateLimits(storage);

  await limits.fetch('/channels/a/messages', { method: 'POST' });
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' }))
    .rejects.toMatchObject({ requestMade: false, reason: 'soft', retryAt: START + 5001 });
  expect(waits).toEqual([]);
  expect(network).toHaveBeenCalledTimes(1);
  expect(storage.put).not.toHaveBeenCalled();

  now += 5001;
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  expect(network).toHaveBeenCalledTimes(2);
});

it('stops waiting out soft cooldowns once an instance has waited 10 seconds in total', async () => {
  const waits = instantSoftWaits();
  const network = vi.fn(exhausted('4'));
  vi.stubGlobal('fetch', network);
  const limits = new DiscordRateLimits();

  await limits.fetch('/channels/a/messages', { method: 'POST' });
  await limits.fetch('/channels/a/messages', { method: 'POST' });
  await limits.fetch('/channels/a/messages', { method: 'POST' });
  expect(waits).toEqual([4000, 4000]);
  // A third 4 s wait would reach 12 s; a 2 s wait would still fit under the cap.
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' }))
    .rejects.toMatchObject({ requestMade: false, reason: 'soft', retryAt: now + 4000 });
  expect(waits).toEqual([4000, 4000]);
  expect(network).toHaveBeenCalledTimes(3);
});

it('counts the soft waiting of a whole instance across routes towards the 10 second cap', async () => {
  const waits = instantSoftWaits();
  vi.stubGlobal('fetch', vi.fn(exhausted('4')));
  const limits = new DiscordRateLimits();

  for (const channel of ['a', 'b']) {
    await limits.fetch(`/channels/${channel}/messages`, { method: 'POST' });
    await limits.fetch(`/channels/${channel}/messages`, { method: 'POST' });
  }
  await limits.fetch('/channels/c/messages', { method: 'POST' });
  await expect(limits.fetch('/channels/c/messages', { method: 'POST' })).rejects.toMatchObject({ reason: 'soft' });
  expect(waits).toEqual([4000, 4000]);
});

it('does not wait when the soft cooldown is not the only blocker', async () => {
  const waits = instantSoftWaits();
  const network = vi.fn(exhausted('2'));
  vi.stubGlobal('fetch', network);
  const limits = new DiscordRateLimits();

  await limits.fetch('/channels/a/messages', { method: 'POST' });
  // An outage ending before the soft deadline still blocks: the request is deferred, not slept for.
  limits.markOutage(1_000);
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' }))
    .rejects.toMatchObject({ requestMade: false, reason: 'soft', retryAt: START + 2000 });
  limits.markOutage(3_000);
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' }))
    .rejects.toMatchObject({ requestMade: false, reason: 'outage', retryAt: START + 3000 });
  expect(waits).toEqual([]);
  expect(network).toHaveBeenCalledTimes(1);
});

it('keeps a 2xx-derived soft cooldown scoped to its own route, leaving other channels usable', async () => {
  const network = vi.fn()
    .mockImplementationOnce(async () => Response.json({ id: 'first' }, {
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2.5' },
    }))
    .mockImplementation(async () => Response.json({ id: 'second' }));
  vi.stubGlobal('fetch', network);
  const limits = new DiscordRateLimits();

  await limits.fetch('/channels/a/messages', { method: 'POST' });
  await expect(limits.fetch('/channels/b/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  expect(network).toHaveBeenCalledTimes(2);
});

it('marks route-scoped cooldowns as not global', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ retry_after: 5 }, { status: 429 })));
  await expect(request('/channels/a/messages')).rejects.toMatchObject({ requestMade: true, global: false });
  await expect(request('/channels/a/messages')).rejects.toMatchObject({ requestMade: false, global: false });
});

it.each([
  { body: { retry_after: 30, global: true }, headers: new Headers() },
  { body: { retry_after: 30 }, headers: new Headers({ 'x-ratelimit-global': 'true' }) },
  { body: { retry_after: 30 }, headers: new Headers({ 'x-ratelimit-scope': 'global' }) },
])('pre-checks a persisted global cooldown from %j right after DiscordRateLimits.load(), before any network call', async ({ body, headers }) => {
  const network = vi.fn(async () => Response.json(body, { status: 429, headers }));
  vi.stubGlobal('fetch', network);
  await expect(request('/channels/a/messages')).rejects.toMatchObject({ global: true });
  expect(network).toHaveBeenCalledTimes(1);

  // A fresh instance loaded from the same storage must block an unrelated
  // route immediately, without ever calling fetch.
  network.mockClear();
  await runInDurableObject(stub(), async (_, ctx) => {
    const limits = await DiscordRateLimits.load(ctx.storage);
    await expect(limits.fetch('/guilds/example/members?after=0', { method: 'GET' }))
      .rejects.toMatchObject({ requestMade: false, global: true, reason: 'rate_limit' });
  });
  expect(network).not.toHaveBeenCalled();
});

it('reports requestMade: false and reason: outage on a fail-fast request after an outage is marked', async () => {
  const limits = new DiscordRateLimits();
  limits.markOutage(30_000);
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' }))
    .rejects.toMatchObject({ requestMade: false, reason: 'outage', global: false });
});

it('noteDiscordResponded resets the POST failure streak, so a lone failure afterward does not immediately declare an outage', () => {
  const limits = new DiscordRateLimits();
  expect(limits.notePostFailure()).toBe(false);
  limits.noteDiscordResponded();
  expect(limits.notePostFailure()).toBe(false);
  expect(limits.notePostFailure()).toBe(true);
});

it.each([
  { body: { retry_after: 1e300 }, headers: new Headers() },
  { body: { retry_after: 1e300, global: true }, headers: new Headers() },
  { body: {}, headers: new Headers({ 'retry-after': '99999999' }) },
])('clamps an absurd 429 cooldown %j to one hour, persisted and after restart', async ({ body, headers }) => {
  const network = vi.fn()
    .mockImplementationOnce(async () => Response.json(body, { status: 429, headers }))
    .mockImplementation(async () => Response.json({ id: 'synthetic' }));
  vi.stubGlobal('fetch', network);
  await expect(request('/channels/a/messages')).rejects.toMatchObject({ retryAt: START + MAX_RATE_LIMIT_COOLDOWN_MS });
  const stored = await runInDurableObject(stub(), (_, ctx) => ctx.storage.get<Record<string, number>>('discord-rate-limits-v1'));
  expect(Math.max(...Object.values(stored ?? {}))).toBe(START + MAX_RATE_LIMIT_COOLDOWN_MS);
  await evictDurableObject(stub());
  now += MAX_RATE_LIMIT_COOLDOWN_MS;
  await expect(request('/channels/a/messages')).resolves.toBe(200);
  expect(network).toHaveBeenCalledTimes(2);
});

it('drops a stored cooldown beyond the one-hour cap on load, so delivery resumes', async () => {
  await runInDurableObject(stub(), (_, ctx) => ctx.storage.put('discord-rate-limits-v1', {
    '*': START + 1e15,
    '/channels/a/messages': START + MAX_RATE_LIMIT_COOLDOWN_MS + 1,
    '/channels/b/messages': START + MAX_RATE_LIMIT_COOLDOWN_MS,
  }));
  const network = vi.fn(async () => Response.json({ id: 'synthetic' }));
  vi.stubGlobal('fetch', network);
  await expect(request('/channels/a/messages')).resolves.toBe(200);
  // A deadline within the cap is still honoured.
  await expect(request('/channels/b/messages')).rejects.toMatchObject({ requestMade: false, reason: 'rate_limit' });
  expect(network).toHaveBeenCalledTimes(1);
});

it.each(['1e12', '1e308', String(MAX_RATE_LIMIT_COOLDOWN_MS)])(
  'clamps an absurd 2xx x-ratelimit-reset-after of %s to the one-hour cap', async (resetAfter) => {
    const network = vi.fn()
      .mockImplementationOnce(async () => Response.json({ id: 'first' }, {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': resetAfter },
      }))
      .mockImplementation(async () => Response.json({ id: 'second' }));
    vi.stubGlobal('fetch', network);
    const limits = new DiscordRateLimits();

    await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
    await expect(limits.fetch('/channels/a/messages', { method: 'POST' }))
      .rejects.toMatchObject({ requestMade: false, reason: 'soft', retryAt: START + MAX_RATE_LIMIT_COOLDOWN_MS });
    now += MAX_RATE_LIMIT_COOLDOWN_MS;
    await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
    expect(network).toHaveBeenCalledTimes(2);
  });

// Synthetic IDs: a DM channel route is only kept while its cooldown is active.
const STALE_DM = '/channels/900000000000000009/messages';
const stored = () => runInDurableObject(stub(), (_, ctx) => ctx.storage.get<Record<string, number>>('discord-rate-limits-v1'));

it('load rewrites the stored record without expired, over-cap and non-finite entries', async () => {
  await runInDurableObject(stub(), (_, ctx) => ctx.storage.put('discord-rate-limits-v1', {
    [STALE_DM]: START - 1, '/guilds/g/members': START + MAX_RATE_LIMIT_COOLDOWN_MS + 1, '/channels/a/messages': START + 5_000,
    '*': START + 9_000, bad: 'soon',
  }));
  await runInDurableObject(stub(), (_, ctx) => DiscordRateLimits.load(ctx.storage));
  expect(await stored()).toEqual({ '/channels/a/messages': START + 5_000, '*': START + 9_000 });
});

it('load deletes the stored record when only expired entries remain', async () => {
  await runInDurableObject(stub(), (_, ctx) => ctx.storage.put('discord-rate-limits-v1', { [STALE_DM]: START }));
  await runInDurableObject(stub(), (_, ctx) => DiscordRateLimits.load(ctx.storage));
  expect(await stored()).toBeUndefined();
});

it('load does not write storage when nothing is dropped', async () => {
  await runInDurableObject(stub(), async (_, ctx) => {
    await ctx.storage.put('discord-rate-limits-v1', { '/channels/a/messages': START + 5_000 });
    const put = vi.spyOn(ctx.storage, 'put');
    const del = vi.spyOn(ctx.storage, 'delete');
    await DiscordRateLimits.load(ctx.storage);
    await DiscordRateLimits.load(ctx.storage);
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});

it('load survives a failing cleanup write and logs the existing persist-failure event', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await runInDurableObject(stub(), async (_, ctx) => {
    await ctx.storage.put('discord-rate-limits-v1', { [STALE_DM]: START, '*': START + 5_000 });
    vi.spyOn(ctx.storage, 'put').mockRejectedValueOnce(new Error('synthetic storage failure'));
    const limits = await DiscordRateLimits.load(ctx.storage);
    await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).rejects.toMatchObject({ global: true });
  });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('discord_rate_limit_persist_failed'));
});

it('a new 429 persists without an entry that expired in the meantime', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ retry_after: 30 }, { status: 429 })));
  await expect(request(STALE_DM)).rejects.toMatchObject({ requestMade: true });
  expect(await stored()).toEqual({ [STALE_DM]: START + 30_000 });
  now += 31_000;
  // Loading would already clean it; an in-memory instance holding it must not persist it again.
  await runInDurableObject(stub(), async (_, ctx) => {
    const limits = new DiscordRateLimits(ctx.storage, { [STALE_DM]: START + 30_000 });
    await expect(limits.fetch('/channels/b/messages', { method: 'POST' })).rejects.toMatchObject({ requestMade: true });
  });
  expect(await stored()).toEqual({ '/channels/b/messages': now + 30_000 });
});

// trackPosts (T3-2): the wrapper poll.ts hands to GCA reminders.
function fakeTarget() {
  const target = new DiscordRateLimits();
  const order: string[] = [];
  const fetch = vi.spyOn(target, 'fetch').mockImplementation(async () => { order.push('fetch'); return new Response('ok'); });
  const onPost = vi.fn(() => { order.push('onPost'); });
  return { target, fetch, onPost, order, tracked: trackPosts(target, onPost) };
}

it('trackPosts notes a POST before forwarding its path and init unchanged', async () => {
  const { fetch, onPost, order, tracked } = fakeTarget();
  const init: RequestInit = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } };
  await expect(tracked.fetch('/channels/a/messages', init)).resolves.toBeInstanceOf(Response);
  expect(onPost).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe('/channels/a/messages');
  expect(fetch.mock.calls[0]![1]).toBe(init);
  expect(order).toEqual(['onPost', 'fetch']);
  // A POST that fails still counts.
  fetch.mockRejectedValueOnce(new Error('synthetic failure'));
  await expect(tracked.fetch('/channels/a/messages', { method: 'POST' })).rejects.toThrow('synthetic failure');
  expect(onPost).toHaveBeenCalledTimes(2);
});

it('trackPosts ignores other methods and forwards {} when init is missing', async () => {
  const { fetch, onPost, tracked } = fakeTarget();
  const get: RequestInit = { method: 'GET' };
  await tracked.fetch('/guilds/example/members?limit=1000&after=0', get);
  await tracked.fetch('/users/@me/channels', {});
  await (tracked.fetch as (path: string, init?: RequestInit) => Promise<Response>)('/channels/a/messages');
  expect(onPost).not.toHaveBeenCalled();
  expect(fetch.mock.calls).toEqual([['/guilds/example/members?limit=1000&after=0', get], ['/users/@me/channels', {}],
    ['/channels/a/messages', {}]]);
  expect(fetch.mock.calls[0]![1]).toBe(get);
});

it('trackPosts binds the other methods to the wrapped limits', async () => {
  const network = vi.fn(async () => Response.json({ id: 'synthetic' }));
  vi.stubGlobal('fetch', network);
  const target = new DiscordRateLimits();
  const onPost = vi.fn();
  const tracked = trackPosts(target, onPost);
  // The failure streak lives on the target, whichever side records it.
  expect(tracked.notePostFailure()).toBe(false);
  expect(target.notePostFailure()).toBe(true);
  tracked.noteDiscordResponded();
  expect(target.notePostFailure()).toBe(false);
  // An outage marked through the wrapper blocks the real target without a network call,
  // and a POST it defers still counts as attempted.
  tracked.markOutage(5_000);
  const outage = { reason: 'outage', requestMade: false, retryAt: START + 5_000 };
  await expect(target.fetch('/channels/a/messages', { method: 'GET' })).rejects.toMatchObject(outage);
  const deferred = tracked.fetch('/channels/a/messages', { method: 'POST' });
  await expect(deferred).rejects.toBeInstanceOf(DiscordRateLimitError);
  await expect(deferred).rejects.toMatchObject(outage);
  expect(onPost).toHaveBeenCalledTimes(1);
  expect(network).not.toHaveBeenCalled();
  // Called through the wrapper, each method runs with the target itself as `this`.
  for (const name of ['markOutage', 'notePostFailure', 'noteDiscordResponded'] as const) {
    const method = vi.spyOn(target, name);
    (tracked[name] as (ms: number) => unknown)(1);
    expect(method.mock.contexts, name).toHaveLength(1);
    expect(method.mock.contexts[0], name).toBe(target);
  }
});

it('starts a request only when it can finish by the delivery deadline, and sends again when it is cleared', async () => {
  const network = vi.fn().mockImplementation(async () => Response.json({ id: 'synthetic' }));
  vi.stubGlobal('fetch', network);
  const limits = new DiscordRateLimits();
  limits.setDeadline(START + 10_000);

  // Exactly REQUEST_TIMEOUT_MS (10 s) of budget still starts.
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  expect(network).toHaveBeenCalledTimes(1);
  // One millisecond less cannot be guaranteed to finish: defer without a request.
  now += 1;
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).rejects.toMatchObject({
    name: 'DiscordRateLimitError', requestMade: false, global: false, reason: 'deadline', retryAt: START + 10_000,
    message: 'Discord request deferred (poll time budget)',
  });
  expect(network).toHaveBeenCalledTimes(1);
  // Past the deadline itself also defers.
  now += 20_000;
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).rejects.toMatchObject({ reason: 'deadline' });

  limits.setDeadline(undefined);
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  expect(network).toHaveBeenCalledTimes(2);
});

it('canStartBy is always true without a deadline and counts the request timeout with one', () => {
  const limits = new DiscordRateLimits();
  expect(limits.canStartBy(10 ** 9)).toBe(true);
  limits.setDeadline(START + 12_500);
  expect(limits.canStartBy(2_500)).toBe(true);
  expect(limits.canStartBy(2_501)).toBe(false);
});

it('never sleeps a soft wait that would leave less than a request timeout before the delivery deadline', async () => {
  const waits = instantSoftWaits();
  const network = vi.fn()
    .mockImplementationOnce(exhausted('2'))
    .mockImplementation(async () => Response.json({ id: 'second' }));
  vi.stubGlobal('fetch', network);
  const limits = new DiscordRateLimits();

  await limits.fetch('/channels/a/messages', { method: 'POST' });
  limits.setDeadline(START + 11_999);
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' }))
    .rejects.toMatchObject({ requestMade: false, reason: 'deadline' });
  expect(waits).toEqual([]);
  expect(network).toHaveBeenCalledTimes(1);

  // A wait after which a full request timeout still fits the budget proceeds.
  limits.setDeadline(START + 12_000);
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  expect(waits).toEqual([2000]);
});

// NX-7 item 13: with the configured public channels and a hash key, a route
// for any other channel (a reminder DM) is stored only under a keyed hash.
// Synthetic ids and a synthetic key; the hash is recomputed independently here.
describe('non-public channel routes with a public channel set', () => {
  const PUBLIC_ID = '900000000000000001';
  const PUBLIC_SET: ReadonlySet<string> = new Set([PUBLIC_ID]);
  const DM_ID = '300000000000000007';
  const OTHER_DM_ID = '300000000000000008';
  const HASH_KEY = 'synthetic-hash-key-for-rate-limit-tests';
  const dm = (id = DM_ID) => `/channels/${id}/messages`;

  async function hashedRoute(id: string, key = HASH_KEY): Promise<string> {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(`onfreq-rate-limit:v1:${id}`)));
    return `/channels/@h:${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}/messages`;
  }

  function send(path: string, method = 'POST', key = HASH_KEY) {
    return runInDurableObject(stub(), async (_, ctx) => {
      const limits = await DiscordRateLimits.load(ctx.storage, PUBLIC_SET, key);
      return (await limits.fetch(path, { method })).status;
    });
  }

  const routeLimited = () => vi.fn()
    .mockImplementationOnce(async () => Response.json({ retry_after: 30 }, { status: 429 }))
    .mockImplementation(async () => Response.json({ id: 'synthetic' }));

  it('persists a DM 429 only under an HMAC-keyed route that holds no channel id', async () => {
    vi.stubGlobal('fetch', routeLimited());
    await expect(send(dm())).rejects.toMatchObject({ requestMade: true, retryAt: START + 30_000, reason: 'rate_limit' });
    const record = await stored();
    expect(Object.keys(record ?? {})).toEqual([await hashedRoute(DM_ID)]);
    expect(Object.keys(record ?? {})[0]).toMatch(/^\/channels\/@h:[0-9a-f]{32}\/messages$/);
    expect(JSON.stringify(record)).not.toContain(DM_ID);
    expect(record).toEqual({ [await hashedRoute(DM_ID)]: START + 30_000 });
  });

  it('keeps a hashed DM cooldown per channel, in the same poll and after a reload', async () => {
    const network = routeLimited();
    vi.stubGlobal('fetch', network);
    await runInDurableObject(stub(), async (_, ctx) => {
      const limits = await DiscordRateLimits.load(ctx.storage, PUBLIC_SET, HASH_KEY);
      await expect(limits.fetch(dm(), { method: 'POST' })).rejects.toMatchObject({ requestMade: true });
      await expect(limits.fetch(dm(OTHER_DM_ID), { method: 'POST' })).resolves.toMatchObject({ status: 200 });
    });
    await evictDurableObject(stub());
    await expect(send(dm())).rejects.toMatchObject({ requestMade: false, reason: 'rate_limit', global: false });
    await expect(send(`${dm()}/old`, 'PATCH')).rejects.toMatchObject({ requestMade: false, reason: 'rate_limit' });
    await expect(send(dm(OTHER_DM_ID))).resolves.toBe(200);
    expect(network).toHaveBeenCalledTimes(3);
    now += 30_000;
    await expect(send(dm())).resolves.toBe(200);
    expect(network).toHaveBeenCalledTimes(4);
  });

  it('keeps the plain key of a configured public channel', async () => {
    vi.stubGlobal('fetch', routeLimited());
    await expect(send(`/channels/${PUBLIC_ID}/messages`)).rejects.toMatchObject({ requestMade: true });
    expect(await stored()).toEqual({ [`/channels/${PUBLIC_ID}/messages`]: START + 30_000 });
  });

  it('hashes a query path on a non-public channel id', async () => {
    vi.stubGlobal('fetch', routeLimited());
    await expect(send(`/channels/${DM_ID}?synthetic=1`, 'GET')).rejects.toMatchObject({ requestMade: true });
    expect(await stored()).toEqual({ [await hashedRoute(DM_ID)]: START + 30_000 });
  });

  it('renames a stored plain DM key on load and removes the raw id, even when the entry count is unchanged', async () => {
    await runInDurableObject(stub(), (_, ctx) => ctx.storage.put('discord-rate-limits-v1', { [dm()]: START + 5_000 }));
    const network = vi.fn(async () => Response.json({ id: 'synthetic' }));
    vi.stubGlobal('fetch', network);
    await expect(send(dm())).rejects.toMatchObject({ requestMade: false, reason: 'rate_limit', retryAt: START + 5_000 });
    expect(await stored()).toEqual({ [await hashedRoute(DM_ID)]: START + 5_000 });
    expect(JSON.stringify(await stored())).not.toContain(DM_ID);
    expect(network).not.toHaveBeenCalled();
  });

  it('folds stored plain keys of one DM channel, query routes included, into its hashed key with the later deadline', async () => {
    await runInDurableObject(stub(), (_, ctx) => ctx.storage.put('discord-rate-limits-v1', {
      [dm()]: START + 5_000, [`/channels/${DM_ID}`]: START + 9_000, '*': START + 1_000,
      [`/channels/${PUBLIC_ID}/messages`]: START + 2_000,
    }));
    await runInDurableObject(stub(), (_, ctx) => DiscordRateLimits.load(ctx.storage, PUBLIC_SET, HASH_KEY));
    expect(await stored()).toEqual({
      [await hashedRoute(DM_ID)]: START + 9_000, '*': START + 1_000, [`/channels/${PUBLIC_ID}/messages`]: START + 2_000,
    });
  });

  it('loads an already hashed record without rewriting or re-hashing it', async () => {
    const record = { [await hashedRoute(DM_ID)]: START + 5_000, [`/channels/${PUBLIC_ID}/messages`]: START + 5_000 };
    await runInDurableObject(stub(), async (_, ctx) => {
      await ctx.storage.put('discord-rate-limits-v1', record);
      const put = vi.spyOn(ctx.storage, 'put');
      const del = vi.spyOn(ctx.storage, 'delete');
      await DiscordRateLimits.load(ctx.storage, PUBLIC_SET, HASH_KEY);
      await DiscordRateLimits.load(ctx.storage, PUBLIC_SET, HASH_KEY);
      expect(put).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    });
    expect(await stored()).toEqual(record);
  });

  it('does not let an expired or over-cap plain DM key override a valid hashed one', async () => {
    const hashed = await hashedRoute(DM_ID);
    await runInDurableObject(stub(), (_, ctx) => ctx.storage.put('discord-rate-limits-v1', {
      [hashed]: START + 5_000, [dm()]: START + MAX_RATE_LIMIT_COOLDOWN_MS + 1, [`${dm()}/old`]: START - 1,
      [`/channels/${DM_ID}`]: START + 2_000,
    }));
    const network = vi.fn(async () => Response.json({ id: 'synthetic' }));
    vi.stubGlobal('fetch', network);
    await expect(send(dm())).rejects.toMatchObject({ requestMade: false, reason: 'rate_limit', retryAt: START + 5_000 });
    expect(await stored()).toEqual({ [hashed]: START + 5_000 });
    expect(network).not.toHaveBeenCalled();
  });

  it('uses a different key under a different hash key, so that cooldown is not applied', async () => {
    const network = routeLimited();
    vi.stubGlobal('fetch', network);
    await expect(send(dm())).rejects.toMatchObject({ requestMade: true });
    const otherKey = 'synthetic-rotated-hash-key-for-tests';
    expect(await hashedRoute(DM_ID, otherKey)).not.toBe(await hashedRoute(DM_ID));
    await expect(send(dm(), 'POST', otherKey)).resolves.toBe(200);
    expect(network).toHaveBeenCalledTimes(2);
    expect(Object.keys(await stored() ?? {})).toEqual([await hashedRoute(DM_ID)]);
  });

  it('stores only the hashed key for an oversized DM 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(async () => new Response('x', {
      status: 429, headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    })));
    await expect(send(dm())).rejects.toMatchObject({ requestMade: true, retryAt: START + 60_000, reason: 'rate_limit' });
    expect(await stored()).toEqual({ [await hashedRoute(DM_ID)]: START + 60_000 });
  });

  it('defers a DM past the delivery deadline before hashing or any network call', async () => {
    const network = vi.fn(async () => Response.json({ id: 'synthetic' }));
    vi.stubGlobal('fetch', network);
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const limits = new DiscordRateLimits(undefined, {}, PUBLIC_SET, HASH_KEY);
    limits.setDeadline(START + 9_999);
    await expect(limits.fetch(dm(), { method: 'POST' })).rejects.toMatchObject({ requestMade: false, reason: 'deadline' });
    expect(importKey).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('still stores a global 429 from a DM route under the global key only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ retry_after: 30, global: true }, { status: 429 })));
    await expect(send(dm())).rejects.toMatchObject({ requestMade: true, global: true });
    expect(await stored()).toEqual({ '*': START + 30_000 });
  });

  it('falls back to plain keys without throwing when the hash key is empty', async () => {
    vi.stubGlobal('fetch', routeLimited());
    await expect(send(dm(), 'POST', '')).rejects.toMatchObject({ requestMade: true, reason: 'rate_limit' });
    expect(await stored()).toEqual({ [dm()]: START + 30_000 });
  });
});
