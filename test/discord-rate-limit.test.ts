import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiscordRateLimits, MAX_RATE_LIMIT_COOLDOWN_MS } from '../src/discord-rate-limit';
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

it('sets a short in-memory-only cooldown when a 2xx reports an exhausted bucket, without persisting it', async () => {
  const network = vi.fn()
    .mockImplementationOnce(async () => Response.json({ id: 'first' }, {
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2.5' },
    }))
    .mockImplementation(async () => Response.json({ id: 'second' }));
  vi.stubGlobal('fetch', network);
  const storage = { put: vi.fn(), get: vi.fn().mockResolvedValue(undefined) } as unknown as DurableObjectStorage;
  const limits = new DiscordRateLimits(storage);

  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' }))
    .rejects.toMatchObject({ requestMade: false, retryAt: START + 2500 });
  expect(network).toHaveBeenCalledTimes(1);
  expect(storage.put).not.toHaveBeenCalled();

  now += 2500;
  await expect(limits.fetch('/channels/a/messages', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  expect(network).toHaveBeenCalledTimes(2);
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
