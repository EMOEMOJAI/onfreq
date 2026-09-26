import { afterEach, expect, it, vi } from 'vitest';
import { findBotReplies } from '../src/discord';
import { DiscordRateLimits } from '../src/discord-rate-limit';
import { syncRosterMessages } from '../src/roster';

// The first token segment is base64 of the bot's synthetic user id.
const BOT_ID = '100000000000000009';
const TOKEN = `${btoa(BOT_ID)}.synthetic.token`;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function reply(id: string, parent: string, author = BOT_ID) {
  return { id, author: { id: author }, message_reference: { message_id: parent } };
}

it('finds only this bot’s replies to the given parent', async () => {
  const fetchMock = vi.fn(async () => Response.json([
    reply('m1', 'parent'), reply('m2', 'other'), reply('m3', 'parent', '100000000000000001'), { id: 'm4' },
  ]));
  vi.stubGlobal('fetch', fetchMock);
  await expect(findBotReplies(TOKEN, 'chan', 'parent', new DiscordRateLimits())).resolves.toEqual(['m1']);
  expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/channels/chan/messages?after=parent&limit=50');
});

it('finds nothing when the bot id cannot be read from the token', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(findBotReplies('not-a-token', 'chan', 'parent', new DiscordRateLimits())).resolves.toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('deletes an untracked page left behind when a retried page is dropped with its old parent', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method} ${String(input).replace('https://discord.com/api/v10', '')}`);
    if (init?.method === 'GET') return Response.json([reply('orphan', 'old-parent'), reply('kept', 'old-parent')]);
    if (String(input).endsWith('/kept')) return Response.json({ code: 50013 }, { status: 403 });
    return new Response(null, { status: 204 });
  }));
  const result = await syncRosterMessages(TOKEN, [
    // Still tracked (its delete keeps failing), so it must not be swept.
    { channelId: 'chan', parentMessageId: 'old-parent', page: 1, messageId: 'kept', deleteAttempts: 1 },
  ], [], new DiscordRateLimits(), [
    { channelId: 'chan', parentMessageId: 'old-parent', page: 0, attempts: 0, nonceKey: 'roster:old-parent:0:x' },
  ]);
  expect(result.postAttempts).toEqual([]);
  expect(result.messages.map((ref) => ref.messageId)).toEqual(['kept']);
  expect(requests).toContain('GET /channels/chan/messages?after=old-parent&limit=50');
  expect(requests).toContain('DELETE /channels/chan/messages/orphan');
  expect(requests.filter((request) => request.startsWith('DELETE'))).toEqual([
    'DELETE /channels/chan/messages/kept', 'DELETE /channels/chan/messages/orphan',
  ]);
});

it('does not sweep for a dropped page that never reached Discord', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await syncRosterMessages(TOKEN, [], [], new DiscordRateLimits(), [
    { channelId: 'chan', parentMessageId: 'old-parent', page: 0, attempts: 1 },
  ]);
  expect(fetchMock).not.toHaveBeenCalled();
});
