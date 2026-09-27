import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGcaEmbed, gcaMismatch, indexMemberVids, parseGcaPolicy, sendGcaReminders,
  type GuildMember,
} from '../src/gca';
import type { OnlineAtc } from '../src/types';
import { postMessage, type DiscordEmbed } from '../src/discord';
import { DiscordRateLimits } from '../src/discord-rate-limit';
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
  return runInDurableObject(stub(), (_instance, ctx) =>
    sendGcaReminders(config, current, ctx.storage, now, parseGcaPolicy(config), []));
}

async function statuses() {
  return runInDurableObject(stub(), (_instance, ctx) =>
    ctx.storage.sql.exec('SELECT session_key, status, attempts FROM gca_reminders ORDER BY session_key').toArray());
}

function titles(): string[] {
  return sent.map((payload) => (payload.embeds as DiscordEmbed[])[0]!.title!);
}

function occurrences() {
  return runInDurableObject(stub(), (_instance, ctx) =>
    ctx.storage.sql.exec('SELECT session_key, occurrence FROM gca_occurrences ORDER BY session_key').toArray());
}

/** The occurrence an earlier version kept for a DM deferred by a 429. */
function seedLegacyOccurrence(sessionId: number, occurrence: number) {
  return runInDurableObject(stub(), (_instance, ctx) => {
    ctx.storage.sql.exec('INSERT INTO gca_occurrences (session_key, user_id, occurrence) VALUES (?, 600001, ?)',
      `600001:${sessionId}`, occurrence);
  });
}

/** Parsed JSON log lines for one event. */
function logged(spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown>; } catch { return {}; } })
    .filter((entry) => entry.event === event);
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

  it('never turns an unknown home override into an approval warning', async () => {
    const config = { ...settings(), GCA_HOME_OVERRIDES: '{"600001":"ZZ"}' };
    expect(parseGcaPolicy(config)).toBeNull();
    const unvalidated = { ...policy(), homeOverrides: { 600001: 'ZZ' } };
    expect(gcaMismatch(atc(), unvalidated)).toBeNull();
    await check([], config);
    await check([atc()], config);
    expect(network).not.toHaveBeenCalled();
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

  it('escapes emphasis-forming underscores in the callsign but keeps word-internal ones', () => {
    const controller = atc({ callsign: 'XDAA__TWR' });
    const embed = buildGcaEmbed(controller, gcaMismatch(controller, policy())!);
    expect(embed.title).toContain('XDAA\\_\\_TWR');
    expect(embed.description).toContain('**XDAA\\_\\_TWR');
    const plain = atc({ callsign: 'XDAA_TWR' });
    expect(buildGcaEmbed(plain, gcaMismatch(plain, policy())!).title).toContain('XDAA_TWR');
  });

  it('truncates a station name to 100 code points without splitting a surrogate pair', () => {
    // An emoji is one code point but two UTF-16 code units: a naive
    // String.prototype.slice(0, 100) would cut it in half, leaving an
    // unpaired surrogate that corrupts the rest of the embed.
    const station = `${'A'.repeat(99)}😀 trailing`;
    const controller = atc({ station });
    const embed = buildGcaEmbed(controller, gcaMismatch(controller, policy())!);
    const expected = Array.from(station).slice(0, 100).join('');
    expect(embed.description).toContain(expected);
    expect(embed.description).not.toContain('�');
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
    ' {"AA":{"name":"Example","prefixes":["XA"]}}', // NBSP is not JSON whitespace
    '{"AA":{"name":"Example","prefixes":["XA"]}} ',
    '﻿{"AA":{"name":"Example","prefixes":["XA"]}}', // a BOM is not JSON whitespace either
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

  it.each([
    ['GCA_REGIONS', '{"AA":{"name":"One","prefixes":["XA"]},"AA":{"name":"Two","prefixes":["XB"]}}', 'a duplicate top-level region'],
    ['GCA_REGIONS', '{"AA":{"name":"Example","prefixes":["XA"],"prefixes":["XB"]}}', 'a duplicate nested key'],
    ['GCA_APPROVALS', '{"610001":[{"region":"AA","level":1}],"610001":[{"region":"AC","level":1}]}', 'a duplicate VID'],
    ['GCA_APPROVALS', '{"610001":[{"region":"AA","level":1,"level":2}]}', 'a duplicate nested key'],
    ['GCA_HOME_OVERRIDES', '{"620001":"AC","620001":"AD"}', 'a duplicate VID'],
  ])('rejects %s with %s instead of silently keeping only the last value', (key, value) => {
    expect(parseGcaPolicy({ ...settings(), [key as string]: value })).toBeNull();
  });

  it.each(['not json', '{"620001":"Example West"}', '{"620001":1}'])(
    'refuses to run on malformed overrides: %s', (overrides) => {
      expect(parseGcaPolicy({ ...settings(), GCA_HOME_OVERRIDES: String(overrides) })).toBeNull();
    });

  it('treats NBSP-only overrides as non-empty, unparseable JSON, disabling reminders', () => {
    // A lone NBSP is not JSON whitespace: it must not be silently trimmed away
    // into the "absent" empty-record case, the way String.prototype.trim()
    // would trim it.
    expect(parseGcaPolicy({ ...settings(), GCA_HOME_OVERRIDES: ' ' })).toBeNull();
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

  it('keeps a 2048-character policy URL within the embed budget', () => {
    const url = 'https://example.test/gca?ref='.padEnd(2048, 'x');
    const parsed = parseGcaPolicy({ ...settings(), GCA_POLICY_URL: url })!;
    expect(parsed.policyUrl).toBe(url);
    const controller = atc({ callsign: 'XD' + 'A'.repeat(38), station: '*'.repeat(100) });
    const embed = buildGcaEmbed(controller, gcaMismatch(controller, parsed)!, 123, parsed.policyUrl);
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
  });

  it.each([2049, 5000])('disables reminders for a %i-character policy URL', (length) => {
    const url = 'https://example.test/gca?ref='.padEnd(length, 'x');
    expect(parseGcaPolicy({ ...settings(), GCA_POLICY_URL: url })).toBeNull();
  });

  it('sends nothing when a configured policy URL is unusable, and logs a fixed reason', async () => {
    const error = vi.spyOn(console, 'error');
    const config = { ...settings(), GCA_POLICY_URL: 'http://example.test/gca' };
    await check([]);
    await check([atc()], config);
    expect(sent).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'gca_config_invalid', reason: 'policy_url' }));
    // Unset remains valid: the DM simply has no link.
    await check([atc({ sessionId: 2 })], { ...settings(), GCA_POLICY_URL: ' ' });
    expect(sent).toHaveLength(1);
  });

  it('sends nothing when approvals or the guild ID are missing or unusable', async () => {
    const error = vi.spyOn(console, 'error');
    // Baseline first: otherwise the first valid run would only baseline anyway.
    await check([]);
    await check([atc()], { ...settings(), GCA_APPROVALS: '' });
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'gca_config_invalid', reason: 'policy' }));
    await check([atc({ sessionId: 2 })], { ...settings(), GCA_DISCORD_GUILD_ID: 'not-a-guild' });
    expect(network).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'gca_config_invalid', reason: 'guild_or_role' }));
    // Positive control: the same connection is warned once configuration is valid.
    await check([atc({ sessionId: 2 })]);
    expect(sent).toHaveLength(1);
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

  it.each([
    'Member (0600001)', 'Member (1234)', 'Member (12345678901)', 'Member (600001) 123456', 'Member (staff)', '', null,
  ])('rejects ambiguous/missing VID: %s', (nick) => {
    expect(indexMemberVids([{ ...member(), nick }], QDLE).size).toBe(0);
  });

  it.each([10001, 6000010, 1234567890])('accepts the same 5–10 digit VIDs as approval records: %i', (vid) => {
    expect(indexMemberVids([member(vid)], QDLE).get(vid)).toBe(USER);
  });

  it('trusts a nickname VID only for holders of the configured verified role', () => {
    const VERIFIED = '100000000000000003';
    expect(indexMemberVids([member()], QDLE, VERIFIED).size).toBe(0);
    expect(indexMemberVids([member(600001, USER, [QDLE, VERIFIED])], QDLE, VERIFIED).get(600001)).toBe(USER);
    // An unverified account copying a verified member's VID cannot block them.
    expect(indexMemberVids([
      member(600001, USER, [QDLE, VERIFIED]), member(600001, '111111111111111111', [QDLE]),
      member(600001, '111111111111111112', [VERIFIED]), member(600001, '111111111111111113', []),
    ], QDLE, VERIFIED).get(600001)).toBe(USER);
    // Two verified members claiming one VID are still ambiguous.
    expect(indexMemberVids([
      member(600001, USER, [QDLE, VERIFIED]), member(600001, '111111111111111111', [QDLE, VERIFIED]),
    ], QDLE, VERIFIED).size).toBe(0);
  });

  it('DMs a verified member whose VID an unverified account copied', async () => {
    const VERIFIED = '100000000000000003';
    const config = { ...settings(), GCA_VERIFIED_ROLE_ID: VERIFIED };
    members = [member(600001, USER, [QDLE, VERIFIED]), member(600001, '111111111111111111', [QDLE])];
    await check([], config);
    await check([atc()], config);
    expect(sent).toHaveLength(1);
  });

  it('does not DM a member without the verified role, and disables reminders for an invalid one', async () => {
    const VERIFIED = '100000000000000003';
    const error = vi.spyOn(console, 'error');
    await check([], { ...settings(), GCA_VERIFIED_ROLE_ID: VERIFIED });
    await check([atc()], { ...settings(), GCA_VERIFIED_ROLE_ID: VERIFIED });
    expect(sent).toHaveLength(0);
    expect(parseGcaPolicy({ ...settings(), GCA_VERIFIED_ROLE_ID: 'staff' })).toBeNull();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'gca_config_invalid', reason: 'verified_role' }));
    members = [member(600001, USER, [QDLE, VERIFIED])];
    await check([atc({ sessionId: 2 })], { ...settings(), GCA_VERIFIED_ROLE_ID: VERIFIED });
    expect(sent).toHaveLength(1);
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

  it('releases a 429-deferred occurrence, numbering warnings in the order the member receives them', async () => {
    await check([]);
    await check([atc()]);
    messageStatus = 429;
    await check([atc({ sessionId: 2 })]);
    // Rejected by Discord, so never received: its occurrence is not kept.
    expect(titles()[1]).toContain('[2nd occurrence]');
    expect(await occurrences()).toEqual([{ session_key: '600001:123456', occurrence: 1 }]);
    await evictDurableObject(stub());
    now += 180_000;
    messageStatus = 200;
    // A newer connection processed first takes the next number.
    await check([atc({ sessionId: 3 }), atc({ sessionId: 2 })]);
    await check([atc({ sessionId: 4 })]);
    const received = titles().filter((_title, i) => i !== 1);
    expect(received[0]).not.toContain('occurrence');
    expect(received.slice(1).map((title) => /\[(\w+) occurrence\]/.exec(title)?.[1])).toEqual(['2nd', '3rd', '4th']);
    expect(await occurrences()).toEqual([
      { session_key: '600001:123456', occurrence: 1 }, { session_key: '600001:2', occurrence: 3 },
      { session_key: '600001:3', occurrence: 2 }, { session_key: '600001:4', occurrence: 4 },
    ]);
  });

  it('does not count a connection whose DM was never attempted', async () => {
    await check([]);
    openStatus = 403;
    await check([atc()]);
    await check([atc()]);
    openStatus = 200;
    await check([atc({ sessionId: 2 })]);
    expect(titles()).toHaveLength(1);
    // The member's first received warning is never labelled a repeat.
    expect(titles()[0]).not.toContain('occurrence');
    expect(await occurrences()).toEqual([{ session_key: '600001:2', occurrence: 1 }]);
  });

  it('checks lowercase callsigns the same way as the public marker', async () => {
    await check([]);
    await check([atc({ callsign: 'xdaa_arr_app' })]);
    expect(sent).toHaveLength(1);
  });

  it.each([['XD-AA_APP', 1], ['XD', 1], ['XD.AA_APP', 0]])(
    'accepts the same callsign shapes as the feed and public marker: %s', async (callsign, expected) => {
      await check([]);
      await check([atc({ callsign: String(callsign) })]);
      expect(sent).toHaveLength(Number(expected));
    },
  );

  it('releases the occurrence of a DM Discord definitely rejected, keeping the others', async () => {
    await check([]);
    await check([atc({ sessionId: 1 })]);
    messageStatus = 403;
    await check([atc({ sessionId: 2 })]);
    expect(titles()[1]).toContain('[2nd occurrence]');
    expect((await statuses()).find((row) => row.session_key === '600001:2')).toMatchObject({ status: 'failed' });
    expect(await occurrences()).toEqual([{ session_key: '600001:1', occurrence: 1 }]);
    messageStatus = 200;
    await check([atc({ sessionId: 3 })]);
    // The member never received the rejected warning, so it is not counted.
    expect(titles()[2]).toContain('[2nd occurrence]');
    // A timeout may have delivered: that occurrence stays counted.
    timeoutMessage = true;
    await check([atc({ sessionId: 4 })]);
    expect(await occurrences()).toEqual([
      { session_key: '600001:1', occurrence: 1 }, { session_key: '600001:3', occurrence: 2 },
      { session_key: '600001:4', occurrence: 3 },
    ]);
    // The rejected connection is still deduplicated, never re-sent.
    timeoutMessage = false;
    now += 3_600_000;
    await check([atc({ sessionId: 2 })]);
    expect(sent).toHaveLength(4);
  });

  it('releases the occurrence of a DM whose final attempt Discord rate-limited', async () => {
    await check([]);
    await check([atc({ sessionId: 1 })]);
    messageStatus = 429;
    for (let i = 0; i < 5; i++) {
      now += 200_000;
      await check([atc({ sessionId: 2 })]);
    }
    expect(sent).toHaveLength(6);
    expect((await statuses()).find((row) => row.session_key === '600001:2')).toMatchObject({ status: 'failed', attempts: 5 });
    expect(await occurrences()).toEqual([{ session_key: '600001:1', occurrence: 1 }]);
    messageStatus = 200;
    now += 200_000;
    await check([atc({ sessionId: 3 })]);
    expect(titles().at(-1)).toContain('[2nd occurrence]');
  });

  it.each([
    ['opening the DM is refused (403)', 2],
    ['the DM channel has an unexpected recipient', 2],
    ['opening the DM fails with 5xx until attempts run out', 5],
  ] as const)('releases the occurrence of a rate-limited DM that later fails before its message POST: %s', async (mode, attempts) => {
    await check([]);
    await check([atc({ sessionId: 1 })]);
    messageStatus = 429;
    await check([atc({ sessionId: 2 })]);
    expect((await statuses()).find((row) => row.session_key === '600001:2')).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await occurrences()).toEqual([{ session_key: '600001:1', occurrence: 1 }]);
    // A row left by an earlier version still holds the deferred occurrence.
    await seedLegacyOccurrence(2, 2);
    // The retries never reach the message POST again.
    messageStatus = 200;
    if (mode.includes('403')) openStatus = 403;
    else if (mode.includes('recipient')) returnedRecipient = '111111111111111111';
    else openStatus = 500;
    for (let i = 0; i < 4 && (await statuses()).find((row) => row.session_key === '600001:2')?.status === 'pending'; i++) {
      now += 200_000;
      await check([atc({ sessionId: 2 })]);
    }
    expect(sent).toHaveLength(2);
    expect((await statuses()).find((row) => row.session_key === '600001:2')).toMatchObject({ status: 'failed', attempts });
    expect(network.mock.calls.filter(([url]) => String(url).endsWith('/users/@me/channels'))).toHaveLength(attempts + 1);
    expect(await occurrences()).toEqual([{ session_key: '600001:1', occurrence: 1 }]);
    openStatus = 200;
    returnedRecipient = USER;
    now += 60_000;
    await check([atc({ sessionId: 3 })]);
    expect(titles().at(-1)).toContain('[2nd occurrence]');
  });

  it('releases the legacy occurrence of a rate-limited DM whose member left the server', async () => {
    await check([]);
    await check([atc({ sessionId: 1 })]);
    messageStatus = 429;
    await check([atc({ sessionId: 2 })]);
    await seedLegacyOccurrence(2, 2);
    messageStatus = 200;
    members = [];
    now += 200_000;
    await check([atc({ sessionId: 2 })]);
    expect((await statuses()).find((row) => row.session_key === '600001:2')).toMatchObject({ status: 'unmapped' });
    expect(await occurrences()).toEqual([{ session_key: '600001:1', occurrence: 1 }]);
    members = [member()];
    now += 60_000;
    await check([atc({ sessionId: 3 })]);
    expect(titles().at(-1)).toContain('[2nd occurrence]');
  });

  it.each(['pending', 'unmapped'])(
    'releases the legacy occurrence of a deferred DM whose %s row is pruned, keeping sent ones', async (kind) => {
      await check([]);
      await check([atc({ sessionId: 1 })]);
      messageStatus = 429;
      await check([atc({ sessionId: 2 })]);
      await seedLegacyOccurrence(2, 2);
      expect(await occurrences()).toHaveLength(2);
      messageStatus = 200;
      if (kind === 'unmapped') {
        // The member left the server while the DM was deferred.
        members = [];
        now += 200_000;
        await check([atc({ sessionId: 2 })]);
        members = [member()];
      }
      expect((await statuses()).find((row) => row.session_key === '600001:2')).toMatchObject({ status: kind });
      now += 8 * 86_400_000;
      await check([]);
      expect((await statuses()).map((row) => row.session_key)).toEqual(['600001:1']);
      expect(await occurrences()).toEqual([{ session_key: '600001:1', occurrence: 1 }]);
      now += 60_000;
      await check([atc({ sessionId: 3 })]);
      expect(titles().at(-1)).toContain('[2nd occurrence]');
    },
  );

  it.each([[200, 'sent', true], [403, 'failed', false], [500, 'failed', true]] as const)(
    'classifies an oversized HTTP %i reply to the DM message as %s', async (status, outcome, counted) => {
      await check([]);
      const original = network.getMockImplementation()!;
      network.mockImplementation(async (input, init) => {
        if (String(input).endsWith(`/channels/${CHANNEL}/messages`)) {
          sent.push(JSON.parse(String(init?.body)));
          return new Response('x'.repeat(4 * 1024 * 1024 + 1), { status });
        }
        return original(input, init);
      });
      await check([atc()]);
      expect(sent).toHaveLength(1);
      expect((await statuses())[0]).toMatchObject({ status: outcome, attempts: 1 });
      expect(await occurrences()).toHaveLength(counted ? 1 : 0);
      now += 3_600_000;
      await check([atc()]);
      expect(sent).toHaveLength(1);
    },
  );

  it('caps a huge Retry-After on the member-list lookup at one hour', async () => {
    await check([]);
    const original = network.getMockImplementation()!;
    let lookups = 0;
    network.mockImplementation(async (input, init) => {
      if (String(input).includes('/members?')) {
        lookups++;
        if (lookups === 1) return new Response('{}', { status: 503, headers: { 'retry-after': '1000000000' } });
      }
      return original(input, init);
    });
    await expect(check([atc()])).rejects.toThrow('Discord status 503');
    const stored = await runInDurableObject(stub(), (_instance, ctx) => ctx.storage.get<number>('gca-member-list-backoff-v1'));
    expect(stored).toBe(now + 3_600_000);
    now += 3_599_000;
    await check([atc()]);
    expect(lookups).toBe(1);
    now += 1_000;
    await check([atc()]);
    expect(lookups).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it('ignores a stored reminder backoff beyond the one-hour cap', async () => {
    await check([]);
    await runInDurableObject(stub(), async (_instance, ctx) => {
      await ctx.storage.put('gca-discord-backoff-v1', now + 1e12);
      await ctx.storage.put('gca-member-list-backoff-v1', now + 3_600_001);
    });
    await check([atc()]);
    expect(sent).toHaveLength(1);
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

  it('only attempts a duplicated session once per poll, without bypassing its own retry_at afterward', async () => {
    await check([]);
    openStatus = 500; // transient failure before reservation
    await check([atc(), atc({ callsign: 'QESS_APP' })]);
    expect(sent).toHaveLength(0);
    expect(network.mock.calls.filter(([url]) => String(url).endsWith('/users/@me/channels'))).toHaveLength(1);
    expect((await statuses())[0]).toMatchObject({ status: 'pending', attempts: 1 });
    openStatus = 200;
    // Still within the 60s retry delay: appearing twice in this response must
    // not let the second copy ignore retry_at and resend early with a stale
    // attempts count.
    await check([atc(), atc({ callsign: 'QESS_APP' })]);
    expect(sent).toHaveLength(0);
    now += 60_000;
    await check([atc()]);
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
    const warn = vi.spyOn(console, 'warn');
    listStatus = status;
    await expect(check([atc()])).rejects.toThrow('Discord status');
    expect(sent).toHaveLength(0);
    expect(logged(warn, 'gca_member_list_failed')).toEqual([{ event: 'gca_member_list_failed', reason: 'http', status }]);
    listStatus = 200;
    // No Retry-After: backs off the five-minute floor, not the 60 s default.
    now += 60_000;
    await check([atc()]);
    expect(sent).toHaveLength(0);
    now += 4 * 60_000;
    await check([atc()]);
    expect(sent).toHaveLength(1);
  });

  it('does not repeat a member-list lookup rejected with 403 twice within five minutes', async () => {
    await check([]);
    const warn = vi.spyOn(console, 'warn');
    const lookups = () => network.mock.calls.filter(([url]) => String(url).includes('/members?')).length;
    const before = lookups();
    listStatus = 403;
    await expect(check([atc()])).rejects.toThrow('Discord status 403');
    for (let i = 0; i < 4; i++) {
      now += 60_000;
      await check([atc()]);
    }
    now += 59_000;
    await check([atc()]);
    expect(lookups() - before).toBe(1);
    now += 1_000;
    await expect(check([atc()])).rejects.toThrow('Discord status 403');
    expect(lookups() - before).toBe(2);
    now += 5 * 60_000 - 1_000;
    await check([atc()]);
    expect(lookups() - before).toBe(2);
    expect(sent).toHaveLength(0);
    expect(logged(warn, 'gca_member_list_failed')).toEqual(Array(2).fill(
      { event: 'gca_member_list_failed', reason: 'http', status: 403 }));
  });

  it('keeps the reported delay of a member-list rate limit and logs a locally deferred lookup', async () => {
    await check([]);
    const warn = vi.spyOn(console, 'warn');
    const lookups = () => network.mock.calls.filter(([url]) => String(url).includes('/members?')).length;
    // A global cooldown stored by an earlier poll defers the lookup locally.
    const before = lookups();
    await runInDurableObject(stub(), (_instance, ctx) => ctx.storage.put('discord-rate-limits-v1', { '*': now + 90_000 }));
    await expect(check([atc()])).rejects.toThrow('Discord API 429');
    expect(lookups()).toBe(before); // deferred locally: no request reached Discord
    expect(logged(warn, 'gca_member_list_failed')).toEqual([
      { event: 'gca_member_list_failed', reason: 'rate_limit', status: 429, requestMade: false }]);
    now += 89_000;
    await check([atc()]);
    expect(lookups()).toBe(before);
    now += 1_000; // the 90 s rate limit, not the five-minute floor
    await check([atc()]);
    expect(lookups()).toBe(before + 1);
    expect(sent).toHaveLength(1);
  });

  it('logs a network reason after a member-list request that never got an HTTP reply', async () => {
    await check([]);
    const warn = vi.spyOn(console, 'warn');
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (String(input).includes('/members?')) throw new Error('Synthetic connection failure');
      return original(input, init);
    });
    await expect(check([atc()])).rejects.toThrow('Synthetic connection failure');
    expect(logged(warn, 'gca_member_list_failed')).toEqual([
      { event: 'gca_member_list_failed', reason: 'network', status: 'unavailable' }]);
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

  it('shares a global reminder cooldown with public cards across restart', async () => {
    await check([]);
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/channels/${CHANNEL}/messages`)) {
        return Response.json({ retry_after: 65, global: true }, { status: 429 });
      }
      if (String(input).endsWith('/channels/100000000000000654/messages')) return Response.json({ id: '700000000000000001' });
      return original(input, init);
    });
    await check([atc()]);
    const calls = network.mock.calls.length;
    await evictDurableObject(stub());
    const publicPost = () => runInDurableObject(stub(), async (_, ctx) => {
      const limits = await DiscordRateLimits.load(ctx.storage);
      return postMessage('test-token', '100000000000000654', { title: 'Synthetic' }, undefined, undefined, limits);
    });
    now += 60_000;
    await expect(publicPost()).rejects.toMatchObject({ status: 429, requestMade: false });
    expect(network).toHaveBeenCalledTimes(calls);
    now += 5_000;
    await expect(publicPost()).resolves.toBe('700000000000000001');
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

  it('retries a 2xx DM-channel open with an unparseable body instead of dropping the reminder', async () => {
    await check([]);
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/users/@me/channels')) return new Response('not json', { status: 200 });
      return original(input, init);
    });
    await check([atc()]);
    expect(sent).toHaveLength(0);
    expect((await statuses())[0]).toMatchObject({ status: 'pending', attempts: 1 });
    network.mockImplementation(original);
    now += 60_000;
    await check([atc()]);
    expect(sent).toHaveLength(1);
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

  it('backs off and logs a fixed reason after a non-HTTP member-list failure, instead of retrying every poll', async () => {
    await check([]);
    const warn = vi.spyOn(console, 'warn');
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (String(input).includes('/members?')) return Response.json({ not: 'an array of members' });
      return original(input, init);
    });
    await expect(check([atc()])).rejects.toThrow('Invalid Discord member list');
    expect(logged(warn, 'gca_member_list_failed')).toEqual([{ event: 'gca_member_list_failed', reason: 'invalid', status: 'unavailable' }]);
    const calls = network.mock.calls.length;
    await check([atc({ sessionId: 2 })]);
    expect(network).toHaveBeenCalledTimes(calls); // still backed off, no repeated member-list lookup
  });

  it('does not back off the member-list lookup merely because it ran out of the poll deadline', async () => {
    await check([]);
    // A full page (1000 entries) keeps fetchMembers paginating; the mock
    // pushes the clock past the poll deadline before the next page's check.
    const fullPage: GuildMember[] = Array.from({ length: 1000 }, (_, i) =>
      member(700000 + i, String(400000000000000000n + BigInt(i))));
    const original = network.getMockImplementation()!;
    let memberListCalls = 0;
    network.mockImplementation(async (input, init) => {
      if (String(input).includes('/members?')) {
        memberListCalls++;
        now += 30_000; // exceeds the 25s poll deadline before the loop rechecks it
        return Response.json(fullPage);
      }
      return original(input, init);
    });
    await expect(check([atc()])).rejects.toThrow('Discord member lookup exceeded poll budget');
    expect(memberListCalls).toBe(1);
    // Not backed off: the very next poll retries the lookup immediately
    // instead of waiting out a multi-minute Discord-failure cooldown.
    await expect(check([atc({ sessionId: 2 })])).rejects.toThrow('Discord member lookup exceeded poll budget');
    expect(memberListCalls).toBe(2);
  });

  it('backs off a member-list lookup that runs out of the poll deadline twice in a row', async () => {
    await check([]);
    const warn = vi.spyOn(console, 'warn');
    const fullPage: GuildMember[] = Array.from({ length: 1000 }, (_, i) =>
      member(700000 + i, String(400000000000000000n + BigInt(i))));
    const original = network.getMockImplementation()!;
    let memberListCalls = 0;
    let slow = true;
    network.mockImplementation(async (input, init) => {
      if (String(input).includes('/members?')) {
        memberListCalls++;
        if (slow) {
          now += 30_000;
          return Response.json(fullPage);
        }
      }
      return original(input, init);
    });
    await expect(check([atc()])).rejects.toThrow('exceeded poll budget');
    await expect(check([atc()])).rejects.toThrow('exceeded poll budget');
    expect(logged(warn, 'gca_member_list_failed')).toEqual(Array(2).fill(
      { event: 'gca_member_list_failed', reason: 'deadline', status: 'unavailable' }));
    // The third poll skips the lookup instead of spending its budget again.
    await check([atc()]);
    expect(memberListCalls).toBe(2);
    now += 5 * 60_000;
    slow = false;
    await check([atc()]);
    expect(memberListCalls).toBe(3);
    expect(sent).toHaveLength(1);
    // A success resets the count: the next slow lookup is retried at once again.
    slow = true;
    await expect(check([atc({ sessionId: 2 })])).rejects.toThrow('exceeded poll budget');
    await expect(check([atc({ sessionId: 2 })])).rejects.toThrow('exceeded poll budget');
    expect(memberListCalls).toBe(5);
  });

  it('logs a page_limit reason for a server with more than 10,000 members', async () => {
    await check([]);
    const warn = vi.spyOn(console, 'warn');
    const original = network.getMockImplementation()!;
    let memberListCalls = 0;
    network.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/members?')) {
        memberListCalls++;
        const after = BigInt(new URL(url).searchParams.get('after')!);
        const first = after === 0n ? 400000000000000000n : after + 1n;
        return Response.json(Array.from({ length: 1000 }, (_, i) =>
          ({ user: { id: String(first + BigInt(i)) }, nick: null, roles: [] })));
      }
      return original(input, init);
    });
    await expect(check([atc()])).rejects.toThrow('Discord member list exceeded page limit');
    expect(memberListCalls).toBe(10);
    expect(sent).toHaveLength(0);
    expect(logged(warn, 'gca_member_list_failed')).toEqual([{ event: 'gca_member_list_failed', reason: 'page_limit', status: 'unavailable' }]);
  });

  it('re-baselines sessions discovered after a long gap instead of warning them immediately', async () => {
    await check([]);
    await check([atc()]);
    expect(sent).toHaveLength(1);
    await evictDurableObject(stub());
    now += 20 * 60_000; // well past a normal retry/backoff delay
    await check([atc({ sessionId: 2, callsign: 'XFAA_APP' })]);
    expect(sent).toHaveLength(1); // the newly-discovered session was baselined, not warned
    expect((await statuses()).find((row) => row.session_key === '600001:2')).toMatchObject({ status: 'baseline' });
    now += 60_000;
    await check([atc({ sessionId: 2, callsign: 'XFAA_APP' })]);
    expect(sent).toHaveLength(1); // a baselined session never warns, even once settled in
  });

  it('re-baselines new sessions after an upgrade from a version without a last-active record', async () => {
    await check([]);
    await runInDurableObject(stub(), (_instance, ctx) => ctx.storage.delete('gca-last-active-v1'));
    const log = vi.spyOn(console, 'log');
    await check([atc()]);
    expect(network).not.toHaveBeenCalled();
    expect((await statuses())[0]).toMatchObject({ status: 'baseline' });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'gca_rebaselined', sessions: 1 }));
    now += 60_000;
    await check([atc(), atc({ sessionId: 2 })]);
    expect(sent).toHaveLength(1);
    expect((await statuses()).map((row) => [row.session_key, row.status])).toEqual([
      ['600001:123456', 'baseline'], ['600001:2', 'sent']]);
  });

  it('logs whether a rate-limited DM reached Discord or was deferred locally', async () => {
    await check([]);
    const warn = vi.spyOn(console, 'warn');
    messageStatus = 500;
    await check([atc({ sessionId: 1 })]);
    messageStatus = 429;
    await check([atc({ sessionId: 2 })]);
    // The route cooldown now defers this one without contacting Discord.
    await check([atc({ sessionId: 3 })]);
    expect(sent).toHaveLength(2);
    expect(logged(warn, 'gca_dm_failed')).toEqual([
      { event: 'gca_dm_failed', status: 500, retry: false },
      { event: 'gca_dm_failed', status: 429, retry: true, reason: 'rate_limit', requestMade: true },
      { event: 'gca_dm_failed', status: 429, retry: true, reason: 'rate_limit', requestMade: false },
    ]);
  });

  it('defers a DM locally after an exhausted-bucket reply, without counting it', async () => {
    await check([]);
    const warn = vi.spyOn(console, 'warn');
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/channels/${CHANNEL}/messages`)) {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ id: '300000000000000002' },
          { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '30' } });
      }
      return original(input, init);
    });
    await check([atc({ sessionId: 1 }), atc({ sessionId: 2 })]);
    expect(sent).toHaveLength(1);
    expect(logged(warn, 'gca_dm_failed')).toEqual([
      { event: 'gca_dm_failed', status: 429, retry: true, reason: 'soft', requestMade: false }]);
    expect((await statuses()).find((row) => row.session_key === '600001:2')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await occurrences()).toEqual([{ session_key: '600001:1', occurrence: 1 }]);
    now += 30_000;
    await check([atc({ sessionId: 1 }), atc({ sessionId: 2 })]);
    expect(titles()).toHaveLength(2);
    expect(titles()[1]).toContain('[2nd occurrence]');
  });

  it('does not let a single DM route\'s rate limit widen the shared backoff the way a global one does', async () => {
    await check([]);
    messageStatus = 429; // route-scoped: the mocked body carries no `global` flag
    await check([atc()]);
    expect(sent).toHaveLength(1); // attempted, but rejected
    // A different member has their own DM channel, so this route-scoped 429
    // must never bleed into it.
    const OTHER_CHANNEL = '999999999999999999';
    const OTHER_USER = '600000000000000002';
    members = [member(), member(600002, OTHER_USER)];
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/users/@me/channels') && JSON.parse(String(init?.body)).recipient_id === OTHER_USER) {
        return Response.json({ id: OTHER_CHANNEL, type: 1, recipients: [{ id: OTHER_USER }] });
      }
      if (url.endsWith(`/channels/${OTHER_CHANNEL}/messages`)) {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ id: '700000000000000002' });
      }
      return original(input, init);
    });
    // No time advance: a global (or member-list) rate limit would still gate
    // the very next poll and skip it before even considering this other member.
    await check([atc({ userId: 600002, sessionId: 2 })]);
    expect(sent).toHaveLength(2);
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

  it.each([
    [429, { status: 429, retry: true, reason: 'rate_limit', requestMade: true }],
    [500, { status: 500, retry: false }],
  ] as const)('logs a failed %i copy with rate-limit detail only when rate-limited', async (status, expected) => {
    await check([], config());
    const warn = vi.spyOn(console, 'warn');
    copyStatus = status;
    await check([atc()], config());
    expect(logged(warn, 'gca_copy_failed')).toEqual([{ event: 'gca_copy_failed', ...expected }]);
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

  it('lets cleanup remove an unsent copy left for a previous staff account, keeping the ledgers', async () => {
    const NEXT_STAFF = '444444444444444444';
    await check([], config());
    copyOpenStatus = 500;
    await check([atc()], config());
    await runInDurableObject(stub(), (_, ctx) => {
      // The configured account still receives its retry: nothing is stale.
      expect(cleanupGcaCopies(ctx.storage, true, now, COPY_USER).deleted).toBe(0);
      expect(cleanupGcaCopies(ctx.storage, false, now, NEXT_STAFF)).toMatchObject({ eligible: 1, deleted: 0 });
      expect(cleanupGcaCopies(ctx.storage, true, now, NEXT_STAFF).deleted).toBe(1);
      expect(ctx.storage.sql.exec('SELECT * FROM gca_copies').toArray()).toHaveLength(0);
    });
    copyOpenStatus = 200;
    now += 300_000;
    await check([atc()], config());
    expect(copies).toHaveLength(0);
    expect(sent).toHaveLength(1);
    await check([atc({ sessionId: 123457 })], config());
    expect(sent).toHaveLength(2);
    expect(titles()[1]).toContain('[2nd occurrence]');
  });

  it('does not let a route-scoped member-list 429 block a same-poll pending staff copy', async () => {
    await check([], config());
    copyStatus = 429; // route-scoped: the mocked body carries no `global` flag
    await check([atc()], config());
    expect(sent).toHaveLength(1);
    expect(copies).toHaveLength(1); // attempted, but rejected — stays pending
    now += 200_000; // past the copy's own retry_at
    copyStatus = 200;
    listStatus = 429; // also route-scoped: no `global` flag on the member-list response
    await expect(check([atc({ sessionId: 2 })], config())).rejects.toThrow('Discord API 429');
    // A route-scoped member-list failure must not widen the shared backoff
    // that gates unrelated staff copies: the pending copy still flushes.
    expect(copies).toHaveLength(2);
  });

  it('records a 2xx response with a missing id as sent, not failed, and still queues a copy', async () => {
    await check([], config());
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/channels/${CHANNEL}/messages`)) {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({}, { status: 200 }); // 2xx, but no `id`
      }
      return original(input, init);
    });
    await check([atc()], config());
    expect(sent).toHaveLength(1);
    expect((await statuses())[0]).toMatchObject({ status: 'sent', attempts: 1 });
    await check([], config());
    expect(copies).toHaveLength(1);
  });

  it('records a 2xx response with an empty, non-JSON body as sent, not failed, and still queues a copy', async () => {
    await check([], config());
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/channels/${CHANNEL}/messages`)) {
        sent.push(JSON.parse(String(init?.body)));
        return new Response('', { status: 200 }); // 2xx, empty body: response.json() would throw
      }
      return original(input, init);
    });
    await check([atc()], config());
    expect(sent).toHaveLength(1);
    expect((await statuses())[0]).toMatchObject({ status: 'sent', attempts: 1 });
    await check([], config());
    expect(copies).toHaveLength(1); // staff copy still queued, not skipped as a failure
  });
});
