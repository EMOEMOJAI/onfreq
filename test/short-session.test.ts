import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COORDINATOR_NAME, IVAO_ATC_SUMMARY_URL, POLL_SNAPSHOT_KEY } from '../src/config';
import { PollCoordinator, type PollSnapshot } from '../src/coordinator';
import type { DiscordEmbed } from '../src/discord';
import { DiscordRateLimits } from '../src/discord-rate-limit';
import {
  buildShortSessionEmbed, reminderMinutes, sendShortSessionReminders, trustedStateAt, type ShortSessionHandoff,
} from '../src/short-session';
import { loadPendingOffline, loadSessions } from '../src/state';
import type { IvaoAtcSummaryEntry, PendingOffline, StateMap, TrackedAtc } from '../src/types';
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
const VERIFIED = '100000000000000003';
const REMINDERS = 'short_session_reminders_v2';
const ONLINE = 'short_session_online';
const RECORDED_KEY = 'short-session-recorded-v1';
const BACKOFF_KEY = 'gca-discord-backoff-v1';
const EXCLUDED = { EXCLUDED_CALLSIGNS: 'QCXX_CTR' };
const OFF = { SHORT_SESSION_DM_ENABLED: 'false' };
/** A set but invalid verified role: the feature logs short_session_config_invalid and stays off. */
const MISCONFIGURED = { GCA_VERIFIED_ROLE_ID: 'not-a-role' };
const PURGE = { SHORT_SESSION_DM_ENABLED: 'purge' };
const stub = () => env.POLL_COORDINATOR.getByName(COORDINATOR_NAME);
/** GCA reminders on, for a synthetic region where VID 600002 is a guest. */
const GCA_ON: Partial<Env> = {
  GCA_DM_ENABLED: 'true', GCA_REGIONS: JSON.stringify({ AD: { name: 'Example East', prefixes: ['QC'] } }),
  GCA_APPROVALS: '{}', GCA_HOME_OVERRIDES: JSON.stringify({ 600002: 'AC' }), GCA_COPY_USER_ID: '',
};
const ms = (minutes: number) => START + minutes * 60_000;
const iso = (minutes: number) => new Date(ms(minutes)).toISOString();
const keyAt = (minutes: number) => `${VID}:${ms(minutes)}`;

type Row = {
  session_key: string; user_id: number; callsign: string; online_since: number; status: string; attempts: number;
  ended_at: number; duration_minutes: number; due_at: number; expires_at: number;
};

let now: number;
let feed: IvaoAtcSummaryEntry[];
let feedStatus: number;
let calls: string[];
let dms: { embeds: DiscordEmbed[]; allowed_mentions?: unknown }[];
let dmRecipients: string[];
let members: unknown[];
let memberListCalls: number;
let dmFailure: 'none' | 'timeout' | 'global429' | 'route429' | 'forbidden' | 'wrong_recipient';
let feedCalls: number;
/** While set, the feed request or the DM message POST waits for it; `held` records that one is waiting. */
let feedGate: Promise<void> | undefined;
let dmGate: Promise<void> | undefined;
let held: string[];
let dmOpenDelayMs: number;
let dmOpenStatus: number[];
let cardStatus: number;
let listStatus: number;
let slowListMs: number;
/** Delay of an otherwise normal member-list response; `listAt` records when that lookup started. */
let listDelayMs: number;
let listAt: number | undefined;
let openAt: number[];
let statusDuringPost: string[];
let stateAtDuringPost: (string | undefined)[];
let activeCtx: DurableObjectState | undefined;
let onCardPost: (() => void) | undefined;
let cardId: number;
let logs: ReturnType<typeof vi.spyOn>[];
/** Errors thrown out of `at()` polls; a scenario that injects a failure sets `injectsFailure`. */
let pollFailures: unknown[];
let injectsFailure: boolean;

function entry(callsign: string, userId = VID, frequency = 118.1, id = 1): IvaoAtcSummaryEntry {
  return {
    id, userId, callsign,
    atcSession: { frequency, position: callsign.split('_').at(-1)! },
    atcPosition: { atcCallsign: 'Example Station' }, subcenter: null,
  };
}

const twr = (id = 1) => entry('QCTT_TWR', VID, 118.1, id);
const app = (id = 2) => entry('QCTT_APP', VID, 119.1, id);
const excludedCtr = (id = 9) => entry('QCXX_CTR', VID, 125.1, id);

function member(vid: number, id = MEMBER, roles = [ROLE, VERIFIED]) {
  return { user: { id }, nick: `Member (${vid})`, roles };
}

function settings(overrides: Partial<Env> = {}): Env {
  return {
    ...env, SHORT_SESSION_DM_ENABLED: 'true', GCA_DM_ENABLED: undefined, GCA_COPY_USER_ID: COPY,
    GCA_VERIFIED_ROLE_ID: VERIFIED, ...overrides,
  } as Env;
}

/** One poll `minutes` after START with the given monitored feed; a thrown failure is collected, never swallowed. */
function at(
  minutes: number, current: IvaoAtcSummaryEntry[], overrides: Partial<Env> = {},
  prepare?: (ctx: DurableObjectState) => void,
) {
  now = ms(minutes);
  feed = current;
  return runInDurableObject(stub(), (_instance, ctx) => {
    activeCtx = ctx;
    prepare?.(ctx);
    return new PollCoordinator(ctx, settings(overrides)).poll();
  }).catch((error: unknown) => { pollFailures.push(error); });
}

/** Polls at each minute in `[from, to]` with `step`, all with the same feed. */
async function during(from: number, to: number, step: number, current: IvaoAtcSummaryEntry[], overrides: Partial<Env> = {}) {
  for (let minute = from; minute <= to; minute += step) await at(minute, current, overrides);
}

/** The next recording transaction fails, as an injected SQL error would. */
const failRecording = (ctx: DurableObjectState) => {
  injectsFailure = true;
  vi.spyOn(ctx.storage, 'transactionSync').mockImplementationOnce(() => { throw new Error('synthetic SQL failure'); });
};

function sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(stub(), (_instance, ctx) => ctx.storage.sql.exec<T>(query, ...bindings).toArray());
}

function storageGet(key: string) {
  return runInDurableObject(stub(), (_instance, ctx) => ctx.storage.get(key));
}

function seedSnapshot(snapshot: PollSnapshot) {
  return runInDurableObject(stub(), (_instance, ctx) => ctx.storage.put(POLL_SNAPSHOT_KEY, snapshot));
}

function snapshot() {
  return runInDurableObject(stub(), (_instance, ctx) => ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY));
}

async function tables(): Promise<string[]> {
  return (await sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"))
    .map((row) => row.name);
}

const shortSessionTables = async () => (await tables()).filter((name) => name.startsWith('short_session'));

async function rows(): Promise<Row[]> {
  return (await tables()).includes(REMINDERS) ? sql<Row>(`SELECT * FROM ${REMINDERS} ORDER BY rowid`) : [];
}

const statuses = async () => (await rows()).map((row) => row.status);

function logged(event: string): Record<string, unknown>[] {
  return logs.flatMap((spy) => spy.mock.calls)
    .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown>; } catch { return {}; } })
    .filter((line) => line.event === event);
}

function shortSessionLogs(): string {
  return JSON.stringify(logs.flatMap((spy) => spy.mock.calls).map(([line]) => String(line))
    .filter((line) => line.includes('short_session')));
}

/**
 * The first recorded poll at minute 0, then a carded TWR session from minute
 * 1 that drops at `endMinute` and closes one poll later: a known start.
 */
async function shortSession(endMinute = 5, overrides: Partial<Env> = {}, others: IvaoAtcSummaryEntry[] = []) {
  await at(0, others, overrides);
  await at(1, [...others, twr()], overrides);
  await at(endMinute, others, overrides);
  await at(endMinute + 1, others, overrides);
}

/** No reminder recorded and no DM sent. */
async function expectNothing({ allowPollFailure = false } = {}) {
  expect(await rows()).toEqual([]);
  expect(dms).toEqual([]);
  // A scenario that recorded nothing must not have done so by failing.
  if (!allowPollFailure && !injectsFailure) {
    expect(logged('short_session_poll_failed')).toEqual([]);
    expect(pollFailures).toEqual([]);
  }
  expect((await snapshot())?.error).toBeUndefined();
}

beforeEach(() => {
  now = START;
  feed = [];
  feedStatus = 200;
  feedCalls = 0;
  feedGate = undefined;
  dmGate = undefined;
  held = [];
  dmOpenDelayMs = 0;
  dmOpenStatus = [];
  cardStatus = 200;
  listStatus = 200;
  slowListMs = 0;
  listDelayMs = 0;
  listAt = undefined;
  openAt = [];
  calls = [];
  dms = [];
  dmRecipients = [];
  members = [member(VID)];
  memberListCalls = 0;
  dmFailure = 'none';
  statusDuringPost = [];
  stateAtDuringPost = [];
  activeCtx = undefined;
  onCardPost = undefined;
  cardId = 0;
  pollFailures = [];
  injectsFailure = false;
  logs = (['log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === IVAO_ATC_SUMMARY_URL) {
      feedCalls++;
      if (feedGate) { held.push('feed'); await feedGate; }
      return Response.json([entry('EGLL_TWR', 1), ...feed], { status: feedStatus });
    }
    if (url.includes('/guilds/') && url.includes('/members?')) {
      memberListCalls++;
      listAt ??= now;
      now += listDelayMs;
      if (listStatus !== 200) return Response.json({ message: 'Missing Access' }, { status: listStatus });
      if (slowListMs) {
        // A full page of synthetic members, slowly: the lookup needs another page.
        now += slowListMs;
        return Response.json(Array.from({ length: 1000 }, (_, n) => member(800000 + n, String(400000000000000000n + BigInt(n)))));
      }
      return Response.json(members);
    }
    if (url.endsWith('/users/@me/channels')) {
      const recipient = (JSON.parse(String(init?.body)) as { recipient_id: string }).recipient_id;
      calls.push('dm_open');
      openAt.push(now);
      dmRecipients.push(recipient);
      now += dmOpenDelayMs;
      const openStatus = dmOpenStatus.shift();
      if (openStatus) return Response.json({ message: 'synthetic failure' }, { status: openStatus });
      const shown = dmFailure === 'wrong_recipient' ? OTHER_MEMBER : recipient;
      return Response.json({ id: DM_CHANNEL, type: 1, recipients: [{ id: shown }] });
    }
    if (url.endsWith(`/channels/${DM_CHANNEL}/messages`)) {
      calls.push('dm_post');
      dms.push(JSON.parse(String(init?.body)));
      if (dmGate) { held.push('dm'); await dmGate; }
      const ctx = activeCtx!;
      stateAtDuringPost.push((await ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY))?.stateAt);
      if (ctx.storage.sql.exec('SELECT 1 FROM sqlite_master WHERE name = ?', REMINDERS).toArray().length) {
        statusDuringPost.push(...ctx.storage.sql.exec<{ status: string }>(
          `SELECT status FROM ${REMINDERS} WHERE status = 'reserved'`).toArray().map((row) => row.status));
      }
      if (dmFailure === 'timeout') throw new Error('Synthetic timeout after Discord may have delivered');
      if (dmFailure === 'global429') return Response.json({ retry_after: 120, global: true }, { status: 429 });
      if (dmFailure === 'route429') return Response.json({ retry_after: 1, global: false }, { status: 429 });
      if (dmFailure === 'forbidden') return Response.json({ message: 'Cannot send messages to this user' }, { status: 403 });
      return Response.json({ id: '300000000000000002' });
    }
    if (url.startsWith(`https://discord.com/api/v10/channels/${PUBLIC}/messages`)) {
      const method = init?.method ?? 'GET';
      calls.push(`card_${method}`);
      if (method === 'POST') onCardPost?.();
      if (method === 'POST' && cardStatus !== 200) return Response.json({ message: 'synthetic rejection' }, { status: cardStatus });
      return Response.json({ id: method === 'POST' ? `80000000000000${String(++cardId).padStart(4, '0')}` : url.split('/').at(-1) });
    }
    throw new Error(`Unexpected request ${url}`);
  }));
});

afterEach(async () => {
  if (!injectsFailure) expect(pollFailures).toEqual([]);
  // A test may leave a due alarm (a webhook hint), which must not fire in the next one.
  await runInDurableObject(stub(), (_instance, ctx) => ctx.storage.deleteAlarm());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

describe('short-session reminders: sending', () => {
  it('sends exactly one DM for a short session after the first recorded poll, without GCA and with no staff copy', async () => {
    await shortSession(16);
    expect(await rows()).toMatchObject([{
      session_key: keyAt(0), user_id: VID, callsign: 'QCTT_TWR', online_since: START, status: 'pending',
      duration_minutes: 16, ended_at: ms(16), due_at: ms(26), expires_at: ms(136),
    }]);
    await at(25, []);
    expect(dms).toEqual([]);
    await at(26, []);
    await at(27, []);
    await at(40, []);
    expect(dms).toHaveLength(1);
    expect(dms[0]).toEqual({ embeds: [buildShortSessionEmbed('QCTT_TWR', 16)], allowed_mentions: { parse: [] } });
    expect(dms[0]!.embeds[0]!.description).toContain('for about 16 minutes');
    expect(dmRecipients).toEqual([MEMBER]);
    expect(memberListCalls).toBe(1);
    // Finished rows keep no callsign column.
    expect(await rows()).toMatchObject([{ status: 'sent', callsign: '', attempts: 1 }]);
    expect((await tables()).filter((name) => name.startsWith('gca_'))).toEqual([]);
    expect(logged('short_session_poll_failed')).toEqual([]);
    expect(logged('short_session_dm_sent')).toHaveLength(1);
    const lines = shortSessionLogs();
    for (const privateValue of [String(VID), MEMBER, COPY, 'QCTT']) expect(lines).not.toContain(privateValue);
    expect(JSON.stringify(dms)).not.toContain(String(VID));
  });

  it('a member already online at the first recorded poll has an unknown start', async () => {
    await at(0, [twr()]);
    await at(5, []);
    await at(6, []);
    await at(20, []);
    await expectNothing();
    expect(logged('short_session_baseline')).toEqual([{ event: 'short_session_baseline', online: 1 }]);
  });

  it('a 10 + 8 minute switch sends one reminder for the combined presence', async () => {
    await at(0, []);
    await at(1, [twr()]);
    await at(11, [app()]);
    await at(12, [app()]);
    await at(19, []);
    await at(20, []);
    await at(29, []);
    expect(await statuses()).toEqual(['sent']);
    expect(dms.map((dm) => dm.embeds[0]!.description)).toEqual([expect.stringContaining('**QCTT_APP** for about 19 minutes')]);
  });

  it('a merged presence that ends short later sends one reminder for all of it', async () => {
    await at(0, []);
    await at(1, [twr()]);
    await at(9, []);
    await at(10, []);
    expect(await rows()).toMatchObject([{ ended_at: ms(9), due_at: ms(19) }]);
    await at(12, [app()]);
    await at(17, [app()]);
    await at(18, []);
    await at(19, []);
    expect(await rows()).toMatchObject([{ status: 'pending', ended_at: ms(18), due_at: ms(28), callsign: 'QCTT_APP' }]);
    await at(28, []);
    expect(await statuses()).toEqual(['sent']);
    expect(dms.map((dm) => dm.embeds[0]!.description)).toEqual([expect.stringContaining('for about 18 minutes')]);
  });

  it('excluded presence that clearly ended more than 10 minutes earlier does not join a later short TWR session', async () => {
    await at(-122, [], EXCLUDED);
    await during(-120, 0, 2, [excludedCtr()], EXCLUDED);
    await during(1, 14, 1, [], EXCLUDED);
    await at(15, [twr(2)], EXCLUDED);
    await at(20, [twr(2)], EXCLUDED);
    await at(21, [], EXCLUDED);
    await at(22, [], EXCLUDED);
    await at(31, [], EXCLUDED);
    expect(await rows()).toMatchObject([{ online_since: ms(14), status: 'sent' }]);
    expect(dms).toHaveLength(1);
  });

  it('P3-3: shows the whole minutes of the bound', async () => {
    await at(0, []);
    await at(5, [twr()]);
    await at(15.8, []);
    await at(16.8, []);
    expect(await rows()).toMatchObject([{ duration_minutes: 15 }]);
  });

  it.each([
    [28.9, 1], [29.2, 0],
  ])('F3: a bound of %s minutes is reported only with a one-minute margin (%s rows)', async (end, expected) => {
    await at(0, []);
    await at(1, [twr()]);
    await at(end, []);
    await at(end + 1, []);
    expect(await rows()).toHaveLength(expected);
  });
});

describe('short-session reminders: presence regressions send nothing', () => {
  it('TWR for 25 minutes, then APP for 9, then leaving', async () => {
    await at(0, []);
    await at(1, [twr()]);
    await at(25, [app()]);
    await at(26, [app()]);
    await at(30, [app()]);
    await at(34, []);
    await at(35, []);
    await at(45, []);
    await expectNothing();
  });

  it.each([2, 3])('a switch with a %s-poll gap is one presence', async (gap) => {
    await at(0, []);
    await at(1, [twr()]);
    await at(20, [twr()]);
    await during(21, 20 + gap, 1, []);
    const back = 21 + gap;
    await at(back, [app()]);
    await at(back + 6, []);
    await at(back + 7, []);
    await at(back + 20, []);
    expect(await statuses()).toEqual(['reconnected']);
    expect(dms).toEqual([]);
  });

  it('a feed gap within one IVAO connection', async () => {
    await at(0, []);
    await at(1, [twr()]);
    await at(119, [twr()]);
    await at(120, []);
    await at(121, []);
    await at(122, [twr()]);
    await at(140, []);
    await at(141, []);
    await at(155, []);
    await expectNothing();
  });

  it('a whole-division empty feed followed by staggered departures', async () => {
    const five = [1, 2, 3, 4, 5].map((n) => entry(`QCO${n}_CTR`, 700000 + n, 125.1, 10 + n));
    members = five.map((item) => member(item.userId, `2000000000000001${item.userId % 100}`.padEnd(18, '0')));
    await at(0, []);
    await at(1, five);
    await at(60, five);
    await at(61, []);
    await at(62, []);
    await at(63, five);
    for (let n = 1; n <= 6; n++) await at(69 + n, five.slice(n));
    await at(90, []);
    await at(91, []);
    await expectNothing();
  });

  it('the member is missing from the feed on the due poll but was back online in between', async () => {
    await at(0, []);
    await at(1, [twr()]);
    await at(25, []);
    await at(26, []);
    expect(await rows()).toMatchObject([{ status: 'pending', due_at: ms(35) }]);
    await at(28, [app()]);
    await at(30, [app()]);
    await at(35, []);
    await at(36, [app()]);
    await at(40, [app()]);
    await at(45, []);
    await at(46, []);
    await at(60, []);
    expect(await statuses()).toEqual(['reconnected']);
    expect(dms).toEqual([]);
  });

  it('K4: 100 minutes at an excluded position, then 9 at TWR', async () => {
    await at(0, [], EXCLUDED);
    await during(1, 96, 5, [excludedCtr(1)], EXCLUDED);
    await at(100, [twr(2)], EXCLUDED);
    await at(105, [twr(2)], EXCLUDED);
    await at(109, [], EXCLUDED);
    await at(110, [], EXCLUDED);
    await at(125, [], EXCLUDED);
    await expectNothing();
  });

  it.each([
    ['V1: enabled after a TWR session closed while off', OFF, false],
    ['V2: re-enabled after a TWR session closed under purge', PURGE, false],
    ['PR2: valid again after a TWR session closed while misconfigured', MISCONFIGURED, true],
  ])('%s', async (_label, gap: Partial<Env>, invalid) => {
    await at(0, []);
    await at(1, [twr()]);
    await at(60, [twr()]);
    await at(61, [], gap);
    await at(62, [], gap);
    expect(logged('short_session_config_invalid').length > 0).toBe(invalid);
    await at(63, [app()]);
    await at(70, [app()]);
    await at(71, []);
    await at(72, []);
    await at(85, []);
    await expectNothing();
  });

  it('V3: a connection split by a feed gap while off, seen again on the first enabled poll', async () => {
    await at(0, [], OFF);
    await at(1, [twr()], OFF);
    await at(120, [twr()], OFF);
    await at(121, [], OFF);
    await at(122, [], OFF);
    await at(123, [twr()]);
    await at(141, []);
    await at(142, []);
    await at(155, []);
    await expectNothing();
  });

  it.each([
    ['PR1: off', OFF, false],
    ['PR2: misconfigured', MISCONFIGURED, true],
    ['control: on throughout', {}, false],
  ])('%s while at an excluded position, then a short TWR session soon after', async (_label, gap: Partial<Env>, invalid) => {
    const between = { ...EXCLUDED, ...gap };
    await at(-400, [], EXCLUDED);
    await at(-300, [], EXCLUDED);
    await at(-299, [], between);
    await at(0, [], between);
    await during(1, 96, 5, [excludedCtr(1)], between);
    await at(100, [], between);
    expect(logged('short_session_config_invalid').length > 0).toBe(invalid);
    await at(101, [twr(2)], EXCLUDED);
    await at(106, [twr(2)], EXCLUDED);
    await at(107, [], EXCLUDED);
    await at(108, [], EXCLUDED);
    await at(120, [], EXCLUDED);
    await expectNothing();
  });

  it.each([
    ['a feed outage after presence at an excluded position', excludedCtr(1), 'outage'],
    ['a 12-minute gap without polls after presence at an excluded position', excludedCtr(1), 'gap'],
    ['control: a feed outage after presence at a tracked position', app(1), 'outage'],
  ])('%s', async (_label, earlier, kind) => {
    await at(-122, [], EXCLUDED);
    await during(-120, 0, 2, [earlier], EXCLUDED);
    if (kind === 'outage') {
      feedStatus = 503;
      injectsFailure = true;
      await during(1, 14, 1, [], EXCLUDED);
      feedStatus = 200;
    }
    const from = kind === 'outage' ? 15 : 12;
    await at(from, [twr(2)], EXCLUDED);
    await at(from + 5, [twr(2)], EXCLUDED);
    await at(from + 6, [], EXCLUDED);
    await at(from + 7, [], EXCLUDED);
    await at(45, [], EXCLUDED);
    await expectNothing();
  });

  it('H1: TWR 1–60, excluded 61–72, TWR 73–78, then leaving', async () => {
    await at(0, [], EXCLUDED);
    await during(1, 60, 5, [twr(1)], EXCLUDED);
    await during(61, 72, 1, [excludedCtr(2)], EXCLUDED);
    await at(73, [twr(3)], EXCLUDED);
    await at(78, [twr(3)], EXCLUDED);
    await at(79, [], EXCLUDED);
    await at(80, [], EXCLUDED);
    await at(95, [], EXCLUDED);
    await expectNothing();
  });

  it('H2: excluded −120..0, TWR 1–30, excluded 31–42, TWR 43–48, then leaving', async () => {
    await at(-122, [], EXCLUDED);
    await during(-120, 0, 4, [excludedCtr(1)], EXCLUDED);
    await during(1, 30, 5, [twr(2)], EXCLUDED);
    await during(31, 42, 1, [excludedCtr(3)], EXCLUDED);
    await at(43, [twr(4)], EXCLUDED);
    await at(48, [twr(4)], EXCLUDED);
    await at(49, [], EXCLUDED);
    await at(50, [], EXCLUDED);
    await at(65, [], EXCLUDED);
    await expectNothing();
  });

  it('F9: an untrusted stored stateAt starts a fresh baseline', async () => {
    await at(-10, []);
    // The stored poll time is later than the recorded last poll start.
    await seedSnapshot({ state: {}, stateAt: iso(-10), lastPollStartedAt: ms(-11) });
    await at(0, [twr()]);
    await at(5, []);
    await at(6, []);
    await at(20, []);
    await expectNothing();
    expect(logged('short_session_baseline')).toHaveLength(2);
  });

  it('an unsaved poll (recorded, snapshot not saved) starts a fresh baseline', async () => {
    await at(0, []);
    await runInDurableObject(stub(), (_instance, ctx) => ctx.storage.put(RECORDED_KEY, ms(0.5)));
    await at(1, [twr()]);
    await at(5, []);
    await at(6, []);
    await at(20, []);
    await expectNothing();
  });

  it('plan review: TWR for an hour, an outage of over 10 minutes, one recorded poll elsewhere, then leaving', async () => {
    await at(0, []);
    await during(1, 60, 5, [twr()]);
    feedStatus = 503;
    injectsFailure = true;
    await during(61, 72, 1, []);
    feedStatus = 200;
    await at(73, [app()]);
    await at(74, []);
    await at(75, []);
    await at(90, []);
    await expectNothing();
  });

  it('F1: a blip at the last recorded poll, then an outage of over 10 minutes, does not split the presence (grace 1)', async () => {
    const grace = { OFFLINE_GRACE_POLLS: '1' };
    await at(-60, [], grace);
    await during(-59, -1, 2, [twr()], grace);
    await at(0, [], grace);
    feedStatus = 503;
    injectsFailure = true;
    await during(1, 11, 1, [], grace);
    feedStatus = 200;
    await at(12, [twr()], grace);
    await at(19, [twr()], grace);
    await at(20, [], grace);
    await at(35, [], grace);
    await expectNothing();
  });

  it('F2: members reappearing together after a 200 OK feed dropped most of them have unknown starts', async () => {
    const five = [1, 2, 3, 4, 5].map((n) => entry(`QCO${n}_CTR`, 700000 + n, 125.1, 10 + n));
    members = five.map((item) => member(item.userId, `2000000000000001${item.userId % 100}`.padEnd(18, '0')));
    await at(-61, []);
    await at(-60, five.slice(0, 1));
    await at(-59, five.slice(0, 2));
    await at(-58, five.slice(0, 3));
    await at(-57, five.slice(0, 4));
    await at(-56, five);
    await at(0, five);
    await during(1, 15, 2, five.slice(0, 1));
    await at(16, five);
    expect(logged('short_session_mass_reappearance')).toEqual([{ event: 'short_session_mass_reappearance', count: 4 }]);
    await at(20, five.slice(0, 4));
    await at(21, five.slice(0, 4));
    await at(35, five.slice(0, 4));
    await expectNothing();
  });

  it('NX-1a: the same IVAO session returning after a gap over 10 minutes keeps its presence', async () => {
    const other = entry('QCZZ_APP', 600002, 119.1, 7);
    await at(0, [other]);
    await at(1, [twr(1), other]);
    await at(60, [twr(1), other]);
    await during(61, 75, 2, [other]);
    await at(76, [twr(1), other]);
    await at(86, [other]);
    await at(87, [other]);
    await at(100, [other]);
    await expectNothing();
  });

  it('NX-1a: the same gap with a new IVAO session id is a reconnect and still sends a reminder', async () => {
    const other = entry('QCZZ_APP', 600002, 119.1, 7);
    await at(0, [other]);
    await at(1, [twr(1), other]);
    await at(60, [twr(1), other]);
    await during(61, 75, 2, [other]);
    await at(76, [twr(2), other]);
    await at(86, [other]);
    await at(87, [other]);
    await at(100, [other]);
    expect(await rows()).toMatchObject([{ session_key: `${VID}:${ms(75)}`, status: 'sent', duration_minutes: 11 }]);
  });

  it('NX-1a: a continuing member stores the newest session id present in this poll, even a lower one', async () => {
    await at(0, []);
    await at(1, [twr(5), app(9)]);
    expect(await sql(`SELECT user_id, session_id FROM ${ONLINE}`)).toEqual([{ user_id: VID, session_id: 9 }]);
    await at(2, [twr(5)]);
    expect(await sql(`SELECT user_id, session_id FROM ${ONLINE}`)).toEqual([{ user_id: VID, session_id: 5 }]);
    // Nothing valid now: the stored id stays.
    await at(3, [twr(0)]);
    expect(await sql(`SELECT user_id, session_id FROM ${ONLINE}`)).toEqual([{ user_id: VID, session_id: 5 }]);
  });

  it('NX-1a: after the higher session ends, the surviving session id still matches a return after a long gap', async () => {
    const other = entry('QCZZ_APP', 600002, 119.1, 7);
    await at(0, [other]);
    await at(1, [twr(5), app(9), other]);
    await at(30, [twr(5), app(9), other]);
    await at(31, [twr(5), other]);
    await during(32, 46, 2, [other]);
    await at(47, [twr(5), other]);
    await at(62, [other]);
    await at(63, [other]);
    await at(80, [other]);
    await expectNothing();
  });

  it('NX-1a: a failing schema upgrade fails the poll once, sends nothing, and the next poll baselines', async () => {
    await at(0, []);
    await at(1, [twr()]);
    await at(5, [twr()], {}, (ctx) => {
      injectsFailure = true;
      const exec = ctx.storage.sql.exec.bind(ctx.storage.sql) as (query: string, ...bindings: unknown[]) => unknown;
      let failed = false;
      vi.spyOn(ctx.storage.sql, 'exec').mockImplementation(((query: string, ...bindings: unknown[]) => {
        if (!failed && query.includes('pragma_table_info')) { failed = true; throw new Error('synthetic pragma failure'); }
        return exec(query, ...bindings);
      }) as never);
    });
    expect(logged('short_session_poll_failed')).toHaveLength(1);
    await at(6, []);
    await at(7, []);
    await at(25, []);
    await expectNothing({ allowPollFailure: true });
    expect(logged('short_session_baseline')).toHaveLength(2);
  });

  it('NX-1a: a migrated row with a NULL session id after a gap over 10 minutes is a new presence', async () => {
    const other = entry('QCZZ_APP', 600002, 119.1, 7);
    await at(0, [other]);
    await at(1, [twr(1), other]);
    await at(60, [twr(1), other]);
    await sql(`UPDATE ${ONLINE} SET session_id = NULL`);
    await during(61, 75, 2, [other]);
    await at(76, [twr(1), other]);
    await at(86, [other]);
    await at(87, [other]);
    await at(100, [other]);
    expect(await rows()).toMatchObject([{ session_key: `${VID}:${ms(75)}`, status: 'sent', duration_minutes: 11 }]);
  });

  it('NX-1a: adds session_id in place to an online table of the earlier shape, keeping its rows', async () => {
    await at(0, []);
    await at(1, [twr(4)]);
    await sql(`ALTER TABLE ${ONLINE} DROP COLUMN session_id`);
    expect(await sql(`SELECT 1 FROM pragma_table_info('${ONLINE}') WHERE name = 'session_id'`)).toEqual([]);
    await at(2, [twr(4)]);
    expect(await sql(`SELECT user_id, online_since, missing_since, session_id FROM ${ONLINE}`))
      .toEqual([{ user_id: VID, online_since: ms(0), missing_since: null, session_id: 4 }]);
    await at(6, []);
    await at(7, []);
    expect(await rows()).toMatchObject([{ session_key: keyAt(0), duration_minutes: 6 }]);
  });

  it('NX-1a: a returning division keeps same-session presences but still counts as a mass reappearance', async () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => entry(`QCO${n}_CTR`, 700000 + n, 125.1, 10 + n));
    members = six.map((item) => member(item.userId, `2000000000000001${item.userId % 100}`.padEnd(18, '0')));
    await at(-61, []);
    await at(-60, six.slice(0, 1));
    await at(-59, six.slice(0, 2));
    await at(-58, six.slice(0, 3));
    await at(-57, six.slice(0, 4));
    await at(-56, six.slice(0, 5));
    await at(-55, six);
    await at(0, six);
    await during(1, 15, 2, six.slice(0, 2));
    // Three come back as the same connections, one on a new session id.
    const back = [...six.slice(0, 5), { ...six[5]!, id: 99 }];
    await at(16, back);
    expect(logged('short_session_mass_reappearance')).toEqual([{ event: 'short_session_mass_reappearance', count: 4 }]);
    expect(await sql(`SELECT user_id, online_since IS NULL AS unknown FROM ${ONLINE} ORDER BY user_id`)).toEqual([
      { user_id: 700001, unknown: 0 }, { user_id: 700002, unknown: 0 }, { user_id: 700003, unknown: 0 },
      { user_id: 700004, unknown: 0 }, { user_id: 700005, unknown: 0 }, { user_id: 700006, unknown: 1 },
    ]);
    await at(26, back.slice(0, 5));
    await at(27, back.slice(0, 5));
    await at(40, back.slice(0, 5));
    await expectNothing();
  });

  it('F3: a member hidden by a duplicate callsign is still online', async () => {
    await at(0, []);
    await at(1, [twr(1)]);
    await at(10, [twr(1), entry('QCTT_TWR', 600002, 118.1, 2)]);
    await at(11, [twr(1), entry('QCTT_TWR', 600002, 118.1, 2)]);
    await during(15, 30, 5, [twr(1), entry('QCTT_TWR', 600002, 118.1, 2)]);
    await expectNothing();
  });

  it('F5: no delivery in a poll whose recording failed, though its snapshot and closeout card were saved', async () => {
    const other = entry('QCZZ_CTR', 700001, 125.1, 9);
    await at(0, []);
    await at(1, [twr(), other]);
    await at(5, [other]);
    await at(6, [other]);
    await at(14, []);
    calls = [];
    await at(15, [], {}, failRecording);
    // The other controller's closeout card still posts in the failing poll.
    expect(calls).toEqual(['card_PATCH']);
    expect((await snapshot())!.stateAt).toBe(iso(15));
    expect(dms).toEqual([]);
    expect(logged('short_session_skipped')).toContainEqual({ event: 'short_session_skipped', reason: 'unrecorded_poll' });
    expect(await storageGet(RECORDED_KEY)).toBeUndefined();
  });

  it('a SQL failure in the record update makes the next poll start a fresh baseline', async () => {
    await at(0, []);
    await at(1, [twr()]);
    await at(5, [twr()], {}, failRecording);
    await at(6, [twr()]);
    await at(10, []);
    await at(11, []);
    await at(25, []);
    await expectNothing({ allowPollFailure: true });
    expect(logged('short_session_baseline')).toHaveLength(2);
  });

  it.each([
    ['an excluded callsign', entry('QCTT_GND'), { EXCLUDED_CALLSIGNS: 'QCTT_GND' }],
    ['a special position', entry('QCTT_X_GND'), {}],
    ['0.000 MHz', entry('QCTT_GND', VID, 0), {}],
  ])('a reconnect at %s counts as back online', async (_label, reconnect, overrides: Partial<Env>) => {
    await shortSession(5, overrides);
    await at(15, [reconnect], overrides);
    expect(await statuses()).toEqual(['reconnected']);
    expect(dms).toEqual([]);
  });

  it.each([
    ['more than ten sessions end', 11, 0],
    ['most tracked sessions end', 3, 2],
  ])('records nothing when %s in one poll', async (_label, ending: number, staying: number) => {
    const session = (n: number): TrackedAtc => ({
      sessionId: n + 1, userId: VID + n, callsign: `QCT${String.fromCharCode(65 + n)}_TWR`, frequency: 118.1,
      position: 'TWR', station: null, location: null, since: iso(-10), missed: 0,
      messages: [{ channelId: PUBLIC, messageId: `80000000000001${String(n).padStart(4, '0')}` }],
    });
    const all = Array.from({ length: ending + staying }, (_, n) => session(n));
    const state: StateMap = Object.fromEntries(all.map((s) => [s.callsign, s]));
    const kept = all.slice(ending).map((s) => entry(s.callsign, s.userId, 118.1, s.sessionId));
    await seedSnapshot({ state, stateAt: iso(-1), lastPollStartedAt: ms(-1) });
    await at(0, kept);
    await at(1, kept);
    expect(await rows()).toEqual([]);
    expect(logged('short_session_anomaly')).toEqual([{ event: 'short_session_anomaly', ended: ending, tracked: ending + staying }]);
  });
});

describe('short-session reminders: delivery', () => {
  it('a feed much smaller than the tracked state defers delivery', async () => {
    const others = [1, 2, 3, 4].map((n) => entry(`QCO${n}_CTR`, 700000 + n, 125.1, 10 + n));
    await shortSession(5, {}, others);
    await at(15, others.slice(0, 1));
    expect(await statuses()).toEqual(['pending']);
    expect(dms).toEqual([]);
    await at(16, others);
    expect(dms).toHaveLength(1);
  });

  it.each([
    ['sent', false, true], ['reserved', false, true], ['failed', true, true], ['failed', false, false],
    ['baseline', false, false], ['unmapped', false, false],
  ])('a GCA reminder %s (occurrence kept: %s) during this presence suppresses: %s', async (status, occurrence, suppressed) => {
    await seedGca((db) => {
      db.exec('INSERT INTO gca_reminders (session_key, status, last_seen) VALUES (?, ?, ?)', `${VID}:1`, status, START);
      // GCA keeps a failed reminder's occurrence only when it was possibly delivered.
      if (occurrence) db.exec('INSERT INTO gca_occurrences (session_key, user_id, occurrence) VALUES (?, ?, 1)', `${VID}:1`, VID);
    });
    await shortSession();
    await at(15, []);
    expect(await statuses()).toEqual([suppressed ? 'skipped_gca' : 'sent']);
    expect(dms).toHaveLength(suppressed ? 0 : 1);
  });

  it('F4: a GCA reminder to the member during this presence suppresses, an earlier one does not', async () => {
    await seedGca((db) => {
      db.exec('INSERT INTO gca_reminders (session_key, status, last_seen) VALUES (?, ?, ?)', `${VID}:999`, 'sent', ms(3));
      db.exec('INSERT INTO gca_reminders (session_key, status, last_seen) VALUES (?, ?, ?)', `${VID + 10}:1`, 'sent', ms(3));
    });
    await shortSession();
    await at(15, []);
    expect(await statuses()).toEqual(['skipped_gca']);
    await reset();
    dms = [];
    await seedGca((db) => db.exec('INSERT INTO gca_reminders (session_key, status, last_seen) VALUES (?, ?, ?)',
      `${VID}:999`, 'sent', ms(-1)));
    await shortSession();
    await at(15, []);
    expect(await statuses()).toEqual(['sent']);
    expect(dms).toHaveLength(1);
  });

  it('sends at most one reminder per member per 24 hours', async () => {
    await shortSession();
    await at(15, []);
    await at(20, [entry('QCTT_GND', VID, 121.9, 2)]);
    await at(25, []);
    await at(26, []);
    await at(35, []);
    expect(await statuses()).toEqual(['sent', 'skipped_daily']);
    expect(dms).toHaveLength(1);
  });

  it('F1: an ambiguous failure counts towards the daily cap', async () => {
    dmFailure = 'timeout';
    await shortSession();
    await at(15, []);
    expect(dms).toHaveLength(1);
    expect(await statuses()).toEqual(['failed']);
    dmFailure = 'none';
    await at(70, []);
    await at(71, [entry('QCTT_GND', VID, 121.9, 2)]);
    await at(75, []);
    await at(76, []);
    await at(85, []);
    expect(await statuses()).toEqual(['failed', 'skipped_daily']);
    expect(dms).toHaveLength(1);
  });

  it.each([
    ['a 403 on the message POST', 'forbidden'],
    ['an unexpected DM recipient before any POST', 'wrong_recipient'],
  ] as const)('P4-1: %s is rejected and does not count towards the daily cap', async (_label, failure) => {
    dmFailure = failure;
    await shortSession();
    await at(15, []);
    expect(await rows()).toMatchObject([{ status: 'rejected', attempts: 1 }]);
    dmFailure = 'none';
    await at(70, []);
    await at(71, [entry('QCTT_GND', VID, 121.9, 2)]);
    await at(75, []);
    await at(76, []);
    await at(85, []);
    expect(await statuses()).toEqual(['rejected', 'sent']);
  });

  it('F1: keeps 24 hours between actual sends when the first was delivered late', async () => {
    await shortSession();
    // Delivered late: the last poll before the online record is pruned an hour after the presence ended.
    await at(65, []);
    expect(dms).toHaveLength(1);
    // Ended more than 24 h after the first session, but due under 24 h after its DM.
    await at(1465, []);
    await at(1466, [entry('QCTT_GND', VID, 121.9, 2)]);
    await at(1470, []);
    await at(1471, []);
    await at(1480, []);
    expect(dms).toHaveLength(1);
    // Past 24 h plus the expiry window after the first session ended.
    await at(1585, []);
    await at(1586, [entry('QCTT_DEL', VID, 121.7, 3)]);
    await at(1590, []);
    await at(1591, []);
    await at(1600, []);
    expect(await statuses()).toEqual(['sent', 'skipped_daily', 'sent']);
    expect(dms).toHaveLength(2);
  });

  it('a reminder whose online record was pruned an hour after the presence ended counts as reconnected', async () => {
    await shortSession();
    await at(66, []);
    expect(await statuses()).toEqual(['reconnected']);
    expect(dms).toEqual([]);
  });

  it('expires a reminder not deliverable within two hours', async () => {
    await shortSession();
    await at(126, []);
    expect(await rows()).toMatchObject([{ status: 'expired', callsign: '' }]);
    expect(dms).toEqual([]);
  });

  it('F6: an expired reserved row loses its callsign but still counts towards the daily cap', async () => {
    await shortSession();
    await sql(`UPDATE ${REMINDERS} SET status = 'reserved'`);
    await at(130, []);
    expect(await rows()).toMatchObject([{ session_key: keyAt(0), status: 'reserved', callsign: '' }]);
    await at(131, [entry('QCTT_GND', VID, 121.9, 2)]);
    await at(135, []);
    await at(136, []);
    await at(145, []);
    expect(await statuses()).toEqual(['reserved', 'skipped_daily']);
    expect(dms).toEqual([]);
  });

  it('marks an unmapped member without sending', async () => {
    members = [member(699999)];
    await shortSession();
    await at(15, []);
    expect(await statuses()).toEqual(['unmapped']);
    expect(dms).toEqual([]);
    expect(dmRecipients).toEqual([]);
  });

  it('F7: without a verified role, the member role and nickname VID are enough, as for GCA', async () => {
    members = [member(VID, MEMBER, [ROLE])];
    await shortSession(5, { GCA_VERIFIED_ROLE_ID: '' });
    await at(15, [], { GCA_VERIFIED_ROLE_ID: '' });
    expect(logged('short_session_config_invalid')).toEqual([]);
    expect(await statuses()).toEqual(['sent']);
    expect(dmRecipients).toEqual([MEMBER]);
  });

  it('F7: with a verified role set, a member without it is not trusted', async () => {
    members = [member(VID, MEMBER, [ROLE])];
    await shortSession();
    await at(15, []);
    expect(await statuses()).toEqual(['unmapped']);
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
    expect(await storageGet(BACKOFF_KEY)).toBeGreaterThan(now);
    dmFailure = 'none';
    // Still within the two-minute global limit: nothing is attempted.
    await at(16, []);
    expect(dms).toHaveLength(1);
    await at(18, []);
    expect(dms).toHaveLength(2);
    expect(await rows()).toMatchObject([{ status: 'sent', attempts: 2 }]);
  });

  it.each([
    ['disabled', OFF, false],
    ['an invalid guild', { GCA_DISCORD_GUILD_ID: 'not-a-guild' }, true],
    ['an invalid member role', { GCA_MEMBER_ROLE_ID: '' }, true],
    ['F7: a set but invalid verified role', MISCONFIGURED, true],
  ])('%s never breaks cards and does no work', async (_label, overrides: Partial<Env>, invalid) => {
    await shortSession(5, overrides);
    await at(15, [], overrides);
    expect(calls.filter((call) => call.startsWith('card_'))).toEqual(['card_POST', 'card_PATCH']);
    expect((await snapshot())?.error).toBeUndefined();
    expect(await shortSessionTables()).toEqual([]);
    expect(await storageGet(RECORDED_KEY)).toBeUndefined();
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

  it('K5: saves the poll snapshot before any DM, and slow cards do not use up the DM budget', async () => {
    await shortSession();
    onCardPost = () => { now += 30_000; };
    await at(15, [entry('QCZZ_CTR', 700001, 125.1, 9)]);
    expect(dms).toHaveLength(1);
    expect(stateAtDuringPost).toEqual([iso(15)]);
    expect(Object.keys((await snapshot())!)).not.toContain('shortSession');
  });

  it('F2: never starts its own member-list lookup with under 10 seconds of budget', async () => {
    await shortSession();
    now = ms(15);
    const page = Array.from({ length: 1000 }, (_, n) => member(VID + n, String(300000000000000000n + BigInt(n))));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (!url.includes('/members?')) throw new Error(`Unexpected request ${url}`);
      // Counts lookups started (first pages); the list has a second page.
      if (url.includes('after=0')) memberListCalls++;
      // Each page is slow: the first one alone uses six seconds.
      now += 6_000;
      return Response.json(url.includes('after=0') ? page : []);
    }));
    // Delivery for the poll at minute 15, when the reminder is due.
    const deliver = (budget: number) => runInDurableObject(stub(), async (_instance, ctx) => {
      await ctx.storage.put(RECORDED_KEY, ms(15));
      const handoff: ShortSessionHandoff = {
        config: { memberRoleId: ROLE, verifiedRoleId: VERIFIED }, limits: await DiscordRateLimits.load(ctx.storage),
        stateAtMs: ms(15), presentVids: [], trackedBefore: 0, current: 0,
        memberCache: { fetched: false, members: null }, gcaAttempted: false,
      };
      await sendShortSessionReminders(settings(), ctx.storage, handoff, Date.now() + budget);
    });
    await deliver(5_000);
    await deliver(5_000);
    expect(memberListCalls).toBe(0);
    expect(await statuses()).toEqual(['pending']);
    expect([await storageGet('gca-member-list-backoff-v1'), await storageGet('gca-member-list-deadline-failures-v1')])
      .toEqual([undefined, undefined]);
    // Control: with a full budget the same delivery does start one lookup.
    await deliver(15_000);
    expect(memberListCalls).toBe(1);
  });

  it('V5: short-session lookups that run out of budget never trip the GCA member-list backoff', async () => {
    await shortSession();
    const page = Array.from({ length: 1000 }, (_, n) => member(VID + 1 + n));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === IVAO_ATC_SUMMARY_URL) return Response.json([entry('EGLL_TWR', 1), ...feed]);
      if (!url.includes('/members?')) throw new Error(`Unexpected request ${url} ${init?.method}`);
      memberListCalls++;
      now += 6_000;
      // Over 2,000 members, six seconds a page: never complete within 15 seconds.
      const after = BigInt(new URL(url).searchParams.get('after')!);
      const first = after === 0n ? 300000000000000000n : after + 1n;
      return Response.json(page.map((item, n) => ({ ...item, user: { id: String(first + BigInt(n)) } })));
    }));
    await at(15, []);
    await at(16, []);
    const lookups = memberListCalls;
    await at(17, []);
    expect(memberListCalls).toBe(lookups);
    expect([await storageGet('gca-member-list-backoff-v1'), await storageGet('gca-member-list-deadline-failures-v1')])
      .toEqual([undefined, undefined]);
    expect(await statuses()).toEqual(['pending']);
    expect(logged('gca_member_list_failed')).toEqual(Array(2).fill(
      { event: 'gca_member_list_failed', reason: 'deadline', status: 'unavailable', counted: false }));
  });

  const gca = GCA_ON;

  it('F5: skips sending in a poll where GCA sent a DM, then sends on the next poll', async () => {
    members = [...members, member(600002, OTHER_MEMBER)];
    await shortSession(5, gca);
    await at(15, [entry('QCGG_APP', 600002, 119.1, 7)], gca);
    expect(dms.map((dm) => dm.embeds[0]!.title)).toEqual([expect.stringContaining('GCA approval reminder')]);
    expect(await statuses()).toEqual(['pending']);
    await at(16, [entry('QCGG_APP', 600002, 119.1, 7)], gca);
    expect(dms.map((dm) => dm.embeds[0]!.title)).toEqual([
      expect.stringContaining('GCA approval reminder'), expect.stringContaining('short ATC session'),
    ]);
  });

  it('shares one member-list lookup with GCA reminders in a poll', async () => {
    // GCA looks the list up for an unmapped member, so it sends nothing itself.
    await shortSession(5, gca);
    expect(memberListCalls).toBe(0);
    await at(15, [entry('QCGG_APP', 600002, 119.1, 7)], gca);
    expect(memberListCalls).toBe(1);
    expect(dms.map((dm) => dm.embeds[0]!.title)).toEqual([expect.stringContaining('short ATC session')]);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Runs `scenario` on one coordinator instance at minute `minutes`, so concurrent triggers share its in-flight poll. */
function withCoordinator<T>(
  minutes: number, current: IvaoAtcSummaryEntry[], scenario: (coordinator: PollCoordinator, ctx: DurableObjectState) => Promise<T>,
  overrides: Partial<Env> = {},
): Promise<T> {
  now = ms(minutes);
  feed = current;
  return runInDurableObject(stub(), (_instance, ctx) => {
    activeCtx = ctx;
    return scenario(new PollCoordinator(ctx, settings(overrides)), ctx);
  });
}

describe('ROT-1: the coordinator around the DM step', () => {
  it.each([
    ['runs when the throttle allows', 60_000, { skipped: false }, 2],
    ['is throttled otherwise', 0, { skipped: true }, 1],
  ])('a trigger joining during the DM step of a saved poll %s', async (_label, wait, second, feeds) => {
    await shortSession();
    const before = feedCalls;
    const hold = deferred();
    dmGate = hold.promise;
    const results = await withCoordinator(15, [], async (coordinator) => {
      const first = coordinator.poll();
      await vi.waitFor(() => expect(held).toEqual(['dm']));
      dmGate = undefined;
      const joined = coordinator.poll();
      now += wait;
      hold.resolve();
      return Promise.all([first, joined]);
    });
    expect(results).toEqual([{ skipped: false }, second]);
    expect(feedCalls - before).toBe(feeds);
  });

  it('a trigger joining a failing in-flight poll rejects with the same error', async () => {
    await at(0, []);
    const hold = deferred();
    feedGate = hold.promise;
    feedStatus = 503;
    injectsFailure = true;
    const results = await withCoordinator(5, [], async (coordinator) => {
      const first = coordinator.poll().catch((err: Error) => err.message);
      await vi.waitFor(() => expect(held).toEqual(['feed']));
      const joined = coordinator.poll().catch((err: Error) => err.message);
      hold.resolve();
      return Promise.all([first, joined]);
    });
    expect(results).toEqual(['IVAO API responded with 503', 'IVAO API responded with 503']);
  });

  it('a trigger joining during the DM step of a poll saved with a delivery error rejects with that error', async () => {
    await shortSession();
    cardStatus = 400;
    const hold = deferred();
    dmGate = hold.promise;
    const before = feedCalls;
    const results = await withCoordinator(15, [entry('QCZZ_CTR', 700001, 125.1, 9)], async (coordinator) => {
      const first = coordinator.poll().catch((err: Error) => err.message);
      await vi.waitFor(() => expect(held).toEqual(['dm']));
      dmGate = undefined;
      const joined = coordinator.poll().catch((err: Error) => err.message);
      now += 60_000;
      hold.resolve();
      return Promise.all([first, joined]);
    });
    expect(results).toEqual(['all Discord notifications failed', 'all Discord notifications failed']);
    expect(feedCalls - before).toBe(1);
  });

  it('a webhook hint is dropped before the in-flight poll saves, but schedules an early poll during its DM step', async () => {
    await shortSession();
    const feedHold = deferred();
    const dmHold = deferred();
    feedGate = feedHold.promise;
    dmGate = dmHold.promise;
    const [beforeSave, duringDm, alarm] = await withCoordinator(15, [], async (coordinator, ctx) => {
      const first = coordinator.poll();
      await vi.waitFor(() => expect(held).toEqual(['feed']));
      const dropped = await coordinator.requestEarlyPoll();
      feedGate = undefined;
      feedHold.resolve();
      await vi.waitFor(() => expect(held).toEqual(['feed', 'dm']));
      const scheduled = await coordinator.requestEarlyPoll();
      const stored = await ctx.storage.getAlarm();
      dmGate = undefined;
      dmHold.resolve();
      await first;
      return [dropped, scheduled, stored];
    });
    expect(beforeSave).toBeNull();
    expect(duringDm).toEqual(expect.any(Number));
    // Workerd moves an alarm already due on its real clock to now, so only its presence is compared.
    expect(alarm).toEqual(expect.any(Number));
  });

  it('a throw from short-session delivery is logged, leaving the poll result and snapshot intact', async () => {
    await shortSession();
    const result = await withCoordinator(15, [], (coordinator, ctx) => {
      const get = ctx.storage.get.bind(ctx.storage) as (key: string) => Promise<unknown>;
      let reads = 0;
      // The second read of the continuity key is delivery's.
      vi.spyOn(ctx.storage, 'get').mockImplementation((async (key: string) => {
        if (key === RECORDED_KEY && ++reads === 2) throw new TypeError('synthetic delivery failure');
        return get(key);
      }) as never);
      return coordinator.poll();
    });
    expect(result).toEqual({ skipped: false });
    expect(await snapshot()).toMatchObject({ stateAt: iso(15) });
    expect((await snapshot())?.error).toBeUndefined();
    expect(logged('short_session_poll_failed')).toEqual([{ event: 'short_session_poll_failed', error: 'TypeError' }]);
    expect(dms).toEqual([]);
  });

  it('history cleanup during a held DM POST reports busy', async () => {
    await shortSession();
    const hold = deferred();
    dmGate = hold.promise;
    const busy = await withCoordinator(15, [], async (coordinator) => {
      const first = coordinator.poll();
      await vi.waitFor(() => expect(held).toEqual(['dm']));
      const during = coordinator.cleanupGcaHistory(false);
      dmGate = undefined;
      hold.resolve();
      await first;
      return during;
    });
    expect(busy).toEqual({ busy: true });
  });
});

describe('ROT-1: delivery limits', () => {
  it.each([
    ['a 403', 403, 0, 'gca-member-list-backoff-v1'],
    ['its deadline', 200, 30_000, 'gca-member-list-deadline-failures-v1'],
  ])('when GCA\'s member lookup fails with %s, short-session makes no second lookup', async (_label, status, slow, key) => {
    members = [...members, member(600002, OTHER_MEMBER)];
    await shortSession(5, GCA_ON);
    listStatus = status;
    slowListMs = slow;
    const puts: unknown[] = [];
    await at(15, [entry('QCGG_APP', 600002, 119.1, 7)], GCA_ON, (ctx) => {
      const put = ctx.storage.put.bind(ctx.storage) as (...args: unknown[]) => Promise<void>;
      vi.spyOn(ctx.storage, 'put').mockImplementation(((...args: unknown[]) => {
        puts.push(args[0]);
        return put(...args);
      }) as never);
    });
    expect(memberListCalls).toBe(1);
    expect(puts.filter((put) => put === key)).toHaveLength(1);
    expect(puts.filter((put) => typeof put === 'string' && put.startsWith('gca-member-list') && put !== key)).toEqual([]);
    expect(await statuses()).toEqual(['pending']);
    expect(dms).toEqual([]);
  });

  it('a route-limited 429 leaves the reminder pending without the shared backoff, then sends', async () => {
    dmFailure = 'route429';
    await shortSession();
    await at(15, []);
    expect(await rows()).toMatchObject([{ status: 'pending', attempts: 1 }]);
    expect(await storageGet(BACKOFF_KEY)).toBeUndefined();
    dmFailure = 'none';
    await at(16, []);
    expect(await rows()).toMatchObject([{ status: 'sent', attempts: 2 }]);
  });

  it('five route-limited 429s reject the reminder, and a later one is still sent', async () => {
    dmFailure = 'route429';
    await shortSession();
    await during(15, 19, 1, []);
    expect(await rows()).toMatchObject([{ status: 'rejected', attempts: 5 }]);
    dmFailure = 'none';
    await at(70, []);
    await at(71, [entry('QCTT_GND', VID, 121.9, 2)]);
    await at(75, []);
    await at(76, []);
    await at(85, []);
    expect(await statuses()).toEqual(['rejected', 'sent']);
  });

  it('sends at most three reminders per poll', async () => {
    const stayers = [1, 2, 3, 4].map((n) => entry(`QCS${n}_CTR`, 700000 + n, 125.1, 20 + n));
    const leavers = [1, 2, 3, 4].map((n) => entry(`QCL${n}_TWR`, 610000 + n, 118.1, 30 + n));
    members = leavers.map((item, n) => member(item.userId, String(500000000000000000n + BigInt(n))));
    await at(0, stayers);
    for (let n = 1; n <= 4; n++) await at(n, [...stayers, ...leavers.slice(0, n)]);
    await at(10, stayers);
    await at(11, stayers);
    expect(await statuses()).toEqual(Array(4).fill('pending'));
    await at(20, stayers);
    expect(dms).toHaveLength(3);
    await at(21, stayers);
    expect(dms).toHaveLength(4);
    expect(await statuses()).toEqual(Array(4).fill('sent'));
  });

  it('does not POST when opening the DM leaves under 10 seconds of budget', async () => {
    dmOpenDelayMs = 6_000;
    await shortSession();
    await at(15, []);
    expect(calls).toContain('dm_open');
    expect(calls).not.toContain('dm_post');
    expect(await rows()).toMatchObject([{ status: 'pending', attempts: 0 }]);
  });

  it.each([
    [0, true], [4, true], [7, false],
  ])('after a member lookup taking %s s, a DM open starts only with 10 s of budget left (opened: %s)', async (seconds, opened) => {
    listDelayMs = seconds * 1000;
    await shortSession();
    await at(15, []);
    // Delivery starts its 15 s budget just before the lookup.
    for (const at of openAt) expect(at - listAt!).toBeLessThanOrEqual(5_000);
    expect(calls.includes('dm_open')).toBe(opened);
    expect(await statuses()).toEqual([opened ? 'sent' : 'pending']);
    expect(await rows()).toMatchObject([{ attempts: opened ? 1 : 0 }]);
  });

  it('retries after a failed DM open', async () => {
    dmOpenStatus = [500];
    await shortSession();
    await at(15, []);
    expect(await rows()).toMatchObject([{ status: 'pending', attempts: 1 }]);
    expect(dms).toEqual([]);
    await at(16, []);
    expect(await rows()).toMatchObject([{ status: 'sent', attempts: 2 }]);
  });

  it('never revives a sent reminder when the same presence later ends short again', async () => {
    await at(0, []);
    await at(1, [twr()]);
    await at(5, []);
    await at(6, []);
    await sql(`UPDATE ${REMINDERS} SET status = 'sent'`);
    await at(8, [app()]);
    await at(12, []);
    await at(13, []);
    await at(25, []);
    expect(await rows()).toMatchObject([{ status: 'sent', ended_at: ms(5) }]);
    expect(dms).toEqual([]);
  });

  it('more than ten new members in one poll have unknown starts, even when they are a minority', async () => {
    const stayers = Array.from({ length: 12 }, (_, n) => entry(`QCS${String.fromCharCode(65 + n)}_CTR`, 700100 + n, 125.1, 100 + n));
    const arrivals = Array.from({ length: 11 }, (_, n) => entry(`QCN${String.fromCharCode(65 + n)}_TWR`, 620001 + n, 118.1, 200 + n));
    await at(0, stayers);
    await at(1, [...stayers, ...arrivals]);
    expect(logged('short_session_mass_reappearance')).toEqual([{ event: 'short_session_mass_reappearance', count: 11 }]);
    await at(5, [...stayers, ...arrivals.slice(1)]);
    await at(6, [...stayers, ...arrivals.slice(1)]);
    await at(20, [...stayers, ...arrivals.slice(1)]);
    await expectNothing();
  });

  it('due and expiry follow the poll time, not the clock after slow cards', async () => {
    await shortSession();
    onCardPost = () => { now += 60_000; };
    await at(14.9, [entry('QCZZ_CTR', 700001, 125.1, 9)]);
    expect(dms).toEqual([]);
    expect(await statuses()).toEqual(['pending']);
  });
});

describe('short-session storage', () => {
  it('enabling then disabling keeps no online records and no continuity key, but reminders still expire', async () => {
    await shortSession();
    await sql(`INSERT INTO ${REMINDERS} (session_key, user_id, callsign, online_since, ended_at, duration_minutes,
      status, due_at, expires_at) VALUES ('old', 1, 'X', 0, ?, 1, 'sent', 0, 0)`, ms(-8 * 1440));
    expect(await shortSessionTables()).toEqual([ONLINE, REMINDERS]);
    expect(await storageGet(RECORDED_KEY)).toBe(ms(6));
    await runInDurableObject(stub(), (_instance, ctx) => ctx.storage.put('short-session-member-list-v1', { failures: 1 }));
    await at(20, [twr(2)], OFF);
    expect(await shortSessionTables()).toEqual([REMINDERS]);
    expect(await storageGet(RECORDED_KEY)).toBeUndefined();
    expect(await storageGet('short-session-member-list-v1')).toBeUndefined();
    expect((await rows()).map((row) => row.session_key)).toEqual([keyAt(0)]);
    expect(dms).toEqual([]);
  });

  it('purge drops every short-session table and key, leaves the shared GCA backoff, and sends nothing', async () => {
    await shortSession();
    await runInDurableObject(stub(), async (_instance, ctx) => {
      for (const table of ['short_session_reminders', 'short_session_segments', 'short_session_presence', 'short_sessions']) {
        ctx.storage.sql.exec(`CREATE TABLE ${table} (id INTEGER)`);
      }
      await ctx.storage.put({
        'short-session-presence-poll-v1': 1, 'short-session-recording-v1': 1, 'short-session-member-list-v1': {},
        [BACKOFF_KEY]: ms(1),
      });
    });
    await at(15, [], PURGE);
    await at(16, [], PURGE);
    expect(await shortSessionTables()).toEqual([]);
    const keys = await runInDurableObject(stub(), async (_instance, ctx) => Object.fromEntries(await ctx.storage.get([
      RECORDED_KEY, 'short-session-presence-poll-v1', 'short-session-recording-v1', 'short-session-member-list-v1',
      BACKOFF_KEY,
    ])));
    expect(keys).toEqual({ [BACKOFF_KEY]: ms(1) });
    expect(logged('short_session_purged')).toEqual([
      { event: 'short_session_purged', tables: 6 }, { event: 'short_session_purged', tables: 0 },
    ]);
    expect(dms).toEqual([]);
  });

  it('drops tables of earlier designs on a recorded poll; older code still runs its own schema', async () => {
    // The d2c84ca schema, verbatim.
    const legacySchema = (db: SqlStorage) => {
      db.exec(`CREATE TABLE IF NOT EXISTS short_sessions (
        session_key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, callsign TEXT NOT NULL, session_ids TEXT NOT NULL,
        ended_at INTEGER NOT NULL, seen_after INTEGER NOT NULL, duration_minutes INTEGER NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
        due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS short_sessions_due_idx ON short_sessions (status, due_at)');
      db.exec('CREATE INDEX IF NOT EXISTS short_sessions_user_idx ON short_sessions (user_id, ended_at)');
      db.exec(`CREATE TABLE IF NOT EXISTS short_session_segments (
        user_id INTEGER NOT NULL, session_id INTEGER NOT NULL, seen_after INTEGER, ended_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, session_id, ended_at)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS short_session_segments_ended_idx ON short_session_segments (ended_at)');
    };
    await runInDurableObject(stub(), async (_instance, ctx) => {
      legacySchema(ctx.storage.sql);
      ctx.storage.sql.exec('CREATE TABLE short_session_reminders (session_key TEXT PRIMARY KEY)');
      ctx.storage.sql.exec('CREATE TABLE short_session_presence (user_id INTEGER PRIMARY KEY)');
      await ctx.storage.put({ 'short-session-presence-poll-v1': 1, 'short-session-recording-v1': { since: 1, last: 1 } });
    });
    await at(0, []);
    expect(await shortSessionTables()).toEqual([ONLINE, REMINDERS]);
    expect(await storageGet('short-session-recording-v1')).toBeUndefined();
    expect(await storageGet('short-session-presence-poll-v1')).toBeUndefined();
    // Rollback: d2c84ca's own schema still applies beside the new tables.
    await runInDurableObject(stub(), (_instance, ctx) => legacySchema(ctx.storage.sql));
    expect(await shortSessionTables()).toEqual([ONLINE, REMINDERS, 'short_session_segments', 'short_sessions']);
  });

  it('P4-4: indexes reminders by end time', async () => {
    await at(0, []);
    const indexes = (await sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")).map((row) => row.name);
    expect(indexes).toContain(`${REMINDERS}_ended_idx`);
  });

  it('records stateAt on success and carries it through a failed poll', async () => {
    await at(0, []);
    expect((await snapshot())!.stateAt).toBe(iso(0));
    injectsFailure = true;
    await at(1, [], { DISCORD_CHANNEL_IDS: '' });
    expect((await snapshot())).toMatchObject({ stateAt: iso(0), error: expect.any(String) });
    await at(2, [twr()]);
    await at(6, []);
    await at(7, []);
    expect(await rows()).toMatchObject([{ online_since: ms(0) }]);
  });

  it('an older snapshot with seenAfter sessions loads and saves without it', async () => {
    const legacy = {
      sessionId: 1, userId: VID, callsign: 'QCTT_TWR', frequency: 118.1, position: 'TWR', station: null,
      location: null, since: iso(-5), missed: 0, seenAfter: iso(-6),
      messages: [{ channelId: PUBLIC, messageId: '800000000000009999' }],
    } as TrackedAtc;
    await seedSnapshot({ state: { QCTT_TWR: legacy }, stateAt: iso(-1), lastPollStartedAt: ms(-1) });
    await at(0, [twr()]);
    expect((await snapshot())!.state!.QCTT_TWR).toMatchObject({ since: iso(-5), missed: 0 });
    expect(Object.hasOwn((await snapshot())!.state!.QCTT_TWR!, 'seenAfter')).toBe(false);
  });
});

describe('short-session units', () => {
  const tracked = (callsign: string, extra: Partial<TrackedAtc> = {}): TrackedAtc => ({
    sessionId: 1, userId: VID, callsign, frequency: 118.1, position: callsign.split('_').at(-1)!, station: null,
    location: null, since: iso(0), missed: 0, ...extra,
  });

  it('loadSessions and loadPendingOffline strip a leftover seenAfter, never the entry', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const withSeenAfter = { ...tracked('QCTT_TWR', { firstSessionId: 1 }), seenAfter: iso(-1) } as TrackedAtc;
    const job = {
      event: { ...withSeenAfter, missed: 2, missingSince: iso(9), endedAt: iso(9), durationSeconds: 540 },
      messages: [{ channelId: PUBLIC, messageId: '800000000000000001' }], channelIds: [],
    } as PendingOffline;
    expect(loadSessions({ QCTT_TWR: withSeenAfter })).toEqual({ QCTT_TWR: tracked('QCTT_TWR', { firstSessionId: 1 }) });
    const [loaded] = loadPendingOffline([job]);
    expect(Object.hasOwn(loaded!.event, 'seenAfter')).toBe(false);
    expect(loadSessions({ QCTT_TWR: tracked('QCTT_TWR') })).toEqual({ QCTT_TWR: tracked('QCTT_TWR') });
    expect(error).not.toHaveBeenCalled();
  });

  it('F9: trusts a stored poll time only within the last poll start and after every stored session time', () => {
    const sessions = { A: tracked('A_TWR', { since: iso(-10), missingSince: iso(-1) }) };
    expect(trustedStateAt(iso(0), START, START, sessions)).toBe(iso(0));
    expect(trustedStateAt(iso(0), START, ms(-1), sessions)).toBeUndefined();
    expect(trustedStateAt(iso(0), START, undefined, sessions)).toBeUndefined();
    expect(trustedStateAt(iso(-2), START, START, sessions)).toBeUndefined();
    expect(trustedStateAt(iso(-5), START, START, { A: tracked('A_TWR', { since: iso(-4) }) })).toBeUndefined();
    expect(trustedStateAt(iso(1), START, ms(1), {})).toBeUndefined();
    expect(trustedStateAt('garbage', START, START, {})).toBeUndefined();
    expect(trustedStateAt(START, START, START, {})).toBeUndefined();
  });

  it('P3-3: whole minutes of the bound, from 1 to 29', () => {
    expect([0, 59_999, 60_000, 15.9 * 60_000, 29.9 * 60_000, 45 * 60_000].map(reminderMinutes)).toEqual([1, 1, 1, 15, 29, 29]);
  });

  it('builds a friendly, escaped reminder with a singular minute', () => {
    const embed = buildShortSessionEmbed('QC*X_TWR', 1);
    expect(embed.title).toBe('⏱️ QC\\*X_TWR — short ATC session');
    expect(embed.description).toBe('You were connected as **QC\\*X_TWR** for about 1 minute. IVAO Rules & Regulations ask controllers to connect only when they can stay online for at least 30 minutes. If something came up, no worries — this is just a friendly reminder.');
    expect(embed.footer).toEqual({ text: 'IVAO ATC Monitor' });
  });
});
