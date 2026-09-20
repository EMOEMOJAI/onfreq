import { env } from 'cloudflare:workers';
import {
  abortAllDurableObjects,
  createExecutionContext,
  createScheduledController,
  evictDurableObject,
  reset,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { COORDINATOR_NAME, IVAO_ATC_SUMMARY_URL, POLL_SNAPSHOT_KEY, STATE_KEY } from '../src/config';
import { PollCoordinator, type PollSnapshot } from '../src/coordinator';
import { buildOnlineEmbed, type DiscordEmbed } from '../src/discord';
import { resetTokenCache } from '../src/ivao';
import type { IvaoAtcSummaryEntry, StateMap, TrackedAtc } from '../src/types';

const START = Date.parse('2026-09-06T10:00:00Z');
const stub = () => env.POLL_COORDINATOR.getByName(COORDINATOR_NAME);
const a = 'QCTT_TWR';
const b = 'QESS_APP';

function entry(callsign: string, frequency = 118.1): IvaoAtcSummaryEntry {
  return {
    id: 1, userId: 100, callsign, connectionType: 'ATC',
    atcSession: { frequency, position: callsign.split('_').at(-1)! },
    atcPosition: { atcCallsign: 'Test Station' }, subcenter: null,
  };
}

function session(callsign: string, cardAt = START - 60_000): TrackedAtc {
  return {
    sessionId: 1, userId: 100, callsign, frequency: 118.1,
    position: callsign.split('_').at(-1)!, station: 'Test Station', location: null,
    since: new Date(START - 3_600_000).toISOString(), missed: 0,
    cardAt: new Date(cardAt).toISOString(),
    messages: [{ channelId: 'test-channel', messageId: callsign }],
  };
}

type Sent = { channelId?: string; method: string; id?: string; embed: DiscordEmbed; replyTo?: string };
let now: number;
let feed: IvaoAtcSummaryEntry[];
let sent: Sent[];
let deleted: string[];
let cards: Map<string, DiscordEmbed>;
let failures: Set<string>;
let failureStatus: number;
let feedStatus: number;
let profileStatus: number;
let profileCountry: string;
let network: ReturnType<typeof vi.fn<typeof fetch>>;
let gcaMessages: DiscordEmbed[];
let gcaMemberStatus: number;

async function seed(state: StateMap): Promise<void> {
  await runInDurableObject(stub(), async (_instance, ctx) => {
    await ctx.storage.put(POLL_SNAPSHOT_KEY, { state } satisfies PollSnapshot);
  });
}

async function snapshot(): Promise<PollSnapshot | undefined> {
  return runInDurableObject(stub(), (_instance, ctx) =>
    ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY));
}

function poll(): Promise<Response> {
  return worker.fetch(new Request('https://bot.test/poll', {
    method: 'POST', headers: { authorization: 'Bearer test-poll-secret' },
  }), env, createExecutionContext());
}

/** Exercise the real coordinator with test credentials and real DO storage. */
function authenticatedPoll() {
  return runInDurableObject(stub(), (_instance, ctx) => new PollCoordinator(ctx, {
    ...env, IVAO_CLIENT_ID: 'test-client', IVAO_CLIENT_SECRET: 'test-secret',
  }).poll());
}

function gcaPoll() {
  return runInDurableObject(stub(), (_instance, ctx) => new PollCoordinator(ctx, {
    ...env, IVAO_CLIENT_ID: 'test-client', IVAO_CLIENT_SECRET: 'test-secret', GCA_DM_ENABLED: 'true',
    FIR_PREFIXES: 'XD',
    GCA_REGIONS: JSON.stringify({ AD: { name: 'Example East', prefixes: ['XD'] } }),
  }).poll());
}

async function nextPoll(): Promise<Response> {
  now += 60_000;
  return poll();
}

function roster(id: string): string | undefined {
  return cards.get(id)?.fields?.find((field) => field.name.startsWith('Also online'))?.value;
}

beforeEach(() => {
  resetTokenCache();
  now = START;
  feed = [];
  sent = [];
  deleted = [];
  cards = new Map();
  failures = new Set();
  failureStatus = 400;
  feedStatus = 200;
  profileStatus = 200;
  profileCountry = 'ES';
  gcaMessages = [];
  gcaMemberStatus = 200;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  network = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === 'https://api.ivao.aero/v2/oauth/token') {
      return Response.json({ access_token: 'test-ivao-token', expires_in: 1800 });
    }
    if (url.startsWith('https://api.ivao.aero/v2/users/')) {
      return Response.json({ countryId: profileCountry }, { status: profileStatus });
    }
    if (url === IVAO_ATC_SUMMARY_URL) {
      // An unmonitored controller distinguishes zero regional coverage from a feed outage.
      return Response.json([entry('EGLL_TWR'), ...feed], { status: feedStatus });
    }
    if (url.includes('/guilds/') && url.includes('/members?')) {
      return Response.json([{ user: { id: '200000000000000001' }, nick: 'Member (600001)', roles: [env.GCA_MEMBER_ROLE_ID] }], { status: gcaMemberStatus });
    }
    if (url.endsWith('/users/@me/channels')) {
      return Response.json({ id: '300000000000000001', type: 1, recipients: [{ id: '200000000000000001' }] });
    }
    if (url.endsWith('/channels/300000000000000001/messages')) {
      const payload = JSON.parse(String(init?.body)) as { embeds: DiscordEmbed[] };
      gcaMessages.push(payload.embeds[0]!);
      return Response.json({ id: '300000000000000002' });
    }
    if (/^https:\/\/discord.com\/api\/v10\/channels\/test-channel(?:-b)?\/messages/.test(url)) {
      const channelId = url.split('/')[6]!;
      const method = init?.method ?? 'GET';
      const id = method === 'POST' ? `posted-${sent.length}` : url.split('/').at(-1)!;
      if (method === 'DELETE') {
        deleted.push(id);
        if (failures.has(id)) return new Response('test deletion failure', { status: failureStatus });
        cards.delete(id);
        return new Response(null, { status: 204 });
      }
      const payload = JSON.parse(String(init?.body)) as { embeds: DiscordEmbed[]; message_reference?: { message_id: string } };
      const embed = payload.embeds[0]!;
      sent.push({ channelId, method, id, embed, replyTo: payload.message_reference?.message_id });
      const text = payload.embeds.flatMap((item) => [item.title ?? '', item.description ?? '', item.footer?.text ?? '',
        ...(item.fields ?? []).flatMap((field) => [field.name, field.value])]).join('');
      if (text.length > 6000 || payload.embeds.some((item) => (item.fields?.length ?? 0) > 25 ||
          item.fields?.some((field) => field.value.length > 1024))) {
        return Response.json({ message: 'Invalid Form Body: embed limits exceeded' }, { status: 400 });
      }
      if (failures.has(channelId) || failures.has(method === 'POST' ? 'POST' : id)) {
        return new Response('test delivery failure', { status: failureStatus });
      }
      cards.set(id, embed);
      return Response.json({ id });
    }
    throw new Error(`Unexpected network request: ${url}`);
  });
  vi.stubGlobal('fetch', network);
});

afterEach(async () => {
  resetTokenCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

describe('polling through the Durable Object', () => {
  function configuredPoll(overrides: Partial<Env> = {}) {
    return runInDurableObject(stub(), (_instance, ctx) => new PollCoordinator(ctx, {
      ...env, DISCORD_CHANNEL_IDS: 'test-channel,test-channel-b,test-channel', ...overrides,
    }).poll());
  }

  it.each([
    { FIR_PREFIXES: '' }, { FIR_PREFIXES: '*' }, { FIR_LABELS: 'invalid private mapping' },
  ])('preserves session state and avoids network calls with unusable geography: %j', async (overrides) => {
    const original = { [a]: session(a) };
    await seed(original);
    await expect(configuredPoll(overrides)).rejects.toThrow(/FIR_/);
    expect(network).not.toHaveBeenCalled();
    expect((await snapshot())?.state).toEqual(original);
    expect((await snapshot())?.lastSuccessfulPollAt).toBeUndefined();
  });

  it('uses private labels for live, ended and fallback cards and roster groups', async () => {
    const config = {
      DISCORD_CHANNEL_IDS: 'test-channel',
      FIR_LABELS: JSON.stringify([{ prefixes: ['QC', 'QE'], flag: '🇦🇺', name: 'Example' }]),
    };
    await seed({});
    feed = [entry(a), entry(b)];
    await configuredPoll(config);
    const state = (await snapshot())!.state!;
    const firstId = state[a]!.messages![0]!.messageId;
    const secondId = state[b]!.messages![0]!.messageId;
    expect(cards.get(firstId)?.title).toContain('🇦🇺');
    expect(cards.get(secondId)?.title).toContain('🇦🇺');
    expect([...cards.values()].some((card) => card.fields?.some((field) => field.value.includes('Example')))).toBe(true);
    feed = [];
    now += 60_000;
    await configuredPoll(config);
    now += 60_000;
    failures.add(firstId);
    failureStatus = 404;
    await configuredPoll(config);
    expect(sent.some((item) => item.method === 'PATCH' && item.embed.title === `⚪ 🇦🇺 ${b} is OFFLINE`)).toBe(true);
    expect(sent.some((item) => item.method === 'POST' && item.embed.title === `🔴 🇦🇺 ${a} went OFFLINE`)).toBe(true);
  });

  it('retries only the failed online channel across eviction and preserves health and since', async () => {
    await seed({});
    feed = [entry(a)];
    failures.add('test-channel-b');
    await expect(configuredPoll()).rejects.toThrow('some Discord notifications failed');
    expect((await snapshot())?.lastSuccessfulPollAt).toBeUndefined();
    expect((await snapshot())?.state?.[a]?.pendingChannelIds).toEqual(['test-channel-b']);
    await abortAllDurableObjects();
    now += 60_000;
    failures.clear();
    await configuredPoll();
    const posts = sent.filter((item) => item.method === 'POST');
    expect(posts.map((item) => item.channelId)).toEqual(['test-channel', 'test-channel-b', 'test-channel-b']);
    expect((await snapshot())?.state?.[a]).toMatchObject({ since: new Date(START).toISOString() });
    expect((await snapshot())?.state?.[a]?.messages).toHaveLength(2);
    expect((await snapshot())?.state?.[a]?.pendingChannelIds).toBeUndefined();
  });

  it('retries only failed offline edits across eviction', async () => {
    const tracked = session(a);
    tracked.missed = 1;
    tracked.messages!.push({ channelId: 'test-channel-b', messageId: 'old-b' });
    await seed({ [a]: tracked });
    failures.add('test-channel-b');
    await expect(configuredPoll()).rejects.toThrow('some Discord notifications failed');
    expect((await snapshot())?.state).toEqual({});
    expect((await snapshot())?.pendingOffline?.[0]?.messages).toEqual([{ channelId: 'test-channel-b', messageId: 'old-b' }]);
    await abortAllDurableObjects();
    failures.clear();
    now += 60_000;
    await configuredPoll();
    expect(sent.filter((item) => item.id === a)).toHaveLength(1);
    expect(sent.filter((item) => item.id === 'old-b')).toHaveLength(2);
    expect((await snapshot())?.pendingOffline).toBeUndefined();
  });

  it('retries legacy standalone closeouts per channel without repeating successful posts', async () => {
    const tracked = session(a);
    tracked.missed = 1;
    delete tracked.messages;
    await seed({ [a]: tracked });
    failures.add('test-channel-b');
    await expect(configuredPoll()).rejects.toThrow();
    failures.clear();
    now += 60_000;
    await configuredPoll();
    expect(sent.map((item) => item.channelId)).toEqual(['test-channel', 'test-channel-b', 'test-channel-b']);
  });

  it('keeps a replacement controller separate from a failed prior closeout', async () => {
    await seed({ [a]: session(a) });
    feed = [{ ...entry(a), userId: 101, id: 2 }];
    failures.add(a);
    expect((await poll()).status).toBe(500);
    expect((await snapshot())?.state?.[a]).toMatchObject({ userId: 101, since: new Date(START).toISOString() });
    expect((await snapshot())?.state?.[a]?.messages?.[0]?.messageId).not.toBe(a);
    expect((await snapshot())?.pendingOffline?.[0]?.event.userId).toBe(100);
    await abortAllDurableObjects();
    failures.clear();
    expect((await nextPoll()).status).toBe(200);
    expect((await snapshot())?.state?.[a]?.userId).toBe(101);
    expect((await snapshot())?.pendingOffline).toBeUndefined();
    expect(sent.filter((item) => item.id === a).every((item) => item.embed.title?.includes('OFFLINE'))).toBe(true);
  });

  it('does not inherit the previous controller frequency or card when replacement is untuned', async () => {
    await seed({ [a]: session(a) });
    feed = [{ ...entry(a, 0), userId: 101, id: 2 }];
    expect((await poll()).status).toBe(200);
    expect((await snapshot())?.state?.[a]).toMatchObject({ pending: true, frequency: 0, since: new Date(START).toISOString() });
    expect((await snapshot())?.state?.[a]?.messages).toBeUndefined();
  });

  it('retains the untuned connection time through complete delivery failure and restart', async () => {
    await seed({});
    feed = [entry(a, 0)];
    await poll();
    feed = [entry(a)];
    failures.add('POST');
    expect((await nextPoll()).status).toBe(500);
    await abortAllDurableObjects();
    now += 3_600_000;
    failures.clear();
    expect((await poll()).status).toBe(200);
    expect((await snapshot())?.state?.[a]?.since).toBe(new Date(START).toISOString());
  });

  it('silently drops a disconnected session that never reached any destination', async () => {
    await seed({});
    feed = [entry(a)];
    failures.add('POST');
    await poll();
    feed = [];
    failures.clear();
    await nextPoll();
    await nextPoll();
    expect(sent).toHaveLength(1);
    expect((await snapshot())?.state).toEqual({});
    expect((await snapshot())?.pendingOffline).toBeUndefined();
  });

  it.each([
    { DISCORD_CHANNEL_IDS: '' }, { DISCORD_CHANNEL_IDS: ' ,  ' }, { DISCORD_BOT_TOKEN: '  ' },
  ])('rejects missing delivery configuration before fetching or advancing state: %j', async (overrides) => {
    await seed({});
    feed = [entry(a)];
    await expect(configuredPoll(overrides)).rejects.toThrow('required');
    expect(network).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual({ state: {} });
    await configuredPoll();
    expect((await snapshot())?.state?.[a]?.messages).toHaveLength(2);
  });

  it('bounds permanently failed closeouts without losing active replacement state', async () => {
    await seed({ [a]: session(a) });
    feed = [{ ...entry(a), userId: 101, id: 2 }];
    failures.add(a);
    for (let attempt = 0; attempt < 11; attempt++) {
      expect((await poll()).status).toBe(500);
      now += 60_000;
    }
    expect((await snapshot())?.pendingOffline).toBeUndefined();
    expect((await snapshot())?.state?.[a]?.userId).toBe(101);
    expect((await poll()).status).toBe(200);
    expect(sent.filter((item) => item.id === a)).toHaveLength(11);
  });

  it('sends one GCA reminder on connection and none on later polls or disconnect', async () => {
    await gcaPoll(); // Establish the rollout baseline.
    profileCountry = 'US';
    feed = [{ ...entry('XDAA_ARR_APP'), userId: 600001, id: 999 }];
    now += 60_000;
    await gcaPoll();
    expect(gcaMessages).toHaveLength(1);
    expect(gcaMessages[0]?.description).toContain('United States');
    expect(gcaMessages[0]?.fields).toBeUndefined();
    expect(sent.some((m) => m.method === 'POST' && m.embed.title?.includes('ONLINE'))).toBe(true);
    await evictDurableObject(stub());
    now += 60_000;
    await gcaPoll();
    feed = [];
    now += 60_000;
    await gcaPoll();
    now += 60_000;
    await gcaPoll();
    expect(gcaMessages).toHaveLength(1);
    expect(sent.some((m) => m.embed.title?.includes('OFFLINE'))).toBe(true);
  });

  it('does not repeat a successful DM when public channel delivery remains pending', async () => {
    await gcaPoll();
    profileCountry = 'US';
    feed = [{ ...entry('XDAA_ARR_APP'), userId: 600001, id: 999 }];
    failures.add('POST');
    now += 60_000;
    await expect(gcaPoll()).rejects.toThrow('all Discord notifications failed');
    expect(gcaMessages).toHaveLength(1);
    failures.clear();
    await evictDurableObject(stub());
    now += 60_000;
    await gcaPoll();
    expect(gcaMessages).toHaveLength(1);
  });

  it('keeps public ATC notifications working when the member list is inaccessible', async () => {
    await gcaPoll();
    profileCountry = 'US';
    feed = [{ ...entry('XDAA_ARR_APP'), userId: 600001, id: 999 }];
    gcaMemberStatus = 403;
    now += 60_000;
    await expect(gcaPoll()).resolves.toEqual({ skipped: false });
    expect(gcaMessages).toHaveLength(0);
    expect(sent.some((m) => m.method === 'POST' && m.embed.title?.includes('ONLINE'))).toBe(true);
  });

  it('applies callsign exclusions before GCA delivery', async () => {
    await gcaPoll();
    profileCountry = 'US';
    feed = [{ ...entry('XDAA_X_APP'), userId: 600001, id: 999 }];
    now += 60_000;
    await gcaPoll();
    expect(gcaMessages).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('persists fetched profile countries, reuses them after eviction, and refreshes the same card', async () => {
    await seed({ [a]: session(a) });
    feed = [entry(a)];
    expect(await authenticatedPoll()).toEqual({ skipped: false });
    const controller = () => cards.get(a)?.fields?.find((f) => f.name === 'Controller')?.value;
    expect(controller()).toBe('VID 100 · Spain');
    expect(cards.get(a)?.title).toBe('🟢 🌐 QCTT_TWR is now ONLINE');
    expect((await snapshot())?.state?.[a]?.memberCountry?.countryId).toBe('ES');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('PATCH');

    await evictDurableObject(stub());
    resetTokenCache();
    now += 60_000;
    await authenticatedPoll();
    expect(controller()).toBe('VID 100 · Spain');
    expect(sent).toHaveLength(1);
    expect(network.mock.calls.filter(([url]) => String(url).includes('/v2/users/'))).toHaveLength(1);

    now += 86_400_000;
    profileCountry = 'BR';
    await authenticatedPoll();
    expect(controller()).toBe('VID 100 · Brazil');
    expect(sent).toHaveLength(2);
    expect(sent.every((message) => message.method === 'PATCH' && message.id === a)).toBe(true);
    expect((await snapshot())?.state?.[a]?.since).toBe(session(a).since);
  });

  it('still posts connections and closes ended cards when the member profile service fails', async () => {
    await seed({ [b]: { ...session(b), missed: 1, missingSince: new Date(START - 60_000).toISOString() } });
    feed = [entry(a)];
    profileStatus = 503;
    expect(await authenticatedPoll()).toEqual({ skipped: false });
    const posted = sent.find((message) => message.method === 'POST');
    expect(posted?.embed.fields?.find((f) => f.name === 'Controller')?.value).toBe('VID 100');
    expect(cards.get(b)?.title).toContain('OFFLINE');
    expect((await snapshot())?.state?.[a]?.memberCountry).toMatchObject({ countryId: null });
    now += 60_000;
    await authenticatedPoll();
    expect(network.mock.calls.filter(([url]) => String(url).includes('/v2/users/'))).toHaveLength(1);
    expect(sent.filter((message) => message.method === 'POST')).toHaveLength(1);
  });

  it('updates same-airport coverage on every card without new posts and removes it when ended', async () => {
    const ground = 'QCTT_GND';
    const airport = { icao: 'QCTT', iata: 'XXX', city: 'Example City', countryId: 'BR' };
    const towerEntry = entry(a);
    const groundEntry = entry(ground);
    towerEntry.atcPosition!.airport = airport;
    groundEntry.atcPosition!.airport = airport;
    await seed({});
    feed = [towerEntry, groundEntry];
    await poll();
    const state = await stub().getState();
    const towerId = state![a]!.messages![0]!.messageId;
    const groundId = state![ground]!.messages![0]!.messageId;
    const coverage = (id: string) => cards.get(id)?.fields?.find((f) => f.name === 'Online at QCTT')?.value;
    expect(coverage(towerId)).toBe('✅ GND · ✅ TWR');
    expect(coverage(groundId)).toBe('✅ GND · ✅ TWR');
    expect(sent.filter((s) => s.method === 'POST').every((s) =>
      s.embed.fields?.some((f) => f.value === '✅ GND · ✅ TWR'))).toBe(true);
    const before = sent.length;
    await nextPoll();
    expect(sent).toHaveLength(before);
    feed = [towerEntry];
    await nextPoll();
    expect(coverage(towerId)).toBe('✅ TWR');
    expect(coverage(groundId)).toBe('✅ TWR');
    await nextPoll();
    expect(coverage(groundId)).toBeUndefined();
    expect(cards.get(groundId)?.fields?.find((f) => f.name === 'Airport')).toBeUndefined();
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(2);
  });

  it('silently seeds a fresh installation', async () => {
    feed = [entry(a)];
    expect((await poll()).status).toBe(200);
    expect(sent).toEqual([]);
    expect((await stub().getState())?.[a]).toMatchObject({
      since: new Date(START).toISOString(), missed: 0,
    });
    expect((await snapshot())?.lastPollStartedAt).toBe(START);
    expect((await snapshot())?.lastSuccessfulPollAt).toBe(START);
  });

  it('only advances health for successful persisted polls, never skipped or failed polls', async () => {
    await seed({});
    await poll();
    now += 20_000;
    await poll();
    expect((await snapshot())?.lastSuccessfulPollAt).toBe(START);
    now += 60_000;
    feedStatus = 500;
    expect((await poll()).status).toBe(500);
    expect((await snapshot())?.lastSuccessfulPollAt).toBe(START);
    feedStatus = 200;
    feed = [entry(a)];
    failures.add('POST');
    expect((await poll()).status).toBe(500);
    expect((await snapshot())?.lastSuccessfulPollAt).toBe(START);
    failures.clear();
    await nextPoll();
    expect((await snapshot())?.lastSuccessfulPollAt).toBe(now);
  });

  it('refuses maintenance while a poll is in flight', async () => {
    await runInDurableObject(stub(), async (instance) => {
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      network.mockImplementationOnce(async () => {
        entered();
        await gate;
        return Response.json([entry('EGLL_TWR')]);
      });
      const running = instance.poll();
      await ready;
      try {
        expect(instance.cleanupGcaHistory(true)).toEqual({ busy: true });
      } finally {
        release();
        await running;
      }
    });
  });

  it('imports legacy message IDs and closes the original card after the grace window', async () => {
    await env.ATC_STATE.put(STATE_KEY, JSON.stringify({ [a]: session(a) }));
    feed = [entry(a)];
    await poll();
    expect(sent.every((message) => message.method === 'PATCH')).toBe(true);
    feed = [];
    await nextPoll();
    const firstMiss = now;
    expect((await stub().getState())?.[a]?.missed).toBe(1);
    await nextPoll();
    expect(cards.get(a)?.title).toContain('OFFLINE');
    expect(cards.get(a)?.timestamp).toBe(new Date(firstMiss).toISOString());
    expect(await stub().getState()).toEqual({});
  });

  it('keeps authoritative state across eviction and never re-imports stale KV', async () => {
    await env.ATC_STATE.put(STATE_KEY, '{}');
    feed = [entry(a)];
    await poll();
    const state = await stub().getState();
    expect(state?.[a]?.messages).toHaveLength(1);
    await env.ATC_STATE.put(STATE_KEY, JSON.stringify({ [b]: session(b) }));
    await evictDurableObject(stub());
    expect(await stub().getState()).toEqual(state);
    await nextPoll();
    expect(sent.filter((message) => message.method === 'POST')).toHaveLength(1);
  });

  it('coalesces concurrent HTTP and scheduled triggers into one feed fetch and one card', async () => {
    await seed({});
    feed = [entry(a)];
    const responses = await Promise.all([
      poll(), poll(), poll(),
      worker.scheduled(createScheduledController({ cron: '* * * * *' }), env, createExecutionContext()),
    ]);
    for (const response of responses.slice(0, 3)) expect(response?.status).toBe(200);
    expect(network.mock.calls.filter(([url]) => url === IVAO_ATC_SUMMARY_URL)).toHaveLength(1);
    expect(sent.filter((message) => message.method === 'POST')).toHaveLength(1);
  });

  it('shares a slow in-flight poll even when another poll interval has elapsed', async () => {
    await seed({});
    network.mockImplementationOnce(async () => {
      now += 120_000;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json([entry(a)]);
    });
    const results = await Promise.all([stub().poll(), stub().poll()]);
    expect(results).toEqual([{ skipped: false }, { skipped: true }]);
    expect(network.mock.calls.filter(([url]) => url === IVAO_ATC_SUMMARY_URL)).toHaveLength(1);
    expect(sent.filter((message) => message.method === 'POST')).toHaveLength(1);
  });

  it('does not count a second trigger as a missed poll, including after eviction', async () => {
    const tracked = session(a);
    tracked.messages![0]!.onlineEmbed = JSON.stringify(buildOnlineEmbed(tracked));
    await seed({ [a]: tracked });
    await poll();
    now += 25_000;
    await evictDurableObject(stub());
    const response = await poll();
    expect(await response.json()).toMatchObject({ skipped: true });
    expect((await stub().getState())?.[a]?.missed).toBe(1);
    expect(sent).toEqual([]);
    now = START + 60_000;
    await poll();
    expect(cards.get(a)?.title).toContain('OFFLINE');
  });

  it('accepts minute cron jitter while suppressing the offset fallback trigger', async () => {
    await seed({});
    await poll();
    now += 25_000;
    expect(await (await poll()).json()).toMatchObject({ skipped: true });
    now = START + 59_900;
    expect(await (await poll()).json()).toMatchObject({ skipped: false });
    expect(network.mock.calls.filter(([url]) => url === IVAO_ATC_SUMMARY_URL)).toHaveLength(2);
  });

  it('removes a departed non-host from the roster and leaves quiet polls alone', async () => {
    await seed({ [a]: session(a), [b]: session(b, START - 30_000) });
    feed = [entry(a), entry(b)];
    await poll();
    expect(roster(b)).toContain(a);
    const edits = sent.length;
    await nextPoll();
    expect(sent).toHaveLength(edits);
    feed = [entry(b)];
    await nextPoll();
    expect(roster(b)).toBeUndefined();
    expect(cards.get(b)?.title).toContain('ONLINE');
    await nextPoll();
    expect(cards.get(a)?.title).toContain('OFFLINE');
    const afterDeparture = sent.length;
    await nextPoll();
    expect(sent).toHaveLength(afterDeparture);
  });

  it('refreshes changed frequencies on both the controller card and the roster', async () => {
    await seed({ [a]: session(a), [b]: session(b, START - 30_000) });
    feed = [entry(a), entry(b)];
    await poll();
    feed = [entry(a, 121.7), entry(b)];
    await nextPoll();
    expect(roster(b)).toContain('121.700');
    expect(cards.get(a)?.fields?.[0]?.value).toBe('121.700 MHz');
    expect((await stub().getState())?.[a]?.frequency).toBe(121.7);
    const count = sent.length;
    await nextPoll();
    expect(sent).toHaveLength(count);
  });

  it('moves the roster to the last card posted when several controllers connect together', async () => {
    await seed({});
    feed = [entry(a), entry(b)];
    await poll();
    const posted = sent.filter((message) => message.method === 'POST');
    expect(roster(posted[0]!.id!)).toBeUndefined();
    expect(roster(posted[1]!.id!)).toContain(a);
    const count = sent.length;
    feed.reverse();
    await nextPoll();
    expect(sent).toHaveLength(count);
  });

  it('re-homes the roster when its host disappears and restores it on return', async () => {
    const c = 'QGLL_TWR';
    await seed({ [a]: session(a), [b]: session(b, START - 30_000), [c]: session(c, START - 90_000) });
    feed = [entry(a), entry(b), entry(c)];
    await poll();
    feed = [entry(a), entry(c)];
    await nextPoll();
    expect(roster(a)).toContain(c);
    expect(roster(a)).not.toContain(b);
    expect(roster(b)).toBeUndefined();
    feed = [entry(a), entry(b), entry(c)];
    await nextPoll();
    expect(roster(b)).toContain(a);
    expect(roster(a)).toBeUndefined();
    expect(sent.filter((message) => message.method === 'POST')).toHaveLength(0);
  });

  it('retries a failed roster edit on a quiet poll and stops after success', async () => {
    await seed({ [a]: session(a), [b]: session(b, START - 30_000) });
    feed = [entry(a), entry(b)];
    await poll();
    failures.add(b);
    feed = [entry(b)];
    await nextPoll();
    expect(roster(b)).toContain(a);
    failures.clear();
    await nextPoll();
    expect(roster(b)).toBeUndefined();
    const count = sent.length;
    await nextPoll();
    expect(sent).toHaveLength(count);
  });

  it('forgets a deleted host and moves the roster to a surviving card', async () => {
    const c = 'QGLL_TWR';
    await seed({ [a]: session(a), [b]: session(b, START - 30_000), [c]: session(c, START - 90_000) });
    feed = [entry(a), entry(b), entry(c)];
    await poll();
    failures.add(b);
    failureStatus = 404;
    cards.delete(b);
    // A coverage change makes the deleted host's next edit discover the 404.
    feed = [entry(a, 121.7), entry(b), entry(c)];
    await nextPoll();
    expect((await stub().getState())?.[b]?.messages).toEqual([]);
    expect(roster(a)).toContain(c);
    expect(roster(a)).toContain(b);
    const count = sent.length;
    await nextPoll();
    expect(sent).toHaveLength(count);
  });

  describe('roster continuation messages', () => {
    async function prepare(count = 120): Promise<void> {
      const many = Array.from({ length: count }, (_, i) => {
        const atc = entry(`QE${String(i).padStart(3, '0')}_TWR`);
        atc.atcPosition!.atcCallsign = 'Regional Approach Area';
        return atc;
      });
      feed = [entry(a), entry(b), ...many];
      const state: StateMap = { [a]: session(a, START - 30_000), [b]: session(b) };
      for (const atc of many) state[atc.callsign] = { ...session(atc.callsign), messages: [] };
      await seed(state);
    }

    function visibleCallsigns(): string[] {
      return [...cards.values()].flatMap((card) => (card.fields ?? [])
        .filter((field) => field.name.startsWith('Also online'))
        .flatMap((field) => field.value.match(/\b(?:QCTT_TWR|QESS_APP|QE\d{3}_TWR)\b/g) ?? []));
    }

    it('keeps every station visible after eviction and leaves unchanged pages alone', async () => {
      await prepare(400);
      expect((await poll()).status).toBe(200);
      const pages = (await snapshot())?.rosterMessages ?? [];
      expect(pages.length).toBeGreaterThan(1);
      expect(visibleCallsigns().sort()).toEqual(feed.map((atc) => atc.callsign).filter((cs) => cs !== a).sort());
      expect(sent.filter((message) => message.method === 'POST').every((message) => message.replyTo === a)).toBe(true);
      const sentCount = sent.length;
      await evictDurableObject(stub());
      expect((await nextPoll()).status).toBe(200);
      expect((await snapshot())?.rosterMessages).toEqual(pages);
      expect(sent).toHaveLength(sentCount);
      expect(deleted).toEqual([]);
    });

    it('retries a failed continuation post without rewriting the successful parent', async () => {
      await prepare();
      failures.add('POST');
      expect((await poll()).status).toBe(500);
      expect((await snapshot())?.error).toBe('some Discord roster updates failed');
      expect((await snapshot())?.rosterMessages).toBeUndefined();
      const edits = sent.filter((message) => message.method === 'PATCH').length;
      failures.clear();
      await abortAllDurableObjects();
      expect((await nextPoll()).status).toBe(200);
      expect((await snapshot())?.rosterMessages).toHaveLength(1);
      expect(sent.filter((message) => message.method === 'PATCH')).toHaveLength(edits);
      expect(visibleCallsigns()).toHaveLength(121);
    });

    it('reuses the remaining page and deletes excess pages when a large roster shrinks', async () => {
      await prepare(400);
      await poll();
      const pages = (await snapshot())!.rosterMessages!;
      expect(pages.length).toBeGreaterThan(1);
      const posts = sent.filter((message) => message.method === 'POST').length;
      feed = feed.slice(0, 122);
      expect((await nextPoll()).status).toBe(200);
      expect((await snapshot())?.rosterMessages?.map((page) => page.messageId)).toEqual([pages[0]!.messageId]);
      expect(deleted.sort()).toEqual(pages.slice(1).map((page) => page.messageId).sort());
      expect(sent.filter((message) => message.method === 'POST')).toHaveLength(posts);
      expect(visibleCallsigns().sort()).toEqual(feed.map((atc) => atc.callsign).filter((cs) => cs !== a).sort());
    });

    it('retries failed continuation edits and recreates deleted pages when they change', async () => {
      await prepare();
      await poll();
      const page = (await snapshot())!.rosterMessages![0]!;
      const atc = feed.find((item) => item.callsign === 'QE119_TWR')!;
      atc.atcSession.frequency = 121.7;
      failures.add(page.messageId);
      expect((await nextPoll()).status).toBe(500);
      expect((await snapshot())?.rosterMessages?.[0]?.onlineEmbed).toBe(page.onlineEmbed);
      failures.clear();
      await abortAllDurableObjects();
      expect((await nextPoll()).status).toBe(200);
      expect(cards.get(page.messageId)?.fields?.some((field) => field.value.includes('121.700'))).toBe(true);
      atc.atcSession.frequency = 122.8;
      failures.add(page.messageId);
      failureStatus = 404;
      cards.delete(page.messageId);
      expect((await nextPoll()).status).toBe(200);
      const replacement = (await snapshot())!.rosterMessages![0]!;
      expect(replacement.messageId).not.toBe(page.messageId);
      expect(cards.get(replacement.messageId)?.fields?.some((field) => field.value.includes('122.800'))).toBe(true);
      expect(visibleCallsigns()).toHaveLength(121);
    });

    it('keeps continuations until a failed parent edit has succeeded', async () => {
      await prepare();
      await poll();
      const pages = (await snapshot())!.rosterMessages!;
      failures.add(a);
      feed = [entry(a)];
      expect((await nextPoll()).status).toBe(500);
      expect(deleted).toEqual([]);
      expect((await snapshot())?.rosterMessages).toEqual(pages);
      failures.clear();
      expect((await nextPoll()).status).toBe(200);
      expect((await snapshot())?.rosterMessages).toBeUndefined();
      expect(deleted).toContain(pages[0]!.messageId);
    });

    it('retains failed cleanup after the roster shrinks and the host ends', async () => {
      await prepare();
      await poll();
      const page = (await snapshot())!.rosterMessages![0]!;
      failures.add(page.messageId);
      feed = [];
      expect((await nextPoll()).status).toBe(500);
      expect((await snapshot())?.rosterMessages).toEqual([page]);
      expect((await nextPoll()).status).toBe(500);
      expect(await stub().getState()).toEqual({});
      expect((await snapshot())?.rosterMessages).toEqual([page]);
      failures.clear();
      await abortAllDurableObjects();
      expect((await nextPoll()).status).toBe(200);
      expect((await snapshot())?.rosterMessages).toBeUndefined();
      expect(cards.has(page.messageId)).toBe(false);
    });

    it('moves continuations when the host disappears and cleans up after a host is excluded', async () => {
      await prepare();
      await poll();
      const original = (await snapshot())!.rosterMessages![0]!;
      feed = feed.filter((atc) => atc.callsign !== a);
      expect((await nextPoll()).status).toBe(200);
      expect(deleted).toContain(original.messageId);
      const replacement = (await snapshot())!.rosterMessages![0]!;
      expect(replacement.parentMessageId).toBe(b);
      expect(visibleCallsigns().sort()).toEqual(feed.map((atc) => atc.callsign).filter((cs) => cs !== b).sort());
      now += 60_000;
      await runInDurableObject(stub(), (_instance, ctx) => new PollCoordinator(ctx, {
        ...env, EXCLUDED_CALLSIGNS: b,
      }).poll());
      expect((await snapshot())?.rosterMessages).toBeUndefined();
      expect(deleted).toContain(replacement.messageId);
    });

    it('re-homes all pages when a changed parent message has been deleted', async () => {
      await prepare();
      await poll();
      const original = (await snapshot())!.rosterMessages![0]!;
      failures.add(a);
      failureStatus = 404;
      cards.delete(a);
      feed.find((atc) => atc.callsign === a)!.atcSession.frequency = 121.7;
      expect((await nextPoll()).status).toBe(200);
      expect(deleted).toContain(original.messageId);
      expect((await snapshot())?.rosterMessages?.[0]?.parentMessageId).toBe(b);
      expect(visibleCallsigns()).toHaveLength(121);
    });
  });

  it('releases the poll lock after a stalled feed request times out', async () => {
    await seed({});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    network.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
    }));
    const pending = poll();
    await vi.waitFor(() => expect(network).toHaveBeenCalled());
    // Run the timeout callback in the object's I/O context, just as a real
    // timer does; advancing it from the test's context cannot abort its fetch.
    await runInDurableObject(stub(), () => vi.advanceTimersByTimeAsync(10_000).then(() => undefined));
    const response = await pending;
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('timed out') });
    vi.useRealTimers();
    expect((await poll()).status).toBe(200);
  });

  it('retains failed offline updates without making ended cards green again', async () => {
    const tracked = session(b, START);
    tracked.missed = 1;
    tracked.roster = true;
    await seed({ [a]: session(a), [b]: tracked });
    feed = [entry(a)];
    failures.add(b);
    expect((await poll()).status).toBe(500);
    expect((await stub().getState())?.[b]).toBeUndefined();
    expect((await snapshot())?.pendingOffline?.[0]?.event.callsign).toBe(b);
    expect(sent.filter((message) => message.id === b).every((message) => message.embed.title?.includes('OFFLINE'))).toBe(true);
    failures.clear();
    expect((await nextPoll()).status).toBe(200);
    expect((await stub().getState())?.[b]).toBeUndefined();
    expect(cards.get(b)?.title).toContain('OFFLINE');
  });

  it('persists failed delivery bookkeeping and retries next minute after object restart', async () => {
    await seed({});
    feed = [entry(a)];
    failures.add('POST');
    expect((await poll()).status).toBe(500);
    expect((await stub().getState())?.[a]).toMatchObject({
      since: new Date(START).toISOString(), pendingChannelIds: ['test-channel'],
    });
    await abortAllDurableObjects();
    expect((await poll()).status).toBe(500);
    expect(sent).toHaveLength(1);
    failures.clear();
    expect((await nextPoll()).status).toBe(200);
    expect((await stub().getState())?.[a]?.messages).toHaveLength(1);
  });

  it('does not advance offline state during an upstream failure and releases the lock', async () => {
    const state = { [a]: session(a) };
    await seed(state);
    feedStatus = 503;
    expect((await poll()).status).toBe(500);
    expect(await stub().getState()).toEqual(state);
    expect(sent).toEqual([]);
    feedStatus = 200;
    feed = [entry(a)];
    expect((await poll()).status).toBe(200);
  });

  it('leaves tracked sessions untouched when the feed reports zero ATC worldwide', async () => {
    const state = { [a]: session(a) };
    await seed(state);
    network.mockImplementationOnce(async () => Response.json([]));
    const response = await poll();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('zero ATC worldwide'),
    });
    expect(await stub().getState()).toEqual(state);
    expect(sent).toEqual([]);
  });

  it('holds back untuned sessions and announces once, preserving the original start time', async () => {
    await seed({});
    feed = [entry(a, 0)];
    await poll();
    expect(sent).toEqual([]);
    feed = [entry(a)];
    await nextPoll();
    expect(sent.filter((message) => message.method === 'POST')).toHaveLength(1);
    expect((await stub().getState())?.[a]?.since).toBe(new Date(START).toISOString());
    const count = sent.length;
    feed = [entry(a, 0)];
    await nextPoll();
    expect(sent).toHaveLength(count);
    expect((await stub().getState())?.[a]?.frequency).toBe(118.1);
  });

  it('fails before notification if the legacy import cannot be persisted', async () => {
    feed = [entry(a)];
    await runInDurableObject(stub(), async (_instance, ctx) => {
      vi.spyOn(ctx.storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
    });
    expect((await poll()).status).toBe(500);
    expect(network).not.toHaveBeenCalled();
    expect((await poll()).status).toBe(200);
  });

  it('reports a failed final save without acknowledging unpersisted state', async () => {
    await seed({});
    feed = [entry(a)];
    await runInDurableObject(stub(), async (_instance, ctx) => {
      vi.spyOn(ctx.storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
    });
    expect((await poll()).status).toBe(500);
    expect(await stub().getState()).toEqual({});
    expect((await snapshot())?.lastPollStartedAt).toBeUndefined();
    expect((await snapshot())?.lastSuccessfulPollAt).toBeUndefined();
    // Discord has already accepted the message: coordination is not an atomic
    // transaction with Discord. The API must report failure, not false success.
    expect(sent.filter((message) => message.method === 'POST')).toHaveLength(1);
  });

  it('rejects unauthorized or non-POST triggers before polling', async () => {
    const ctx = createExecutionContext();
    const denied = await worker.fetch(new Request('https://bot.test/poll', { method: 'POST' }), env, ctx);
    expect(denied.status).toBe(401);
    const get = await worker.fetch(new Request('https://bot.test/poll'), env, ctx);
    expect(get.status).toBe(405);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([1, 2])('returns 404 for retired Discord interaction type %i without network work', async (type) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://bot.test/interactions', {
      method: 'POST',
      body: JSON.stringify({ type, token: 'retired-interaction', data: { name: 'atc' } }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(network).not.toHaveBeenCalled();
  });
});
