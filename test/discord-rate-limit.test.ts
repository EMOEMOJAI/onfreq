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
  await expect(request('/channels/a/messages')).rejects.toMatchObject({ retryAt: START + 65_000, requestMade: true });
  await evictDurableObject(stub());
  now += 64_999;
  await expect(request('/guilds/example/members?limit=1000&after=0', 'GET'))
    .rejects.toMatchObject({ requestMade: false });
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
  await expect(postMessage('test-token', 'a', { title: 'Synthetic' }))
    .rejects.toMatchObject({ retryAt: START + 65_000 });
  expect(network).toHaveBeenCalledTimes(1);
});

it.each([null, { retry_after: -5 }, { retry_after: 'invalid' }])(
  'uses a safe cooldown for an unusable 429 payload: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json(body, { status: 429 })));
    await expect(request('/channels/a/messages')).rejects.toMatchObject({ retryAt: START + 60_000 });
  });
