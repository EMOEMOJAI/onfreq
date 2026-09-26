import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiscordRateLimits } from '../src/discord-rate-limit';
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
  await expect(postMessage('test-token', 'a', { title: 'Synthetic' }, undefined, undefined, new DiscordRateLimits()))
    .rejects.toMatchObject({ retryAt: START + 65_000 });
  expect(network).toHaveBeenCalledTimes(1);
});

it.each([null, { retry_after: -5 }, { retry_after: 'invalid' }])(
  'uses a safe cooldown for an unusable 429 payload: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(body, { status: 429 })));
    await expect(request('/channels/a/messages')).rejects.toMatchObject({ retryAt: START + 60_000 });
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
