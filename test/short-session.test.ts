import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COORDINATOR_NAME, IVAO_ATC_SUMMARY_URL, POLL_SNAPSHOT_KEY } from '../src/config';
import { PollCoordinator, type PollSnapshot } from '../src/coordinator';
import type { DiscordEmbed } from '../src/discord';
import { buildShortSessionEmbed, trustedStateAt } from '../src/short-session';
import { diffState, loadPendingOffline, loadSessions } from '../src/state';
import type { IvaoAtcSummaryEntry, OnlineAtc, PendingOffline, StateMap, TrackedAtc } from '../src/types';
import { seedGca } from './helpers';

// Entirely synthetic members, connections and Discord IDs.
const START = Date.parse('2026-10-01T10:00:00Z');
const VID = 600001;
const MEMBER = '200000000000000001';
const OTHER_MEMBER = '200000000000000002';
const COPY = '200000000000000099';
const DM_CHANNEL = '300000000000000001';
const PUBLIC = '900000000000000001';
const ROLE = (env as Env).GCA_MEMBER_ROLE_ID!;
const stub = () => env.POLL_COORDINATOR.getByName(COORDINATOR_NAME);
const iso = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

let now: number;
let feed: IvaoAtcSummaryEntry[];
let calls: string[];
let dms: { embeds: DiscordEmbed[]; allowed_mentions?: unknown }[];
let dmRecipients: string[];
let members: unknown[];
let memberListCalls: number;
let dmFailure: 'none' | 'timeout' | 'global429';
let statusDuringPost: string[];
let activeCtx: DurableObjectState | undefined;
let onCardPost: (() => void) | undefined;
let cardId: number;
let logs: ReturnType<typeof vi.spyOn>[];

function entry(callsign: string, userId = VID, frequency = 118.1, id = 1): IvaoAtcSummaryEntry {
  return {
    id, userId, callsign,
    atcSession: { frequency, position: callsign.split('_').at(-1)! },
    atcPosition: { atcCallsign: 'Example Station' }, subcenter: null,
  };
}

function settings(overrides: Partial<Env> = {}): Env {
  return {
    ...env, SHORT_SESSION_DM_ENABLED: 'true', GCA_DM_ENABLED: undefined, GCA_COPY_USER_ID: COPY, ...overrides,
  } as Env;
}

function poll(overrides: Partial<Env> = {}) {
  return runInDurableObject(stub(), (_instance, ctx) => {
    activeCtx = ctx;
    return new PollCoordinator(ctx, settings(overrides)).poll();
  });
}

/** One poll `minutes` after START with the given monitored feed. */
function at(minutes: number, current: IvaoAtcSummaryEntry[], overrides: Partial<Env> = {}) {
  now = START + minutes * 60_000;
  feed = current;
  return poll(overrides);
}

function seedSnapshot(snapshot: PollSnapshot) {
  return runInDurableObject(stub(), (_instance, ctx) => ctx.storage.put(POLL_SNAPSHOT_KEY, snapshot));
}

function snapshot() {
  return runInDurableObject(stub(), (_instance, ctx) => ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY));
}

function tables(): Promise<string[]> {
  return runInDurableObject(stub(), (_instance, ctx) => ctx.storage.sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((row) => row.name));
}

function rows() {
  return runInDurableObject(stub(), (_instance, ctx) => {
    const exists = ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'short_sessions'").toArray().length;
    return exists ? ctx.storage.sql.exec<{
      session_key: string; user_id: number; callsign: string; session_ids: string; status: string; attempts: number;
      ended_at: number; seen_after: number; duration_minutes: number; due_at: number; expires_at: number;
    }>('SELECT * FROM short_sessions ORDER BY rowid').toArray() : [];
  });
}

function logged(event: string): Record<string, unknown>[] {
  return logs.flatMap((spy) => spy.mock.calls)
    .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown>; } catch { return {}; } })
    .filter((line) => line.event === event);
}

function shortSessionLogs(): string {
  return JSON.stringify(logs.flatMap((spy) => spy.mock.calls).map(([line]) => String(line))
    .filter((line) => line.includes('short_session')));
}

/** A carded TWR session from minute 1 that drops at `endMinute` and closes one poll later. */
async function shortSession(endMinute = 5, overrides: Partial<Env> = {}, others: IvaoAtcSummaryEntry[] = []) {
  await at(0, others, overrides);
  await at(1, [...others, entry('QCTT_TWR')], overrides);
  await at(endMinute, others, overrides);
  await at(endMinute + 1, others, overrides);
}

beforeEach(() => {
  now = START;
  feed = [];
  calls = [];
  dms = [];
  dmRecipients = [];
  members = [{ user: { id: MEMBER }, nick: `Member (${VID})`, roles: [ROLE] }];
  memberListCalls = 0;
  dmFailure = 'none';
  statusDuringPost = [];
  activeCtx = undefined;
  onCardPost = undefined;
  cardId = 0;
  logs = (['log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === IVAO_ATC_SUMMARY_URL) return Response.json([entry('EGLL_TWR', 1), ...feed]);
    if (url.includes('/guilds/') && url.includes('/members?')) {
      memberListCalls++;
      return Response.json(members);
    }
    if (url.endsWith('/users/@me/channels')) {
      const recipient = (JSON.parse(String(init?.body)) as { recipient_id: string }).recipient_id;
      calls.push('dm_open');
      dmRecipients.push(recipient);
      return Response.json({ id: DM_CHANNEL, type: 1, recipients: [{ id: recipient }] });
    }
    if (url.endsWith(`/channels/${DM_CHANNEL}/messages`)) {
      calls.push('dm_post');
      dms.push(JSON.parse(String(init?.body)));
      const ctx = activeCtx!;
      if (ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'short_sessions'").toArray().length) {
        statusDuringPost.push(...ctx.storage.sql.exec<{ status: string }>(
          "SELECT status FROM short_sessions WHERE status = 'reserved'").toArray().map((row) => row.status));
      }
      if (dmFailure === 'timeout') throw new Error('Synthetic timeout after Discord may have delivered');
      if (dmFailure === 'global429') {
        return Response.json({ retry_after: 120, global: true }, { status: 429 });
      }
      return Response.json({ id: '300000000000000002' });
    }
    if (url.startsWith(`https://discord.com/api/v10/channels/${PUBLIC}/messages`)) {
      const method = init?.method ?? 'GET';
      calls.push(`card_${method}`);
      if (method === 'POST') onCardPost?.();
      return Response.json({ id: method === 'POST' ? `80000000000000${String(++cardId).padStart(4, '0')}` : url.split('/').at(-1) });
    }
    throw new Error(`Unexpected request ${url}`);
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

describe('short-session reminders', () => {
  it('sends exactly one DM without GCA enabled, creating no GCA table and no staff copy', async () => {
    await shortSession(16);
    expect(await rows()).toMatchObject([{
      user_id: VID, callsign: 'QCTT_TWR', session_ids: '[1]', status: 'pending', duration_minutes: 15,
      seen_after: START, ended_at: START + 16 * 60_000, due_at: START + 26 * 60_000, expires_at: START + 136 * 60_000,
    }]);
    await at(25, []);
    expect(dms).toEqual([]);
    await at(26, []);
    await at(27, []);
    await at(40, []);
    expect(dms).toHaveLength(1);
    expect(dms[0]).toEqual({
      embeds: [buildShortSessionEmbed('QCTT_TWR', 15)], allowed_mentions: { parse: [] },
    });
    expect(dms[0]!.embeds[0]!.description).toContain('for about 15 minutes');
    expect(dmRecipients).toEqual([MEMBER]);
    expect(memberListCalls).toBe(1);
    // Finished rows keep no callsign column; the key is deleted with the row.
    expect(await rows()).toMatchObject([{ status: 'sent', callsign: '', attempts: 1 }]);
    expect((await tables()).filter((name) => name.startsWith('gca_'))).toEqual([]);
    expect(logged('short_session_poll_failed')).toEqual([]);
    expect(logged('short_session_dm_sent')).toHaveLength(1);
    const lines = shortSessionLogs();
    for (const privateValue of [String(VID), MEMBER, COPY, 'QCTT']) expect(lines).not.toContain(privateValue);
    expect(JSON.stringify(dms)).not.toContain(String(VID));
  });

  it('sends nothing when a gap before first sight puts the bound at 30 minutes, however short the observed session', async () => {
    await at(0, []);
    await at(25, [entry('QCTT_TWR')]);
    await at(30, []);
    await at(31, []);
    await at(45, []);
    expect(await rows()).toEqual([]);
    expect(dms).toEqual([]);
  });

  it('sends nothing for a session tracked from a legacy snapshot without stateAt', async () => {
    await seedSnapshot({ state: {} });
    await at(0, [entry('QCTT_TWR')]);
    expect((await snapshot())!.state!.QCTT_TWR!.seenAfter).toBeUndefined();
    expect((await snapshot())!.stateAt).toBe(iso(0));
    await at(5, []);
    await at(6, []);
    await at(20, []);
    expect(await rows()).toEqual([]);
    expect(dms).toEqual([]);
  });

  it('sends nothing for a pre-upgrade session without seenAfter', async () => {
    const legacy: TrackedAtc = {
      sessionId: 1, userId: VID, callsign: 'QCTT_TWR', frequency: 118.1, position: 'TWR', station: null,
      location: null, since: iso(-5), missed: 0, messages: [{ channelId: PUBLIC, messageId: '800000000000009999' }],
    };
    await seedSnapshot({ state: { QCTT_TWR: legacy }, stateAt: iso(-1) });
    await at(0, []);
    await at(1, []);
    await at(15, []);
    expect(await rows()).toEqual([]);
    expect(dms).toEqual([]);
  });

  it('a grace-window resume keeps seenAfter and records nothing', async () => {
    await at(0, []);
    await at(1, [entry('QCTT_TWR')]);
    await at(5, []);
    await at(6, [entry('QCTT_TWR', VID, 118.1, 2)]);
    expect((await snapshot())!.state!.QCTT_TWR).toMatchObject({ seenAfter: iso(0), since: iso(1), sessionId: 2 });
    await at(20, [entry('QCTT_TWR', VID, 118.1, 2)]);
    expect(await rows()).toEqual([]);
  });

  it('an APP to TWR switch inherits presence, so neither half is reported', async () => {
    await at(0, []);
    await at(1, [entry('QCAA_APP')]);
    await at(20, [entry('QCAA_TWR', VID, 118.1, 2)]);
    expect((await snapshot())!.state!.QCAA_TWR!.seenAfter).toBe(iso(0));
    await at(21, [entry('QCAA_TWR', VID, 118.1, 2)]);
    // The APP half alone is short, but its controller is still online when it falls due.
    await at(30, [entry('QCAA_TWR', VID, 118.1, 2)]);
    await at(36, []);
    await at(37, []);
    await at(50, []);
    expect((await rows()).map((row) => [row.session_key, row.status])).toEqual([[`${VID}:QCAA_APP:${iso(1)}`, 'reconnected']]);
    expect(dms).toEqual([]);
  });

  it.each([
    ['an excluded callsign', entry('QCTT_GND'), { EXCLUDED_CALLSIGNS: 'QCTT_GND' }],
    ['a special position', entry('QCTT_X_GND'), {}],
    ['0.000 MHz', entry('QCTT_GND', VID, 0), {}],
  ])('a reconnect at %s counts as back online', async (_label, reconnect, overrides: Partial<Env>) => {
    await shortSession(5, overrides);
    await at(15, [reconnect], overrides);
    expect(await rows()).toMatchObject([{ status: 'reconnected' }]);
    expect(dms).toEqual([]);
  });

  it.each([
    ['more than ten sessions end', 11, 0],
    ['most tracked sessions end', 3, 2],
  ])('records nothing when %s in one poll', async (_label, ending: number, staying: number) => {
    const session = (n: number): TrackedAtc => ({
      sessionId: n, userId: VID + n, callsign: `QCT${String.fromCharCode(65 + n)}_TWR`, frequency: 118.1, position: 'TWR',
      station: null, location: null, since: iso(-10), seenAfter: iso(-11), missed: 0,
      messages: [{ channelId: PUBLIC, messageId: `80000000000001${String(n).padStart(4, '0')}` }],
    });
    const all = Array.from({ length: ending + staying }, (_, n) => session(n));
    const state: StateMap = Object.fromEntries(all.map((s) => [s.callsign, s]));
    const kept = all.slice(ending).map((s) => entry(s.callsign, s.userId, 118.1, s.sessionId));
    await seedSnapshot({ state, stateAt: iso(-1) });
    await at(0, kept);
    await at(1, kept);
    expect(await rows()).toEqual([]);
    expect(logged('short_session_anomaly')).toEqual([{ event: 'short_session_anomaly', ended: ending, tracked: ending + staying }]);
  });

  it('a feed much smaller than the tracked state defers delivery', async () => {
    const others = [1, 2, 3, 4].map((n) => entry(`QCO${n}_CTR`, 700000 + n, 125.1, 10 + n));
    await shortSession(5, {}, others);
    await at(15, others.slice(0, 1));
    expect(await rows()).toMatchObject([{ status: 'pending' }]);
    expect(dms).toEqual([]);
    await at(16, others);
    expect(dms).toHaveLength(1);
  });

  it.each([
    ['sent', true], ['reserved', true], ['failed', true], ['baseline', false], ['unmapped', false],
  ])('a GCA reminder %s for the same connection suppresses: %s', async (status, suppressed) => {
    await seedGca((sql) => sql.exec('INSERT INTO gca_reminders (session_key, status, last_seen) VALUES (?, ?, ?)',
      `${VID}:1`, status, START));
    await shortSession();
    await at(15, []);
    expect(await rows()).toMatchObject([{ status: suppressed ? 'skipped_gca' : 'sent' }]);
    expect(dms).toHaveLength(suppressed ? 0 : 1);
  });

  it('sends at most one reminder per member per 24 hours', async () => {
    await shortSession();
    await at(15, []);
    await at(20, [entry('QCTT_GND', VID, 121.9, 2)]);
    await at(25, []);
    await at(26, []);
    await at(35, []);
    expect((await rows()).map((row) => row.status)).toEqual(['sent', 'skipped_daily']);
    expect(dms).toHaveLength(1);
  });

  it('F1: an ambiguous failure counts towards the daily cap', async () => {
    dmFailure = 'timeout';
    await shortSession();
    await at(15, []);
    expect(dms).toHaveLength(1);
    expect(await rows()).toMatchObject([{ status: 'failed' }]);
    dmFailure = 'none';
    await at(70, []);
    await at(71, [entry('QCTT_GND', VID, 121.9, 2)]);
    await at(75, []);
    await at(76, []);
    await at(85, []);
    expect((await rows()).map((row) => row.status)).toEqual(['failed', 'skipped_daily']);
    expect(dms).toHaveLength(1);
  });

  it('F1: keeps 24 hours between actual sends when the first was delivered late', async () => {
    await shortSession();
    // Delivered just before expiry, almost two hours after the session ended.
    await at(124, []);
    expect(dms).toHaveLength(1);
    // Ended more than 24 h after the first session, but due under 24 h after its DM.
    await at(1485, []);
    await at(1486, [entry('QCTT_GND', VID, 121.9, 2)]);
    await at(1490, []);
    await at(1491, []);
    await at(1500, []);
    expect(dms).toHaveLength(1);
    // Past 24 h plus the expiry window after the first session ended.
    await at(1585, []);
    await at(1586, [entry('QCTT_DEL', VID, 121.7, 3)]);
    await at(1590, []);
    await at(1591, []);
    await at(1600, []);
    expect((await rows()).map((row) => row.status)).toEqual(['sent', 'skipped_daily', 'sent']);
    expect(dms).toHaveLength(2);
  });

  it('A1: a feed gap within one IVAO connection does not shorten its presence', async () => {
    await at(0, []);
    await at(1, [entry('QCTT_TWR')]);
    await at(119, [entry('QCTT_TWR')]);
    await at(120, []);
    await at(121, []);
    await at(122, [entry('QCTT_TWR')]);
    expect((await snapshot())!.state!.QCTT_TWR!.seenAfter).toBe(iso(121));
    await at(140, []);
    await at(141, []);
    await at(155, []);
    expect(await rows()).toEqual([]);
    expect(dms).toEqual([]);
  });

  it('A1: a whole-division gap followed by staggered departures sends nothing', async () => {
    const five = [1, 2, 3, 4, 5].map((n) => entry(`QCO${n}_CTR`, 700000 + n, 125.1, 10 + n));
    members = five.map((item) => ({ user: { id: `2000000000000001${item.userId % 100}`.padEnd(18, '0') },
      nick: `Member (${item.userId})`, roles: [ROLE] }));
    await at(0, []);
    await at(1, five);
    await at(60, five);
    await at(61, []);
    await at(62, []);
    await at(63, five);
    for (let n = 1; n <= 6; n++) await at(69 + n, five.slice(n));
    await at(90, []);
    await at(91, []);
    expect(await rows()).toEqual([]);
    expect(dms).toEqual([]);
  });

  it('A1: a genuinely new connection after a gap still gets its reminder', async () => {
    await at(0, []);
    await at(1, [entry('QCTT_TWR')]);
    await at(119, [entry('QCTT_TWR')]);
    await at(120, []);
    await at(121, []);
    await at(122, [entry('QCTT_TWR', VID, 118.1, 2)]);
    await at(140, []);
    await at(141, []);
    await at(150, []);
    expect(await rows()).toMatchObject([{ status: 'sent', seen_after: START + 121 * 60_000 }]);
    expect(dms).toHaveLength(1);
  });

  it('expires a reminder not deliverable within two hours', async () => {
    await shortSession();
    await at(126, []);
    expect(await rows()).toMatchObject([{ status: 'expired' }]);
    expect(dms).toEqual([]);
  });

  it('marks an unmapped member without sending', async () => {
    members = [{ user: { id: MEMBER }, nick: 'Member (699999)', roles: [ROLE] }];
    await shortSession();
    await at(15, []);
    expect(await rows()).toMatchObject([{ status: 'unmapped' }]);
    expect(dms).toEqual([]);
    expect(dmRecipients).toEqual([]);
  });

  it('honours the verified role when it is set', async () => {
    const verified = '100000000000000003';
    await shortSession(5, { GCA_VERIFIED_ROLE_ID: verified });
    await at(15, [], { GCA_VERIFIED_ROLE_ID: verified });
    expect(await rows()).toMatchObject([{ status: 'unmapped' }]);
    expect(dms).toEqual([]);
  });

  it('reserves before the POST and never retries an ambiguous failure', async () => {
    dmFailure = 'timeout';
    await shortSession();
    await at(15, []);
    expect(statusDuringPost).toEqual(['reserved']);
    expect(await rows()).toMatchObject([{ status: 'failed', attempts: 1 }]);
    dmFailure = 'none';
    await at(16, []);
    await at(30, []);
    expect(dms).toHaveLength(1);
  });

  it('a global rate limit stops delivery and widens the shared DM backoff', async () => {
    dmFailure = 'global429';
    await shortSession();
    await at(15, []);
    expect(await rows()).toMatchObject([{ status: 'pending', attempts: 1 }]);
    const backoff = await runInDurableObject(stub(), (_instance, ctx) => ctx.storage.get<number>('gca-discord-backoff-v1'));
    expect(backoff).toBeGreaterThan(now);
    dmFailure = 'none';
    // Still within the two-minute global limit: nothing is attempted.
    await at(16, []);
    expect(dms).toHaveLength(1);
    await at(18, []);
    expect(dms).toHaveLength(2);
    expect(await rows()).toMatchObject([{ status: 'sent', attempts: 2 }]);
  });

  it.each([
    ['disabled', { SHORT_SESSION_DM_ENABLED: 'false' }, false],
    ['an invalid guild', { GCA_DISCORD_GUILD_ID: 'not-a-guild' }, true],
    ['an invalid member role', { GCA_MEMBER_ROLE_ID: '' }, true],
    ['an invalid verified role', { GCA_VERIFIED_ROLE_ID: 'not-a-role' }, true],
  ])('%s never breaks cards and does no work', async (_label, overrides: Partial<Env>, invalid) => {
    await shortSession(5, overrides);
    await at(15, [], overrides);
    expect(calls.filter((call) => call.startsWith('card_'))).toEqual(['card_POST', 'card_PATCH']);
    expect((await snapshot())?.error).toBeUndefined();
    expect(await tables()).not.toContain('short_sessions');
    expect(dms).toEqual([]);
    expect(logged('short_session_config_invalid').length > 0).toBe(invalid);
  });

  it('posts public cards before any DM, and a DM timeout leaves the poll successful', async () => {
    dmFailure = 'timeout';
    await shortSession();
    calls = [];
    await at(15, [entry('QCZZ_CTR', 700001, 125.1, 9)]);
    expect(calls).toEqual(['card_POST', 'dm_open', 'dm_post']);
    expect((await snapshot())?.error).toBeUndefined();
  });

  it('leaves due DMs for a later poll once card delivery used up the DM budget', async () => {
    await shortSession();
    onCardPost = () => { now += 30_000; };
    await at(15, [entry('QCZZ_CTR', 700001, 125.1, 9)]);
    expect(dms).toEqual([]);
    expect(await rows()).toMatchObject([{ status: 'pending', attempts: 0 }]);
    onCardPost = undefined;
    await at(17, [entry('QCZZ_CTR', 700001, 125.1, 9)]);
    expect(dms).toHaveLength(1);
  });

  it('shares one member-list lookup with GCA reminders in a poll', async () => {
    const gca: Partial<Env> = {
      GCA_DM_ENABLED: 'true', GCA_REGIONS: JSON.stringify({ AD: { name: 'Example East', prefixes: ['QC'] } }),
      GCA_APPROVALS: '{}', GCA_HOME_OVERRIDES: JSON.stringify({ 600002: 'AC' }), GCA_COPY_USER_ID: '',
    };
    members = [...members, { user: { id: OTHER_MEMBER }, nick: 'Other (600002)', roles: [ROLE] }];
    await shortSession(5, gca);
    expect(memberListCalls).toBe(0);
    await at(15, [entry('QCGG_APP', 600002, 119.1, 7)], gca);
    expect(memberListCalls).toBe(1);
    expect(dms.map((dm) => dm.embeds[0]!.title)).toEqual([
      expect.stringContaining('GCA approval reminder'), expect.stringContaining('short ATC session'),
    ]);
  });
});

describe('short-session state', () => {
  const atc = (callsign: string, userId = VID): OnlineAtc => ({
    sessionId: 1, userId, callsign, frequency: 118.1, position: callsign.split('_').at(-1)!, station: null, location: null,
  });
  const tracked = (callsign: string, extra: Partial<TrackedAtc> = {}): TrackedAtc => ({
    ...atc(callsign), since: iso(0), missed: 0, ...extra,
  });

  it('stamps new sessions only when the previous poll time is known', () => {
    expect(diffState({}, [atc('QCTT_TWR')], iso(5), 2).next.QCTT_TWR!.seenAfter).toBeUndefined();
    expect(diffState({}, [atc('QCTT_TWR')], iso(5), 2, iso(4)).next.QCTT_TWR!.seenAfter).toBe(iso(4));
  });

  it('inherits the earliest presence of the same VID, or none if any is unknown', () => {
    const prev = {
      QCAA_APP: tracked('QCAA_APP', { seenAfter: iso(-20), missed: 1, missingSince: iso(4) }),
      QCAA_CTR: tracked('QCAA_CTR', { seenAfter: iso(-10) }),
      QCBB_TWR: tracked('QCBB_TWR', { userId: VID + 1, seenAfter: iso(-90) }),
    };
    const current = [atc('QCAA_CTR'), atc('QCBB_TWR', VID + 1), atc('QCAA_TWR')];
    expect(diffState(prev, current, iso(5), 2, iso(4)).next.QCAA_TWR!.seenAfter).toBe(iso(-20));
    const { seenAfter: _unknown, ...legacy } = prev.QCAA_CTR;
    expect(diffState({ ...prev, QCAA_CTR: legacy }, current, iso(5), 2, iso(4)).next.QCAA_TWR!.seenAfter).toBeUndefined();
  });

  it('a callsign taken over by another VID starts a fresh presence', () => {
    const prev = { QCTT_TWR: tracked('QCTT_TWR', { seenAfter: iso(-30) }) };
    expect(diffState(prev, [atc('QCTT_TWR', VID + 1)], iso(5), 2, iso(4)).next.QCTT_TWR!.seenAfter).toBe(iso(4));
  });

  it('loadSessions drops an invalid seenAfter as a field, never the session', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = loadSessions({
      A_TWR: tracked('A_TWR', { seenAfter: iso(-1) }),
      B_TWR: tracked('B_TWR', { seenAfter: 12345 as unknown as string }),
      C_TWR: tracked('C_TWR', { seenAfter: 'not a time' }),
      D_TWR: tracked('D_TWR', { seenAfter: iso(1) }),
      E_TWR: tracked('E_TWR'),
    });
    expect(Object.keys(loaded)).toEqual(['A_TWR', 'B_TWR', 'C_TWR', 'D_TWR', 'E_TWR']);
    expect(Object.values(loaded).map((session) => session.seenAfter)).toEqual([iso(-1), undefined, undefined, undefined, undefined]);
    for (const callsign of ['B_TWR', 'C_TWR', 'D_TWR']) expect(Object.hasOwn(loaded[callsign]!, 'seenAfter')).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('new-format sessions and closeouts pass the unchanged load guards in both directions', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // isTrackedAtc and isPendingOffline are untouched by this change: extra fields are ignored.
    const session = tracked('QCTT_TWR', { seenAfter: iso(-1), firstSessionId: 1 });
    const job: PendingOffline = {
      event: { ...session, missed: 2, missingSince: iso(9), endedAt: iso(9), durationSeconds: 540 },
      messages: [{ channelId: PUBLIC, messageId: '800000000000000001' }], channelIds: [],
    };
    expect(loadSessions({ QCTT_TWR: session })).toEqual({ QCTT_TWR: session });
    expect(loadPendingOffline([job])).toEqual([job]);
    const { seenAfter: _added, ...legacy } = session;
    expect(loadSessions({ QCTT_TWR: legacy })).toEqual({ QCTT_TWR: legacy });
    expect(error).not.toHaveBeenCalled();
  });

  it('trusts only a valid stored poll time that is not in the future', () => {
    expect(trustedStateAt(iso(0), START)).toBe(iso(0));
    expect(trustedStateAt(iso(1), START)).toBeUndefined();
    expect(trustedStateAt('garbage', START)).toBeUndefined();
    expect(trustedStateAt(START, START)).toBeUndefined();
    expect(trustedStateAt(undefined, START)).toBeUndefined();
  });

  it('records stateAt on success and carries it through a failed poll', async () => {
    await at(0, []);
    expect((await snapshot())!.stateAt).toBe(iso(0));
    await at(1, [], { DISCORD_CHANNEL_IDS: '' }).catch(() => undefined);
    expect((await snapshot())).toMatchObject({ stateAt: iso(0), error: expect.any(String) });
    await at(2, [entry('QCTT_TWR')]);
    expect((await snapshot())!.state!.QCTT_TWR!.seenAfter).toBe(iso(0));
  });

  it('a future stored stateAt is not trusted', async () => {
    await seedSnapshot({ state: {}, stateAt: iso(60) });
    await at(0, [entry('QCTT_TWR')]);
    expect((await snapshot())!.state!.QCTT_TWR!.seenAfter).toBeUndefined();
  });

  it('builds a friendly, escaped reminder with a singular minute', () => {
    const embed = buildShortSessionEmbed('QC*X_TWR', 1);
    expect(embed.title).toBe('⏱️ QC\\*X_TWR — short ATC session');
    expect(embed.description).toBe('You were connected as **QC\\*X_TWR** for about 1 minute. IVAO Rules & Regulations ask controllers to connect only when they can stay online for at least 30 minutes. If something came up, no worries — this is just a friendly reminder.');
    expect(embed.footer).toEqual({ text: 'IVAO ATC Monitor' });
  });
});
