import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findBotReplies } from '../src/discord';
import { DiscordRateLimits } from '../src/discord-rate-limit';
import { syncRosterMessages } from '../src/roster';
import type { RosterMessage, RosterPostAttempt } from '../src/types';
import { BOT_ID, BOT_TOKEN as TOKEN, snowflakeAt as idAt } from './helpers';

const NOW = 1_800_000_000_000;
const WINDOW = { from: NOW - 120_000, to: NOW - 60_000 };

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  stubDiscord(() => Response.json({ code: 0 }, { status }));
  const pending = syncRosterMessages(TOKEN, [], [], new DiscordRateLimits(), [dropped({ abandoned: true })]);
  // A 5xx scan is retried in-request with backoff: advance it instead of waiting.
  await vi.advanceTimersByTimeAsync(4_000);
  const result = await pending;
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
  const requests = stubDiscord(() => Response.json({ code: 50013 }, { status: 403 }));
  const pageId = idAt(WINDOW.from, 5);
  await syncRosterMessages(TOKEN, [{ channelId: '100000000000000321', parentMessageId: 'old-parent', page: 0, messageId: pageId }],
    [], new DiscordRateLimits(), [dropped()], ['other', '100000000000000321']);
  // The delete reaches Discord and is refused there.
  expect(requests).toContain(`DELETE /channels/100000000000000321/messages/${pageId}`);
  const logs = error.mock.calls.map((call) => String(call[0]));
  expect(logs).toContainEqual(expect.stringContaining('"event":"roster_continuation_failed","operation":"delete","channelIndex":1'));
  expect(logs).toContainEqual(expect.stringContaining('"event":"roster_orphan_sweep_failed","channelIndex":1'));
  expect(logs.filter((line) => ['100000000000000321', 'old-parent', pageId].some((id) => line.includes(id)))).toEqual([]);
});

describe('R233: roster pages under a bot-token outage or the poll time budget', () => {
  const channelId = '100000000000000321';
  const page = (extra: Partial<RosterMessage> = {}): RosterMessage =>
    ({ channelId, parentMessageId: 'parent', page: 0, messageId: idAt(NOW, 1), onlineEmbed: 'stale', ...extra });
  const unauthorized = () => Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 });

  it.each(['edit', 'post', 'delete'] as const)(
    'D1: never charges or abandons a roster %s rejected with a 401, then completes it once the token works', async (op) => {
      let rejected = true;
      const requests = stubDiscord((method) => rejected ? unauthorized()
        : method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: idAt(NOW, 9) }));
      const embed = { title: 'Synthetic page 0' };
      // A delete removes page 0 (the target has no pages); an edit replaces its
      // stale content; a post creates a page that was never sent.
      const target = { channelId, parentMessageId: 'parent', embeds: op === 'delete' ? [] : [embed] };
      let messages: RosterMessage[] = op === 'post' ? [] : [page()];
      let attempts: RosterPostAttempt[] = [];
      // More polls than the rejection budget (REJECTION_RETRY_POLLS + 1) allows.
      for (let poll = 0; poll < 12; poll++) {
        const result = await syncRosterMessages(TOKEN, messages, [target], new DiscordRateLimits(), attempts);
        expect(result.failed).toBe(true);
        ({ messages, postAttempts: attempts } = result);
      }
      // One real request per poll, each refused: nothing charged or abandoned.
      expect(requests).toHaveLength(12);
      if (op === 'post') {
        expect(messages).toEqual([]);
        // No uncertain-post window either: a 401 certainly posted nothing.
        expect(attempts).toEqual([{ channelId, parentMessageId: 'parent', page: 0, attempts: 0, nonceKey: expect.any(String) }]);
      } else {
        expect(messages).toEqual([page({ [op === 'delete' ? 'deleteAttempts' : 'pageAttempts']: 0 })]);
        expect(attempts).toEqual([]);
      }

      rejected = false;
      const done = await syncRosterMessages(TOKEN, messages, [target], new DiscordRateLimits(), attempts);
      expect(done.failed).toBe(false);
      expect(done.postAttempts).toEqual([]);
      expect(done.messages).toEqual({
        edit: [page({ onlineEmbed: JSON.stringify(embed) })],
        // A retried post leaves its content unknown: its nonce may have returned an earlier copy.
        post: [{ channelId, parentMessageId: 'parent', page: 0, messageId: idAt(NOW, 9) }],
        delete: [],
      }[op]);
      expect(requests).toHaveLength(13);
    });

  it('D1: a 401 defers every later roster request in the same poll without sending it', async () => {
    const requests = stubDiscord(() => unauthorized());
    const result = await syncRosterMessages(TOKEN, [page({ page: 1, messageId: idAt(NOW, 2) })],
      [{ channelId, parentMessageId: 'parent', embeds: [{ title: 'Synthetic page 0' }] }],
      new DiscordRateLimits(), [dropped()]);
    // Only the delete of page 1 reached Discord; the post and the orphan sweep did not.
    expect(requests).toEqual([`DELETE /channels/${channelId}/messages/${idAt(NOW, 2)}`]);
    expect(result.messages).toEqual([page({ page: 1, messageId: idAt(NOW, 2), deleteAttempts: 0 })]);
    const { nonceKey: _nonceKey, ...sweepWindow } = dropped();
    expect(result.postAttempts).toEqual([
      { channelId, parentMessageId: 'parent', page: 0, attempts: 0, nonceKey: expect.any(String) }, sweepWindow,
    ]);
  });

  it('D4: keeps an edit, post, delete and orphan sweep deferred by the poll time budget, charging none', async () => {
    const requests = stubDiscord(() => Response.json({ id: idAt(NOW, 9) }));
    const limits = new DiscordRateLimits();
    // No request can finish in time any more.
    limits.setDeadline(NOW);
    const target = { channelId, parentMessageId: 'parent', embeds: [{ title: 'Synthetic page 0' }, { title: 'Synthetic page 1' }] };
    const previous = [
      page({ pageAttempts: 3 }),
      page({ page: 2, messageId: idAt(NOW, 3), onlineEmbed: undefined, deleteAttempts: 4 }),
    ];
    const neverPosted: RosterPostAttempt = { channelId, parentMessageId: 'parent', page: 1, attempts: 5, nonceKey: 'roster:parent:1:x' };
    const result = await syncRosterMessages(TOKEN, previous, [target], limits, [neverPosted, dropped()]);
    expect(requests).toEqual([]);
    expect(result.failed).toBe(true);
    // Every counter is unchanged, nothing is abandoned, and no window is invented.
    expect(result.messages).toEqual(previous);
    const { nonceKey: _nonceKey, ...sweepWindow } = dropped();
    expect(result.postAttempts).toEqual([neverPosted, sweepWindow]);
  });
});
