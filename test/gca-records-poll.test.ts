import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IVAO_ATC_SUMMARY_URL, POLL_SNAPSHOT_KEY } from '../src/config';
import { PollCoordinator, type PollSnapshot } from '../src/coordinator';
import type { DiscordEmbed } from '../src/discord';
import { writeGcaRecords, type GcaSignedRequest } from '../src/gca-records';
import { resetTokenCache } from '../src/ivao';
import type { IvaoAtcSummaryEntry } from '../src/types';

const START = Date.parse('2026-01-01T00:00:00Z');
const DAY = 86_400_000;
const PUBLIC_CHANNEL = '900000000000000001';
const DM_CHANNEL = '300000000000000001';
const MEMBER_ROLE = '100000000000000002';
const stub = () => env.POLL_COORDINATOR.getByName('gca-records-poll-tests');
// Fictional coverage from test/gca.test.ts; AC is referenced only by records.
const REGIONS = { AC: { name: 'Example West', prefixes: ['XC'] }, AD: { name: 'Example East', prefixes: ['XD'] } };
const VID = 100001;
const OTHER = 100002;
/** The secrets approve VID for AD APP, so any stored record that does not is observable. */
const SECRETS_APPROVE = JSON.stringify({ [VID]: [{ region: 'AD', level: 2 }] });

const config = (overrides: Partial<Env> = {}): Env => ({
  ...env, IVAO_CLIENT_ID: 'test-client', IVAO_CLIENT_SECRET: 'test-secret', DISCORD_CHANNEL_IDS: PUBLIC_CHANNEL,
  FIR_PREFIXES: 'XD', GCA_DM_ENABLED: 'true', GCA_MEMBER_ROLE_ID: MEMBER_ROLE, GCA_REGIONS: JSON.stringify(REGIONS),
  GCA_APPROVALS: SECRETS_APPROVE, GCA_HOME_OVERRIDES: '', ...overrides,
});

let now: number;
let feed: IvaoAtcSummaryEntry[];
let cards: { method: string; title: string }[];
let dms: DiscordEmbed[];
let onMemberList: (() => Promise<void>) | undefined;
let onCardPost: (() => void) | undefined;
let messageNumber: number;

function entry(callsign: string, userId: number, id: number): IvaoAtcSummaryEntry {
  return {
    id, userId, callsign, atcSession: { frequency: 124.2, position: 'APP' },
    atcPosition: { atcCallsign: 'Example Station', airport: { icao: callsign.slice(0, 4), countryId: 'AD' } }, subcenter: null,
  } as IvaoAtcSummaryEntry;
}

let pollCtx: DurableObjectState | undefined;
function poll(overrides: Partial<Env> = {}) {
  return runInDurableObject(stub(), (_instance, ctx) => {
    pollCtx = ctx;
    return new PollCoordinator(ctx, config(overrides)).poll();
  });
}

function signedPut(body: object): GcaSignedRequest {
  return {
    method: 'PUT', path: '/gca/records', keyId: '839683debc9ccbd0', ts: now, nonce: crypto.randomUUID(),
    bodyBytes: new TextEncoder().encode(JSON.stringify(body)),
  };
}

/** Publish through the coordinator's write RPC, returning the new version. */
async function publish(approvals: object, baseVersion: string | null, overrides: Partial<Env> = {}): Promise<string> {
  const result = await runInDurableObject(stub(), (_instance, ctx) =>
    new PollCoordinator(ctx, config(overrides)).gcaRecordsWrite(signedPut({
      approvals, homeOverrides: {}, baseVersion, ...(Object.keys(approvals).length ? {} : { confirmEmpty: true }),
    })));
  if (!result.ok) throw new Error(`publish refused: ${result.error}`);
  return result.version;
}

const meta = (overrides: Partial<Env> = {}) => runInDurableObject(stub(), (_instance, ctx) =>
  new PollCoordinator(ctx, config(overrides)).gcaRecordsMeta());
const snapshot = () => runInDurableObject(stub(), (_instance, ctx) => ctx.storage.get<PollSnapshot>(POLL_SNAPSHOT_KEY));
const lastTitle = () => cards.at(-1)?.title ?? '';
/** The first card posted for a callsign. */
const postedTitle = (callsign: string) => cards.find((card) => card.method === 'POST' && card.title.includes(callsign))?.title ?? '';
const logLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([line]) => String(line)).join('\n');

/** Baseline poll, then the controller connects. */
async function connect(overrides: Partial<Env> = {}, callsign = 'XDAA_APP', id = 999) {
  feed = [entry(callsign, VID, id)];
  now += 60_000;
  return poll(overrides);
}

beforeEach(() => {
  resetTokenCache();
  now = START;
  feed = [];
  cards = [];
  dms = [];
  onMemberList = undefined;
  onCardPost = undefined;
  messageNumber = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === 'https://api.ivao.aero/v2/oauth/token') return Response.json({ access_token: 'test-ivao-token', expires_in: 1800 });
    if (url.startsWith('https://api.ivao.aero/v2/users/')) return Response.json({ countryId: 'US' });
    // An unmonitored controller distinguishes zero regional coverage from a feed outage.
    if (url === IVAO_ATC_SUMMARY_URL) return Response.json([entry('JZZZ_TWR', 100, 1), ...feed]);
    if (url.includes('/guilds/') && url.includes('/members?')) {
      await onMemberList?.();
      return Response.json([VID, OTHER].map((vid, i) => ({
        user: { id: `20000000000000000${i + 1}` }, nick: `Member (${vid})`, roles: [MEMBER_ROLE],
      })));
    }
    if (url.endsWith('/users/@me/channels')) {
      const recipient = JSON.parse(String(init?.body)) as { recipient_id: string };
      return Response.json({ id: DM_CHANNEL, type: 1, recipients: [{ id: recipient.recipient_id }] });
    }
    if (url.endsWith(`/channels/${DM_CHANNEL}/messages`)) {
      dms.push((JSON.parse(String(init?.body)) as { embeds: DiscordEmbed[] }).embeds[0]!);
      return Response.json({ id: '300000000000000002' });
    }
    if (url.startsWith(`https://discord.com/api/v10/channels/${PUBLIC_CHANNEL}/messages`)) {
      const method = init?.method ?? 'GET';
      if (method === 'POST') onCardPost?.();
      const payload = JSON.parse(String(init?.body)) as { embeds: DiscordEmbed[] };
      cards.push({ method, title: payload.embeds[0]!.title ?? '' });
      messageNumber += 1;
      return Response.json({ id: method === 'POST' ? `80000000000000${String(messageNumber).padStart(4, '0')}` : url.split('/').at(-1) });
    }
    throw new Error(`Unexpected network request: ${url}`);
  }));
});

afterEach(async () => {
  resetTokenCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

describe('stored GCA records in the poll', () => {
  it('control: with no stored record the secrets approve the controller (no reminder, no marker)', async () => {
    await poll();
    await connect();
    expect(dms).toHaveLength(0);
    expect(lastTitle()).toMatch(/^🟢 .*XDAA_APP is now ONLINE/);
    expect(await meta()).toMatchObject({ source: 'secrets', version: null });
  });

  it('a stored record overrides the secrets for both the reminder and the public marker', async () => {
    await poll();
    await publish({ [OTHER]: [{ region: 'AC', level: 3 }] }, null);
    await connect();
    expect(dms).toHaveLength(1);
    expect(lastTitle()).toMatch(/^🔴 .*XDAA_APP is now ONLINE/);
  });

  it('a stored approval also overrides secrets that would warn', async () => {
    await poll({ GCA_APPROVALS: '{}' });
    await publish({ [VID]: [{ region: 'AD', level: 3 }] }, null);
    await connect({ GCA_APPROVALS: '{}' });
    expect(dms).toHaveLength(0);
    expect(lastTitle()).toMatch(/^🟢 /);
  });

  it('a corrupt stored row turns reminders and the marker off with no fallback; public cards still post', async () => {
    // The secrets approve nobody: a fallback to them would warn and mark.
    const secrets = { GCA_APPROVALS: '{}' };
    await poll(secrets);
    await publish({ [OTHER]: [{ region: 'AD', level: 3 }] }, null, secrets);
    await runInDurableObject(stub(), (_instance, ctx) => {
      ctx.storage.sql.exec(`UPDATE gca_records_current SET approvals_json = '{"${OTHER}":[{"level":3,"region":"AD"}],"${VID}":'`);
    });
    const error = vi.spyOn(console, 'error');
    await expect(connect(secrets)).resolves.toEqual({ skipped: false });
    expect(dms).toHaveLength(0);
    expect(cards.filter((card) => card.method === 'POST')).toHaveLength(1);
    expect(lastTitle()).toMatch(/^🟢 .*XDAA_APP is now ONLINE/);
    const saved = await snapshot();
    expect(saved?.error).toBeUndefined();
    expect(JSON.stringify(saved?.error ?? '')).not.toContain(String(VID));
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'gca_config_invalid', reason: 'records' }));
    expect(logLines(error)).not.toMatch(new RegExp(`${VID}|${OTHER}`));
    expect(await meta(secrets)).toMatchObject({ source: 'invalid', version: '1' });
  });

  it('a region removed later turns GCA off and meta "invalid"; a republish restores it', async () => {
    const adOnly = { GCA_REGIONS: JSON.stringify({ AD: REGIONS.AD }) };
    await poll();
    const version = await publish({ [OTHER]: [{ region: 'AC', level: 3 }] }, null);
    await connect(adOnly);
    expect(dms).toHaveLength(0);
    expect(lastTitle()).toMatch(/^🟢 /);
    expect(await meta(adOnly)).toMatchObject({ source: 'invalid', version, counts: { approvals: 0, homeOverrides: 0 } });
    // Publishing is checked against the current regions too.
    await expect(publish({ [OTHER]: [{ region: 'AC', level: 3 }] }, version, adOnly)).rejects.toThrow('invalid_records');
    const restored = await publish({ [OTHER]: [{ region: 'AD', level: 3 }] }, version, adOnly);
    expect(await meta(adOnly)).toMatchObject({ source: 'durable-object', version: restored });
    feed = [entry('XDBB_APP', VID, 1000)];
    now += 60_000;
    await poll(adOnly);
    expect(dms).toHaveLength(1);
    expect(postedTitle('XDBB_APP')).toMatch(/^🔴 .*XDBB_APP is now ONLINE/);
  });

  it('a publish during a poll applies only from the next poll', async () => {
    await poll();
    const first = await publish({}, null);
    let published: string | undefined;
    onMemberList = async () => {
      if (published) return;
      // Mid-poll, after the policy was loaded: approve the controller.
      const result = await writeGcaRecords(pollCtx!.storage, config(),
        signedPut({ approvals: { [VID]: [{ region: 'AD', level: 3 }] }, homeOverrides: {}, baseVersion: first }));
      published = result.ok ? result.version : result.error;
    };
    await connect();
    expect(published).toBe('2');
    expect(dms).toHaveLength(1);
    expect(lastTitle()).toMatch(/^🔴 .*XDAA_APP/);
    feed = [entry('XDBB_APP', VID, 1000)];
    now += 60_000;
    await poll();
    expect(dms).toHaveLength(1);
    expect(postedTitle('XDBB_APP')).toMatch(/^🟢 .*XDBB_APP is now ONLINE/);
  });

  it('C4: a signed write on the live instance while its poll is in flight applies only from the next poll', async () => {
    await poll();
    const first = await publish({}, null);
    let published: string | undefined;
    await runInDurableObject(stub(), async (_instance, ctx) => {
      pollCtx = ctx;
      const live = new PollCoordinator(ctx, config());
      onMemberList = async () => {
        if (published) return;
        // Mid-poll, after the policy was loaded: approve the controller through the live instance.
        const result = await live.gcaRecordsWrite(signedPut({
          approvals: { [VID]: [{ region: 'AD', level: 3 }] }, homeOverrides: {}, baseVersion: first,
        }));
        published = result.ok ? result.version : result.error;
      };
      feed = [entry('XDAA_APP', VID, 999)];
      now += 60_000;
      await expect(live.poll()).resolves.toEqual({ skipped: false });
    });
    expect(published).toBe('2');
    expect(dms).toHaveLength(1);
    expect(lastTitle()).toMatch(/^🔴 .*XDAA_APP/);
    expect(await meta()).toMatchObject({ source: 'durable-object', version: '2' });
    feed = [entry('XDBB_APP', VID, 1000)];
    now += 60_000;
    await poll();
    expect(dms).toHaveLength(1);
    expect(postedTitle('XDBB_APP')).toMatch(/^🟢 .*XDBB_APP is now ONLINE/);
  });

  it('C4: an operator delete on the live instance while its poll is in flight applies only from the next poll', async () => {
    // The secrets would warn; the stored record approves the controller.
    const secrets = { GCA_APPROVALS: '{}' };
    await poll(secrets);
    await publish({ [VID]: [{ region: 'AD', level: 3 }] }, null, secrets);
    let deleted: unknown;
    await runInDurableObject(stub(), async (_instance, ctx) => {
      pollCtx = ctx;
      const live = new PollCoordinator(ctx, config(secrets));
      // Mid-poll, after the policy was loaded (the card carries its marker).
      onCardPost = () => { deleted ??= live.gcaRecordsOperatorDelete(); };
      feed = [entry('XDAA_APP', VID, 999)];
      now += 60_000;
      await expect(live.poll()).resolves.toEqual({ skipped: false });
    });
    expect(deleted).toEqual({ ok: true, deleted: 1, history: 1 });
    // This poll kept the deleted record's approval.
    expect(dms).toHaveLength(0);
    expect(lastTitle()).toMatch(/^🟢 .*XDAA_APP/);
    expect(await meta(secrets)).toMatchObject({ source: 'secrets', version: null });
    // The next poll uses the secrets, which warn.
    feed = [entry('XDBB_APP', VID, 1000)];
    now += 60_000;
    await poll(secrets);
    expect(dms).toHaveLength(1);
    expect(postedTitle('XDBB_APP')).toMatch(/^🔴 .*XDBB_APP is now ONLINE/);
  });

  it.each(['false', '', 'TRUE'])('with GCA_DM_ENABLED=%j a stored record drives neither reminders nor the marker', async (enabled) => {
    const off = { GCA_DM_ENABLED: enabled, GCA_APPROVALS: '{}' };
    await poll({ GCA_APPROVALS: '{}' });
    await publish({ [OTHER]: [{ region: 'AD', level: 3 }] }, null);
    await connect(off);
    expect(dms).toHaveLength(0);
    expect(lastTitle()).toMatch(/^🟢 .*XDAA_APP is now ONLINE/);
    // Positive control: the same record with reminders enabled warns a new connection.
    feed = [entry('XDBB_APP', VID, 1000)];
    now += 60_000;
    await poll({ GCA_APPROVALS: '{}' });
    expect(dms).toHaveLength(1);
    expect(postedTitle('XDBB_APP')).toMatch(/^🔴 /);
  });

  it('drops a 31-day-old history row after one poll with no write', async () => {
    await poll();
    const first = await publish({ [OTHER]: [{ region: 'AD', level: 1 }] }, null);
    now += 60_000;
    await publish({ [OTHER]: [{ region: 'AD', level: 2 }] }, first);
    const versions = () => runInDurableObject(stub(), (_instance, ctx) =>
      ctx.storage.sql.exec<{ version: number }>('SELECT version FROM gca_records_history ORDER BY version').toArray().map((r) => r.version));
    expect(await versions()).toEqual([1, 2]);
    now += 31 * DAY;
    await poll();
    expect(await versions()).toEqual([2]);
  });
});
