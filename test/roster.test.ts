import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { findBotReplies } from '../src/discord';
import { DiscordRateLimits } from '../src/discord-rate-limit';
import { syncRosterMessages } from '../src/roster';
import type { RosterPostAttempt } from '../src/types';

// The first token segment is base64 of the bot's synthetic user id.
const BOT_ID = '100000000000000009';
const TOKEN = `${btoa(BOT_ID)}.synthetic.token`;
const NOW = 1_800_000_000_000;
const WINDOW = { from: NOW - 120_000, to: NOW - 60_000 };

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** A snowflake for a synthetic message created at the given time. */
function idAt(ms: number, n = 0): string {
  return ((BigInt(ms - 1_420_070_400_000) << 22n) + BigInt(n)).toString();
}

function reply(id: string, parent: string, author = BOT_ID) {
  return { id, author: { id: author }, message_reference: { message_id: parent } };
}

function dropped(overrides: Partial<RosterPostAttempt> = {}): RosterPostAttempt {
  return {
    channelId: '100000000000000321', parentMessageId: 'old-parent', page: 0, attempts: 0, nonceKey: 'roster:old-parent:0:x',
    maybePostedFrom: WINDOW.from, maybePostedTo: WINDOW.to, ...overrides,
  };
}

function stubDiscord(handler: (method: string, path: string) => Response) {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('https://discord.com/api/v10', '');
    requests.push(`${init?.method} ${path}`);
    return handler(init?.method ?? 'GET', path);
  }));
  return requests;
}

it('finds only this bot’s replies to the parent, scanning from the attempt window', async () => {
  const requests = stubDiscord(() => Response.json([
    reply(idAt(WINDOW.from, 1), 'parent'), reply(idAt(WINDOW.from, 2), 'other'),
    reply(idAt(WINDOW.from, 3), 'parent', '100000000000000001'), { id: 'x' },
  ]));
  await expect(findBotReplies(TOKEN, '100000000000000321', 'parent', WINDOW, new DiscordRateLimits()))
    .resolves.toEqual([idAt(WINDOW.from, 1)]);
  expect(requests).toEqual([`GET /channels/100000000000000321/messages?after=${idAt(WINDOW.from - 60_000)}&limit=100`]);
});

it('pages through a busy channel until it passes the attempt window', async () => {
  const early = Array.from({ length: 100 }, (_, n) => reply(idAt(WINDOW.from, n), 'someone-else'));
  const requests = stubDiscord((_method, path) =>
    path.includes(`after=${idAt(WINDOW.from - 60_000)}`) ? Response.json(early)
      : Response.json([reply(idAt(WINDOW.to), 'parent')]));
  await expect(findBotReplies(TOKEN, '100000000000000321', 'parent', WINDOW, new DiscordRateLimits()))
    .resolves.toEqual([idAt(WINDOW.to)]);
  expect(requests).toHaveLength(2);
});

it('finds nothing when the bot id cannot be read from the token', async () => {
  const requests = stubDiscord(() => Response.json([]));
  await expect(findBotReplies('not-a-token', '100000000000000321', 'parent', WINDOW, new DiscordRateLimits())).resolves.toEqual([]);
  expect(requests).toEqual([]);
});

it('deletes an untracked page left behind when its parent is no longer shown', async () => {
  const orphan = idAt(WINDOW.from, 1);
  const kept = idAt(WINDOW.from, 2);
  const requests = stubDiscord((method, path) => {
    if (method === 'GET') return Response.json([reply(orphan, 'old-parent'), reply(kept, 'old-parent')]);
    if (path.endsWith(`/${kept}`)) return Response.json({ code: 50013 }, { status: 403 });
    return new Response(null, { status: 204 });
  });
  const result = await syncRosterMessages(TOKEN, [
    // Still tracked (its delete keeps failing), so it must not be swept.
    { channelId: '100000000000000321', parentMessageId: 'old-parent', page: 1, messageId: kept, deleteAttempts: 1 },
  ], [], new DiscordRateLimits(), [dropped()]);
  expect(result.postAttempts).toEqual([]);
  expect(result.messages.map((ref) => ref.messageId)).toEqual([kept]);
  expect(requests.filter((request) => request.startsWith('DELETE'))).toEqual([
    `DELETE /channels/100000000000000321/messages/${kept}`, `DELETE /channels/100000000000000321/messages/${orphan}`,
  ]);
});

it('never sweeps a parent that is still shown, keeping the uncertain page marker', async () => {
  const requests = stubDiscord(() => new Response(null, { status: 204 }));
  const parentPage = { embeds: [{ title: 'Synthetic page 0' }] };
  const result = await syncRosterMessages(TOKEN, [
    { channelId: '100000000000000321', parentMessageId: 'old-parent', page: 0, messageId: 'p0',
      onlineEmbed: JSON.stringify(parentPage.embeds[0]) },
  ], [{ channelId: '100000000000000321', parentMessageId: 'old-parent', ...parentPage }], new DiscordRateLimits(), [dropped({ page: 1 })]);
  expect(requests).toEqual([]);
  expect(result.postAttempts).toEqual([dropped({ page: 1 })]);
});

it('does not sweep for a dropped page that certainly never reached Discord', async () => {
  const requests = stubDiscord(() => Response.json([]));
  const result = await syncRosterMessages(TOKEN, [], [], new DiscordRateLimits(), [
    dropped({ maybePostedFrom: undefined, maybePostedTo: undefined, attempts: 1 }),
  ]);
  expect(requests).toEqual([]);
  expect(result.postAttempts).toEqual([]);
});

it.each([
  { status: 503, kept: true },
  { status: 403, kept: false },
])('keeps sweeping after a transient failure but gives up on a 4xx (%j)', async ({ status, kept }) => {
  stubDiscord(() => Response.json({ code: 0 }, { status }));
  const result = await syncRosterMessages(TOKEN, [], [], new DiscordRateLimits(), [dropped({ abandoned: true })]);
  // C20: a failed sweep fails the poll like any other roster update.
  expect(result.failed).toBe(true);
  // Only the time window is kept, so a returning parent posts the page fresh.
  expect(result.postAttempts).toEqual(kept ? [dropped({ nonceKey: undefined })].map(({ nonceKey: _n, ...rest }) => rest) : []);
});

it('keeps a sweep-only marker when a page posts after an uncertain attempt', async () => {
  const target = { channelId: '100000000000000321', parentMessageId: 'parent', embeds: [{ title: 'Synthetic page 0' }] };
  stubDiscord(() => Response.json({ id: idAt(NOW) }));
  const result = await syncRosterMessages(TOKEN, [], [target], new DiscordRateLimits(), [
    dropped({ parentMessageId: 'parent' }),
  ]);
  expect(result.messages.map((ref) => ref.messageId)).toEqual([idAt(NOW)]);
  expect(result.postAttempts).toEqual([{
    channelId: '100000000000000321', parentMessageId: 'parent', page: 0, attempts: 0,
    maybePostedFrom: WINDOW.from, maybePostedTo: WINDOW.to,
  }]);
});

it('records when a post may have landed unseen, but not for a definite rejection', async () => {
  const target = { channelId: '100000000000000321', parentMessageId: 'parent', embeds: [{ title: 'Synthetic page 0' }] };
  stubDiscord(() => Response.json({ code: 0 }, { status: 502 }));
  let result = await syncRosterMessages(TOKEN, [], [target], new DiscordRateLimits());
  expect(result.postAttempts[0]).toMatchObject({ maybePostedFrom: NOW, maybePostedTo: NOW });
  stubDiscord(() => Response.json({ code: 50013 }, { status: 403 }));
  result = await syncRosterMessages(TOKEN, [], [target], new DiscordRateLimits());
  expect(result.postAttempts[0]?.maybePostedFrom).toBeUndefined();
});

it('logs roster failures by configured channel index, never channel or message IDs', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  stubDiscord(() => Response.json({ code: 50013 }, { status: 403 }));
  await syncRosterMessages(TOKEN, [{ channelId: '100000000000000321', parentMessageId: 'old-parent', page: 0, messageId: 'page-id' }],
    [], new DiscordRateLimits(), [dropped()], ['other', '100000000000000321']);
  const logs = error.mock.calls.map((call) => String(call[0]));
  expect(logs).toContainEqual(expect.stringContaining('"event":"roster_continuation_failed","operation":"delete","channelIndex":1'));
  expect(logs).toContainEqual(expect.stringContaining('"event":"roster_orphan_sweep_failed","channelIndex":1'));
  expect(logs.filter((line) => /"100000000000000321"|old-parent|page-id/.test(line))).toEqual([]);
});
