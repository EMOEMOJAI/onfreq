import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGcaEmbed, gcaMismatch, indexMemberVids, parseGcaPolicy, sendGcaReminders,
  type GuildMember,
} from '../src/gca';
import type { OnlineAtc } from '../src/types';
import type { DiscordEmbed } from '../src/discord';
import { cleanupGcaCopies } from '../src/retention';

const START = Date.parse('2026-09-09T12:00:00Z');
const QDLE = '100000000000000002';
const USER = '200000000000000001';
const CHANNEL = '300000000000000001';
const stub = () => env.POLL_COORDINATOR.getByName('gca-tests');
// Entirely fictional coverage and member records, unrelated to any deployment.
const REGIONS = JSON.stringify({
  AA: { name: 'Example North', prefixes: ['XA', 'XB'], homeCountries: ['AA', 'AB'] },
  AC: { name: 'Example West', prefixes: ['XC'] },
  AD: { name: 'Example East', prefixes: ['XD'] },
  AE: { name: 'Example South', prefixes: ['XF'] },
});
const APPROVALS = JSON.stringify({
  610001: [{ region: 'AA', level: 3 }],
  610002: [{ region: 'AC', level: 1 }],
  610003: [{ region: 'AD', level: 2 }],
  610004: [{ region: 'AE', level: 1 }],
  610005: [{ region: 'AE', level: 1 }],
  610006: [{ region: 'AA', level: 1 }],
});
const HOME_OVERRIDES = JSON.stringify({ 620001: 'AC' });
const settings = (): Env => ({
  ...env, GCA_DM_ENABLED: 'true', GCA_MEMBER_ROLE_ID: QDLE,
  GCA_REGIONS: REGIONS, GCA_APPROVALS: APPROVALS, GCA_HOME_OVERRIDES: HOME_OVERRIDES,
});
const policy = () => parseGcaPolicy(settings())!;
function atc(overrides: Partial<OnlineAtc> = {}): OnlineAtc {
  return {
    userId: 600001, sessionId: 123456, callsign: 'XDAA_ARR_APP', frequency: 124.2,
    position: 'APP', station: 'Example East Arrival', location: 'Example East',
    memberCountry: { countryId: 'AC', expiresAt: START + 86_400_000 }, ...overrides,
  };
}
const country = (countryId: string) => ({ countryId, expiresAt: START + 86_400_000 });
function member(vid = 600001, id = USER, roles = [QDLE]): GuildMember {
  return { user: { id }, nick: `Member (${vid})`, roles };
}

let now: number;
let members: GuildMember[];
let network: ReturnType<typeof vi.fn<typeof fetch>>;
let sent: Record<string, unknown>[];
let messageStatus: number;
let openStatus: number;
let listStatus: number;
let returnedRecipient: string;
let timeoutMessage: boolean;

function check(current: OnlineAtc[], config = settings()) {
  return runInDurableObject(stub(), (_instance, ctx) => sendGcaReminders(config, current, ctx.storage, now));
}

async function statuses() {
  return runInDurableObject(stub(), (_instance, ctx) =>
    ctx.storage.sql.exec('SELECT session_key, status, attempts FROM gca_reminders ORDER BY session_key').toArray());
}

function titles(): string[] {
  return sent.map((payload) => (payload.embeds as DiscordEmbed[])[0]!.title!);
}

beforeEach(() => {
  now = START;
  members = [member()];
  sent = [];
  messageStatus = openStatus = listStatus = 200;
  returnedRecipient = USER;
  timeoutMessage = false;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  network = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes('/members?')) return Response.json(listStatus === 200 ? members : { retry_after: 180 }, { status: listStatus });
    if (url.endsWith('/users/@me/channels')) {
      return Response.json({ id: CHANNEL, type: 1, recipients: [{ id: returnedRecipient }], retry_after: 180 }, { status: openStatus });
    }
    if (url.endsWith(`/channels/${CHANNEL}/messages`)) {
      sent.push(JSON.parse(String(init?.body)));
      if (timeoutMessage) throw new Error('Timed out after Discord may have delivered');
      return Response.json({ id: '300000000000000002', retry_after: 180 }, { status: messageStatus });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', network);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

describe('GCA coverage', () => {
  it.each([
    [1, ''], [2, '2nd'], [3, '3rd'], [4, '4th'],
    [11, '11th'], [12, '12th'], [13, '13th'],
    [21, '21st'], [22, '22nd'], [23, '23rd'], [111, '111th'], [112, '112th'], [113, '113th'],
  ])('formats occurrence %s as %s', (count, label) => {
    const embed = buildGcaEmbed(atc(), gcaMismatch(atc(), policy())!, Number(count));
    if (label) expect(embed.title).toContain(`[${label} occurrence]`);
    else expect(embed.title).not.toContain('occurrence');
  });

  it('detects AC controlling AD, but allows home-region sessions', () => {
    expect(gcaMismatch(atc(), policy())).toEqual({ region: 'AD', regionName: 'Example East', homeName: 'Example West', position: 'APP' });
    expect(gcaMismatch(atc({ memberCountry: country('AD') }), policy())).toBeNull();
  });

  it.each(['YYAA_TWR', 'YYBB_APP', 'YYCC_CTR', 'YYDD_CTR'])('excludes %s', (callsign) => {
    expect(gcaMismatch(atc({ callsign }), policy())).toBeNull();
  });

  it.each(['AA', 'AB'])('combines configured home countries for home country %s', (home) => {
    for (const callsign of ['XAAA_TWR', 'XBAA_TWR']) {
      expect(gcaMismatch(atc({ callsign, position: 'TWR', memberCountry: country(home) }), policy())).toBeNull();
    }
  });

  it.each([
    [610001, 'XAAA_CTR', 'CTR'], [610001, 'XBAA_APP', 'APP'],
    [610002, 'XCAA_TWR', 'TWR'], [610002, 'XCAA_GND', 'GND'],
    [610003, 'XDAA_ARR_APP', 'APP'], [610003, 'XDAA_DEP', 'DEP'],
    [610004, 'XFAA_TWR', 'TWR'], [610005, 'XFAA_DEL', 'DEL'],
    [610006, 'XAAA_TWR', 'TWR'], [610006, 'XBAA_GND', 'GND'],
  ])('honours approval %s / %s / %s', (userId, callsign, position) => {
    expect(gcaMismatch(atc({ userId: Number(userId), callsign: String(callsign), position: String(position), memberCountry: country('US') }), policy())).toBeNull();
  });

  it.each([
    [610002, 'XCAA_APP', 'APP'], [610003, 'XDBB_CTR', 'CTR'],
    [610004, 'XFAA_DEP', 'DEP'], [610005, 'XFBB_CTR', 'CTR'],
    [610006, 'XBAA_APP', 'APP'], [610001, 'XDBB_CTR', 'CTR'],
  ])('flags operations outside approval %s / %s / %s', (userId, callsign, position) => {
    expect(gcaMismatch(atc({ userId: Number(userId), callsign: String(callsign), position: String(position), memberCountry: country('US') }), policy())).not.toBeNull();
  });

  it('overrides 620001 to AC even when the profile says US or is unavailable', () => {
    expect(gcaMismatch(atc({ userId: 620001, callsign: 'XCAA_APP', memberCountry: country('US') }), policy())).toBeNull();
    expect(gcaMismatch(atc({ userId: 620001, memberCountry: null }), policy())?.homeName).toBe('Example West');
  });

  it('defers unknown countries, unknown positions and untuned controllers', () => {
    expect(gcaMismatch(atc({ memberCountry: null }), policy())).toBeNull();
    expect(gcaMismatch(atc({ memberCountry: country('ZZ') }), policy())).toBeNull();
    expect(gcaMismatch(atc({ frequency: 0 }), policy())).toBeNull();
    expect(gcaMismatch(atc({ position: 'FSS' }), policy())).toBeNull();
  });

  it('uses the approved paragraph-only embed with escaped external station text', () => {
    const controller = atc({ station: 'Example East **fake** <@123>\nArrival' });
    const embed = buildGcaEmbed(controller, gcaMismatch(controller, policy())!);
    expect(embed.fields).toBeUndefined();
    expect(embed.description?.split('\n\n')).toHaveLength(5);
    expect(embed.description).toContain('If you do not hold the required approval');
    expect(embed.description).toContain('\\*\\*fake\\*\\*');
    expect(embed.description).not.toContain('124.2');
    expect(embed.description).not.toContain('600001');
    expect(embed.description).not.toContain('TEST');
    expect(embed.color).toBe(0xfee75c);
  });
});

describe('GCA policy configuration', () => {
  it.each([
    '', 'not json', '[]', '{}',
    '{"constructor":{"name":"Example","prefixes":["XA"]}}',
    '{"ZZ":{"name":"Example","prefixes":["XA"]}}',
    '{"AA":null}', '{"AA":[]}',
    '{"AA":{"name":"","prefixes":["XA"]}}',
    '{"AA":{"name":"<@123>","prefixes":["XA"]}}',
    '{"AA":{"name":"Example","prefixes":[]}}',
    '{"AA":{"name":"Example","prefixes":["xa"]}}',
    '{"AA":{"name":"Example","prefixes":["XA_",1]}}',
    '{"AA":{"name":"Example","prefixes":["XA","XA"]}}',
    '{"AA":{"name":"Example","prefixes":["XA"],"homeCountries":["AB"]}}',
    '{"AA":{"name":"Example","prefixes":["XA"],"homeCountries":["AA","ZZ"]}}',
    '{"AA":{"name":"Example","prefixes":["XA"],"homeCountries":["AA",1]}}',
    '{"AA":{"name":"Example","prefixes":["XA"],"homeCountries":["AA","AA"]}}',
    '{"AA":{"name":"One","prefixes":["XA"]},"AB":{"name":"Two","prefixes":["X"]}}',
    '{"AA":{"name":"One","prefixes":["X"]},"AB":{"name":"Two","prefixes":["XA"]}}',
    '{"AA":{"name":"One","prefixes":["XA"],"homeCountries":["AA","AB"]},"AB":{"name":"Two","prefixes":["XB"]}}',
  ])('disables reminders for missing, malformed or ambiguous coverage: %s', (coverage) => {
    expect(parseGcaPolicy({ ...settings(), GCA_REGIONS: coverage })).toBeNull();
  });

  it('supports operator-defined coverage without a built-in region list', () => {
    const parsed = parseGcaPolicy({
      ...settings(), GCA_APPROVALS: '{}', GCA_HOME_OVERRIDES: '',
      GCA_REGIONS: JSON.stringify({ AF: { name: 'Example Custom', prefixes: ['Q', 'XYZA'] } }),
    })!;
    for (const callsign of ['QAAA_APP', 'XYZA_APP', 'xyza_APP']) {
      expect(gcaMismatch(atc({ callsign, memberCountry: country('US') }), parsed))
        .toEqual({ region: 'AF', regionName: 'Example Custom', homeName: 'United States', position: 'APP' });
    }
    expect(gcaMismatch(atc({ callsign: 'XYZB_APP' }), parsed)).toBeNull();
    expect(gcaMismatch(atc({ callsign: 'QAAA_APP', memberCountry: country('AF') }), parsed)).toBeNull();
  });

  it('does not contact Discord or create reminder state when coverage is absent', async () => {
    await check([atc()], { ...settings(), GCA_REGIONS: '' });
    expect(network).not.toHaveBeenCalled();
    const tables = await runInDurableObject(stub(), (_instance, ctx) =>
      ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'gca_reminders'").toArray());
    expect(tables).toHaveLength(0);
  });

  it('reads approvals, overrides and an https policy link', () => {
    const parsed = parseGcaPolicy({ ...settings(), GCA_POLICY_URL: 'https://example.test/gca' })!;
    expect(parsed.approvals[610001]).toEqual([{ region: 'AA', level: 3 }]);
    expect(parsed.homeOverrides[620001]).toBe('AC');
    expect(parsed.policyUrl).toBe('https://example.test/gca');
  });

  it('treats an explicit empty record as "nobody is approved"', () => {
    const parsed = parseGcaPolicy({ ...settings(), GCA_APPROVALS: '{}', GCA_HOME_OVERRIDES: '' })!;
    expect(parsed).not.toBeNull();
    expect(gcaMismatch(atc({ userId: 610003 }), parsed)).not.toBeNull();
  });

  it.each([
    ['', 'unset'],
    ['not json', 'malformed'],
    ['[]', 'an array'],
    ['{"610001":[{"region":"ZZ","level":1}]}', 'an unknown region'],
    ['{"610001":[{"region":"constructor","level":1}]}', 'a prototype-chain region'],
    ['{"610001":[{"region":"toString","level":1}]}', 'an inherited-method region'],
    ['{"610001":[{"region":"__proto__","level":1}]}', 'a __proto__ region'],
    ['{"__proto__":[{"region":"AA","level":1}]}', 'a __proto__ member id'],
    ['{"610001":[{"region":"AA","level":9}]}', 'an out-of-range level'],
    ['{"610001":[{"region":"AA"}]}', 'a missing level'],
    ['{"0":[]}', 'an invalid member id'],
  ])('refuses to run on %s approvals (%s)', (approvals) => {
    expect(parseGcaPolicy({ ...settings(), GCA_APPROVALS: String(approvals) })).toBeNull();
  });

  it.each(['not json', '{"620001":"Example West"}', '{"620001":1}'])(
    'refuses to run on malformed overrides: %s', (overrides) => {
      expect(parseGcaPolicy({ ...settings(), GCA_HOME_OVERRIDES: String(overrides) })).toBeNull();
    });

  it.each([
    'http://example.test/gca', 'javascript:alert(1)', 'https://example.test/a(b)', 'nonsense',
    'https://example.test/x\\', 'https://example.test/[x]', 'https://example.test/`x`',
  ])(
    'ignores unusable policy link %s', (url) => {
      expect(parseGcaPolicy({ ...settings(), GCA_POLICY_URL: String(url) })?.policyUrl).toBeUndefined();
    });

  it('links the policy only when one is configured', () => {
    const mismatch = gcaMismatch(atc(), policy())!;
    expect(buildGcaEmbed(atc(), mismatch).description).not.toContain('](');
    expect(buildGcaEmbed(atc(), mismatch, 1, 'https://example.test/gca').description)
      .toContain('(https://example.test/gca)');
  });

  it.each([2048, 2049, 5000])('keeps a %i-character policy URL within the embed budget', (length) => {
    const url = 'https://example.test/gca?ref='.padEnd(length, 'x');
    const parsed = parseGcaPolicy({ ...settings(), GCA_POLICY_URL: url })!;
    expect(parsed.policyUrl).toBe(length <= 2048 ? url : undefined);
    const controller = atc({ callsign: 'XD' + 'A'.repeat(38), station: '*'.repeat(100) });
    const embed = buildGcaEmbed(controller, gcaMismatch(controller, parsed)!, 123, parsed.policyUrl);
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
  });

  it('still delivers reminders when a policy URL would exceed Discord limits', async () => {
    const config = { ...settings(), GCA_POLICY_URL: 'https://example.test/' + 'x'.repeat(5000) };
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/channels/${CHANNEL}/messages`)) {
        const payload = JSON.parse(String(init?.body)) as { embeds: DiscordEmbed[] };
        if (payload.embeds[0]!.description!.length > 4096) {
          return Response.json({ message: 'Invalid Form Body' }, { status: 400 });
        }
      }
      return original(input, init);
    });
    await check([], config);
    await check([atc()], config);
    expect(sent).toHaveLength(1);
    expect((await statuses())[0]?.status).toBe('sent');
  });

  it('sends nothing when approvals are missing or unusable', async () => {
    await check([atc()], { ...settings(), GCA_APPROVALS: '' });
    await check([atc()], { ...settings(), GCA_APPROVALS: '' });
    expect(sent).toHaveLength(0);
    await check([atc()], { ...settings(), GCA_DISCORD_GUILD_ID: 'not-a-guild' });
    expect(sent).toHaveLength(0);
  });
});

describe('Discord VID mapping', () => {
  it('accepts parentheses or prefix format, only for role holders', () => {
    expect(indexMemberVids([member()], QDLE).get(600001)).toBe(USER);
    expect(indexMemberVids([{ ...member(), nick: '600001 Member' }], QDLE).get(600001)).toBe(USER);
    expect(indexMemberVids([member(600001, USER, [])], QDLE).size).toBe(0);
  });

  it('rejects duplicates even when one account lacks the role or is a bot', () => {
    expect(indexMemberVids([member(), member(600001, '111111111111111111', [])], QDLE).size).toBe(0);
    expect(indexMemberVids([member(), { ...member(), user: { id: '111111111111111111', bot: true } }], QDLE).size).toBe(0);
  });

  it.each(['Member (6000010)', 'Member (600001) 123456', 'Member (staff)', '', null])('rejects ambiguous/missing VID: %s', (nick) => {
    expect(indexMemberVids([{ ...member(), nick }], QDLE).size).toBe(0);
  });
});

describe('durable GCA delivery', () => {
  it('counts each connection once across regions and restarts', async () => {
    await check([]);
    await check([atc()]);
    await check([atc()]);
    await evictDurableObject(stub());
    now += 60_000;
    await check([atc({ sessionId: 2, callsign: 'XFAA_APP' })]);
    await check([atc({ sessionId: 2, callsign: 'XAAA_APP' })]);
    await check([atc({ sessionId: 3, callsign: 'XAAA_APP' })]);
    expect(titles()).toHaveLength(3);
    expect(titles()[0]).not.toContain('occurrence');
    expect(titles()[1]).toContain('[2nd occurrence]');
    expect(titles()[2]).toContain('[3rd occurrence]');
  });

  it('keeps a stable occurrence on 429 retries even if a newer connection is processed first', async () => {
    await check([]);
    await check([atc()]);
    messageStatus = 429;
    await check([atc({ sessionId: 2 })]);
    expect(titles()[1]).toContain('[2nd occurrence]');
    await evictDurableObject(stub());
    now += 180_000;
    messageStatus = 200;
    await check([atc({ sessionId: 3 }), atc({ sessionId: 2 })]);
    expect(titles()[2]).toContain('[3rd occurrence]');
    expect(titles()[3]).toContain('[2nd occurrence]');
    await check([atc({ sessionId: 4 })]);
    expect(titles()[4]).toContain('[4th occurrence]');
  });

  it('counts a qualifying connection with a blocked DM, but not the retry polls', async () => {
    await check([]);
    openStatus = 403;
    await check([atc()]);
    await check([atc()]);
    openStatus = 200;
    await check([atc({ sessionId: 2 })]);
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain('[2nd occurrence]');
  });

  it('keeps counters separate for different VIDs', async () => {
    await check([]);
    await check([atc()]);
    members = [member(600002)];
    await check([atc({ userId: 600002, sessionId: 2 })]);
    expect(titles().every((title) => !title.includes('occurrence'))).toBe(true);
  });

  it('excludes baseline, unmapped, approved and home-region connections from the count', async () => {
    await check([atc()]);
    await check([atc({ sessionId: 2, callsign: 'XCAA_APP' })]);
    await check([atc({ sessionId: 3, userId: 610003 })]);
    members = [];
    await check([atc({ sessionId: 4 })]);
    members = [member()];
    await check([atc({ sessionId: 5 })]);
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).not.toContain('occurrence');
  });

  it('migrates previous attempted reminders without resending or resetting the count', async () => {
    await check([]);
    await runInDurableObject(stub(), async (_instance, ctx) => {
      await ctx.storage.delete('gca-occurrences-migrated-v1');
      for (const [session, status, attempts] of [
        [1, 'sent', 1], [2, 'reserved', 1], [3, 'failed', 1], [4, 'pending', 1],
        [5, 'baseline', 0], [6, 'unmapped', 0], [7, 'pending', 0],
      ] as const) {
        ctx.storage.sql.exec('INSERT INTO gca_reminders (session_key, status, last_seen, attempts) VALUES (?, ?, ?, ?)',
          `600001:${session}`, status, now, attempts);
      }
      ctx.storage.sql.exec("INSERT INTO gca_reminders (session_key, status, last_seen) VALUES ('600002:1', 'sent', ?)", now);
    });
    await evictDurableObject(stub());
    await check([atc({ sessionId: 8 })]);
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain('[5th occurrence]');
    await evictDurableObject(stub());
    await check([atc({ sessionId: 9 })]);
    expect(titles()[1]).toContain('[6th occurrence]');
    await check([atc({ sessionId: 1 }), atc({ sessionId: 2 })]);
    expect(titles()).toHaveLength(2);
  });

  it('does no network work when disabled', async () => {
    await check([atc()], { ...settings(), GCA_DM_ENABLED: 'false' });
    expect(network).not.toHaveBeenCalled();
  });

  it('silently baselines existing connections when enabled', async () => {
    await check([atc()]);
    now += 60_000;
    await check([atc()]);
    expect(network).not.toHaveBeenCalled();
    expect((await statuses())[0]?.status).toBe('baseline');
  });

  it('sends immediately once, including after eviction, feed gaps and callsign changes', async () => {
    await check([]);
    await check([atc()]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.allowed_mentions).toEqual({ parse: [] });
    expect((await statuses())[0]?.status).toBe('sent');
    await evictDurableObject(stub());
    now += 60_000;
    await check([]);
    await check([atc({ callsign: 'QESS_APP' })]);
    now += 30 * 86_400_000;
    await check([]);
    await check([atc()]);
    expect(sent).toHaveLength(1);
    await check([atc({ sessionId: 123457 })]);
    expect(sent).toHaveLength(2);
  });

  it('does not send twice for a duplicated session in the same response', async () => {
    await check([]);
    await check([atc(), atc({ callsign: 'QESS_APP' })]);
    expect(sent).toHaveLength(1);
  });

  it('waits for country/frequency data then sends on the next eligible poll', async () => {
    await check([]);
    await check([atc({ memberCountry: null })]);
    await check([atc({ frequency: 0 })]);
    expect(sent).toHaveLength(0);
    now += 60_000;
    await check([atc()]);
    expect(sent).toHaveLength(1);
  });

  it('never DMs a duplicate VID or a member without the configured role', async () => {
    await check([]);
    members = [member(), member(600001, '111111111111111111', [])];
    await check([atc()]);
    expect(sent).toHaveLength(0);
    expect((await statuses())[0]?.status).toBe('unmapped');
    members = [member(600001, USER, [])];
    await check([atc({ sessionId: 2 })]);
    expect(sent).toHaveLength(0);
  });

  it('requires a complete member list and detects duplicates on later pages', async () => {
    await check([]);
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/members?')) {
        return Response.json(url.endsWith('after=0')
          ? [member(), ...Array.from({ length: 999 }, (_, i) => ({ user: { id: String(400000000000000000n + BigInt(i)) }, nick: null, roles: [] }))]
          : [member(600001, '500000000000000000')]);
      }
      return original(input, init);
    });
    await check([atc()]);
    expect(network).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(0);
  });

  it.each([403, 500])('does not use a partial member list after HTTP %s', async (status) => {
    await check([]);
    listStatus = status;
    await expect(check([atc()])).rejects.toThrow('Discord status');
    expect(sent).toHaveLength(0);
    listStatus = 200;
    now += 60_000;
    await check([atc()]);
    expect(sent).toHaveLength(1);
  });

  it('persists a reservation before the POST so eviction cannot duplicate it', async () => {
    await check([]);
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/channels/${CHANNEL}/messages`)) {
        // Simulate the durable state left by a process dying during the POST.
        expect((await statuses())[0]?.status).toBe('reserved');
      }
      return original(input, init);
    });
    await check([atc()]);
    await runInDurableObject(stub(), (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE gca_reminders SET status = 'reserved'");
    });
    await evictDurableObject(stub());
    await check([atc()]);
    expect(sent).toHaveLength(1);
  });

  it.each([403, 500])('does not repeat a message attempt after HTTP %s', async (status) => {
    await check([]);
    messageStatus = status;
    await check([atc()]);
    now += 60_000;
    messageStatus = 200;
    await check([atc()]);
    expect(sent).toHaveLength(1);
    expect((await statuses())[0]?.status).toBe('failed');
  });

  it('does not repeat a timed-out POST that may have delivered', async () => {
    await check([]);
    timeoutMessage = true;
    await check([atc()]);
    await evictDurableObject(stub());
    timeoutMessage = false;
    now += 60_000;
    await check([atc()]);
    expect(sent).toHaveLength(1);
  });

  it('honours 429 backoff across restarts before retrying an explicitly rejected POST', async () => {
    await check([]);
    messageStatus = 429;
    await check([atc()]);
    expect(sent).toHaveLength(1);
    const calls = network.mock.calls.length;
    await evictDurableObject(stub());
    messageStatus = 200;
    now += 60_000;
    await check([atc()]);
    expect(network).toHaveBeenCalledTimes(calls);
    now += 120_000;
    await check([atc()]);
    expect(sent).toHaveLength(2); // First POST was rejected; only the second delivered.
    await check([atc()]);
    expect(sent).toHaveLength(2);
  });

  it('retries opening a DM on transient errors, but abandons closed DMs', async () => {
    await check([]);
    openStatus = 500;
    await check([atc()]);
    expect(sent).toHaveLength(0);
    openStatus = 200;
    now += 60_000;
    await check([atc()]);
    expect(sent).toHaveLength(1);
    openStatus = 403;
    await check([atc({ sessionId: 2 })]);
    openStatus = 200;
    now += 60_000;
    await check([atc({ sessionId: 2 })]);
    expect(sent).toHaveLength(1);
  });

  it('rejects an unexpected DM recipient', async () => {
    await check([]);
    returnedRecipient = '111111111111111111';
    await check([atc()]);
    expect(sent).toHaveLength(0);
  });

  it('caps DM attempts per poll and retries deferred connections', async () => {
    await check([]);
    const controllers = Array.from({ length: 5 }, (_, i) => atc({ sessionId: 100 + i }));
    await check(controllers);
    expect(sent).toHaveLength(3);
    now += 60_000;
    await check(controllers);
    expect(sent).toHaveLength(5);
    await check(controllers);
    expect(sent).toHaveLength(5);
  });

  it('stops retrying after five rejected attempts', async () => {
    await check([]);
    openStatus = 500;
    for (let i = 0; i < 6; i++) {
      await check([atc()]);
      now += 60_000;
    }
    expect((await statuses())[0]).toMatchObject({ status: 'failed', attempts: 5 });
    expect(network.mock.calls.filter(([url]) => String(url).endsWith('/users/@me/channels'))).toHaveLength(5);
  });
});

describe('staff copies', () => {
  const COPY_USER = '111111111111111111';
  const COPY_CHANNEL = '222222222222222222';
  const config = () => ({ ...settings(), GCA_COPY_USER_ID: COPY_USER });
  let copies: Record<string, unknown>[];
  let copyStatus: number;
  let copyOpenStatus: number;
  let copyTimeout: boolean;
  let copyRecipient: string;

  beforeEach(() => {
    copies = [];
    copyStatus = copyOpenStatus = 200;
    copyTimeout = false;
    copyRecipient = COPY_USER;
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/users/@me/channels') && JSON.parse(String(init?.body)).recipient_id === COPY_USER) {
        return Response.json({ id: COPY_CHANNEL, type: 1, recipients: [{ id: copyRecipient }], retry_after: 180 }, { status: copyOpenStatus });
      }
      if (url.endsWith(`/channels/${COPY_CHANNEL}/messages`)) {
        copies.push(JSON.parse(String(init?.body)));
        if (copyTimeout) throw new Error('Ambiguous copy timeout');
        return Response.json({ id: '333333333333333333', retry_after: 180 }, { status: copyStatus });
      }
      return original(input, init);
    });
  });

  it('preserves reminder deduplication and occurrence counts after old-copy cleanup', async () => {
    await check([], config());
    await check([atc()], config());
    now += 31 * 86_400_000;
    await runInDurableObject(stub(), (_, ctx) => {
      expect(cleanupGcaCopies(ctx.storage, true, now).deleted).toBe(1);
    });
    await evictDurableObject(stub());
    await check([atc()], config());
    expect(sent).toHaveLength(1);
    expect(copies).toHaveLength(1);
    await check([atc({ sessionId: 123457 })], config());
    expect(sent).toHaveLength(2);
    expect(titles()[1]).toContain('[2nd occurrence]');
  });

  it('copies the exact embed and identifies the recipient without another member DM', async () => {
    await check([], config());
    await check([atc()], config());
    expect(copies).toHaveLength(1);
    expect(copies[0]!.embeds).toEqual(sent[0]!.embeds);
    expect(copies[0]!.content).toBe(`Copy of reminder sent to <@${USER}> · VID 600001`);
    expect(copies[0]!.allowed_mentions).toEqual({ parse: [] });
    await evictDurableObject(stub());
    await check([atc({ callsign: 'QESS_APP' })], config());
    expect(sent).toHaveLength(1);
    expect(copies).toHaveLength(1);
    await check([atc({ sessionId: 123457 })], config());
    expect((copies[1]!.embeds as DiscordEmbed[])[0]!.title).toContain('[2nd occurrence]');
    expect(copies[1]!.embeds).toEqual(sent[1]!.embeds);
  });

  it.each([403, 429, 500])('does not copy a member message rejected with %s', async (status) => {
    await check([], config());
    messageStatus = status;
    await check([atc()], config());
    expect(copies).toHaveLength(0);
  });

  it('does not claim a member timeout was delivered', async () => {
    await check([], config());
    timeoutMessage = true;
    await check([atc()], config());
    expect(copies).toHaveLength(0);
  });

  it('retries a rejected copy after restart and disconnect without resending the member DM', async () => {
    await check([], config());
    copyStatus = 429;
    await check([atc()], config());
    expect((await statuses())[0]).toMatchObject({ status: 'sent', attempts: 1 });
    const originalCopy = copies[0];
    await evictDurableObject(stub());
    now += 60_000;
    await check([], config());
    expect(copies).toHaveLength(1);
    now += 180_000;
    copyStatus = 200;
    await check([], config());
    expect(copies).toHaveLength(2);
    expect(copies[1]).toEqual(originalCopy);
    expect(sent).toHaveLength(1);
    await check([atc()], config());
    expect(copies).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it.each([403, 500, 'timeout'])('never repeats a possibly delivered or permanently rejected copy (%s)', async (status) => {
    await check([], config());
    if (status === 'timeout') copyTimeout = true;
    else copyStatus = Number(status);
    await check([atc()], config());
    now += 300_000;
    await check([atc()], config());
    expect(copies).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect((await statuses())[0]).toMatchObject({ status: 'sent' });
  });

  it('retries a temporary failure opening the staff DM independently', async () => {
    await check([], config());
    copyOpenStatus = 500;
    await check([atc()], config());
    expect(copies).toHaveLength(0);
    now += 60_000;
    copyOpenStatus = 200;
    await check([], config());
    expect(copies).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('validates the staff DM recipient before sending', async () => {
    await check([], config());
    copyRecipient = USER;
    await check([atc()], config());
    expect(copies).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it.each(['', 'invalid', USER])('skips disabled, invalid or self copies (%s)', async (recipient) => {
    const cfg = { ...config(), GCA_COPY_USER_ID: recipient };
    await check([], cfg);
    await check([atc()], cfg);
    expect(copies).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it('does not retrospectively copy reminders sent before copies were enabled', async () => {
    await check([]);
    await check([atc()]);
    await check([atc()], config());
    expect(copies).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it('does not redirect pending copies if the configured staff account changes', async () => {
    await check([], config());
    copyOpenStatus = 500;
    await check([atc()], config());
    now += 300_000;
    copyOpenStatus = 200;
    await check([], { ...config(), GCA_COPY_USER_ID: USER });
    expect(sent).toHaveLength(1);
    expect(copies).toHaveLength(0);
    await check([], config());
    expect(copies).toHaveLength(1);
  });
});
