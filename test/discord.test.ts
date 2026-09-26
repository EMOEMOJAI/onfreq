import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLOR_ENDED, COLOR_OFFLINE, COLOR_ONLINE, parseFirLabels } from '../src/config';
import {
  buildOfflineEmbed,
  buildOnlineEmbed,
  buildOnlineEmbeds,
  buildSessionEndedEmbed,
  DiscordApiError,
  DiscordInvalidMessageIdError,
  DiscordResponseTooLargeError,
  DiscordUnconfirmedPostError,
  deleteMessage,
  escapeMarkdown,
  findBotMessages,
  formatRoster,
  MAX_ROSTER_CONTINUATION_PAGES,
  editMessage,
  formatDuration,
  formatFrequency,
  messageNonce,
  parseChannelIds,
  postMessage,
} from '../src/discord';
import { DiscordRateLimits } from '../src/discord-rate-limit';
import { countsAgainstBudget, type OfflineEvent, type OnlineAtc, type TrackedAtc } from '../src/types';

/** Any unpaired UTF-16 surrogate, which makes a Discord payload invalid text. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Fictional callsign prefixes and a geographically mixed display fixture.
const LABELS = parseFirLabels(JSON.stringify([
  { prefixes: ['XA'], flag: '🇦🇺', name: 'Australia' },
  { prefixes: ['QC', 'QD'], flag: '🇧🇷', name: 'Brazil' },
  { prefixes: ['QE'], flag: '🇨🇦', name: 'Canada' },
  { prefixes: ['QG'], flag: '🇫🇷', name: 'France' },
  { prefixes: ['QH'], flag: '🇸🇪', name: 'Sweden' },
]));

const NOW = '2026-08-16T12:00:00.000Z';

const sample: TrackedAtc = {
  sessionId: 1,
  userId: 600003,
  callsign: 'XAHH_TWR',
  frequency: 118.2,
  position: 'TWR',
  station: 'Australia Tower',
  location: 'Australia Intl',
  since: '2026-08-16T10:00:00.000Z',
  missed: 0,
};

describe('formatting', () => {
  it('formats frequencies with three decimals', () => {
    expect(formatFrequency(118.2)).toBe('118.200 MHz');
    expect(formatFrequency(121.775)).toBe('121.775 MHz');
  });

  it('never renders the not-tuned-yet 0.000 placeholder as a frequency', () => {
    expect(formatFrequency(0)).toBe('freq pending');
    expect(formatFrequency(Number.NaN)).toBe('freq pending');
  });

  it('formats durations humanly', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(300)).toBe('5m');
    expect(formatDuration(3700)).toBe('1h 1m');
  });
});

describe('parseChannelIds', () => {
  it('parses a comma-separated list, trimming blanks', () => {
    expect(parseChannelIds('100000000000000123, 100000000000000456 ,,10000000000000000789'))
      .toEqual(['100000000000000123', '100000000000000456', '10000000000000000789']);
    expect(parseChannelIds('100000000000000123')).toEqual(['100000000000000123']);
  });

  it('skips entries that are not snowflakes and logs only a count, never the value', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(parseChannelIds('100000000000000123,../../guilds/1,123,1000000000000000000000,chan nel'))
        .toEqual(['100000000000000123']);
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toEqual({ event: 'config_invalid', reason: 'discord_channel_ids', count: 4 });
      expect(line).not.toContain('guilds');
      expect(parseChannelIds('100000000000000123')).toHaveLength(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('returns an empty list when unset', () => {
    expect(parseChannelIds(undefined)).toEqual([]);
    expect(parseChannelIds(' ')).toEqual([]);
  });
});

const endedEvent: OfflineEvent = {
  ...sample,
  missed: 2,
  endedAt: NOW,
  durationSeconds: 7200,
};

describe('embeds', () => {
  const airport = { icao: 'XAHH', iata: 'XXX', city: 'Australia', countryId: 'AU' };
  const detailed = { ...sample, airport, memberCountry: { countryId: 'BR', expiresAt: 1 } };

  it('keeps station region separate from the member profile country on all card types', () => {
    const event = { ...endedEvent, ...detailed };
    for (const embed of [buildOnlineEmbed(detailed, undefined, LABELS), buildSessionEndedEmbed(event, LABELS), buildOfflineEmbed(event, LABELS)]) {
      expect(embed.title).toContain('🇦🇺 XAHH_TWR');
      expect(embed.fields?.some((field) => field.name === 'Country/region')).toBe(false);
      expect(embed.fields?.some((field) => field.name === 'Airport')).toBe(false);
      expect(embed.fields).toContainEqual({ name: 'Controller', value: 'VID 600003 · Brazil', inline: true });
      expect(embed.fields?.some((field) => field.name === 'Member country')).toBe(false);
    }
    expect(buildSessionEndedEmbed(event, LABELS).fields?.some((field) => field.name.startsWith('Online at'))).toBe(false);
  });

  it('shows only tuned positions at the same airport, deduplicated in operational order', () => {
    const current = [
      detailed,
      other('XAHH_N_GND', { airport }),
      other('XAHH_S_GND', { airport }),
      other('XAHH_DEL', { airport, position: 'DEL', frequency: 0 }),
      other('XAHH_APP', { airport, position: 'APP' }),
      other('XBMC_TWR', { airport: { ...airport, icao: 'XBMC' }, position: 'TWR' }),
      other('XAHK_CTR', { position: 'CTR' }),
    ];
    expect(buildOnlineEmbed(detailed, current, LABELS).fields).toContainEqual({
      name: 'Online at XAHH', value: '✅ GND · ✅ TWR · ✅ APP', inline: false,
    });
    expect(buildOnlineEmbed(detailed, [], LABELS).fields).toContainEqual({
      name: 'Online at XAHH', value: 'No positions reported online', inline: false,
    });
  });

  it('handles absent metadata without inventing an airport or a member country', () => {
    const embed = buildOnlineEmbed({ ...sample, callsign: 'XAHK_CTR', position: 'CTR' }, undefined, LABELS);
    expect(embed.title).toBe('🟢 🇦🇺 XAHK_CTR is now ONLINE');
    expect(embed.fields?.some((field) => ['Airport', 'Member country'].includes(field.name))).toBe(false);
    expect(embed.fields).toContainEqual({ name: 'Controller', value: 'VID 600003', inline: true });
    expect(embed.fields?.some((field) => field.name.startsWith('Online at'))).toBe(false);
    expect(buildOnlineEmbed({ ...detailed, memberCountry: { countryId: 'invalid', expiresAt: 1 } }, undefined, LABELS).fields)
      .toContainEqual({ name: 'Controller', value: 'VID 600003', inline: true });
  });

  it('builds a green online embed with the callsign and frequency', () => {
    const embed = buildOnlineEmbed(sample, undefined, LABELS);
    expect(embed.title).toContain('XAHH_TWR');
    expect(embed.color).toBe(COLOR_ONLINE);
    expect(embed.description).toContain('Australia Tower');
    expect(embed.fields?.map((f) => f.value)).toContain('118.200 MHz');
    expect(embed.timestamp).toBe(sample.since);
  });

  it('marks an unapproved GCA mismatch red, including the member country', () => {
    const embed = buildOnlineEmbed(detailed, undefined, LABELS, true);
    expect(embed.color).toBe(COLOR_OFFLINE);
    expect(embed.title).toContain('🔴');
    expect(embed.fields).toContainEqual({
      name: 'Controller', value: 'VID 600003 · 🔴 Brazil', inline: true,
    });
  });

  it('marks the online embed with a client-side relative timestamp', () => {
    const embed = buildOnlineEmbed(sample, undefined, LABELS);
    expect(embed.description).toContain(`<t:${Date.parse(sample.since) / 1000}:R>`);
  });

  it('builds a grey session-ended embed carrying the duration', () => {
    const embed = buildSessionEndedEmbed(endedEvent, LABELS);
    expect(embed.title).toContain('⚪');
    expect(embed.title).toContain('XAHH_TWR');
    expect(embed.title).toContain('OFFLINE');
    expect(embed.color).toBe(COLOR_ENDED);
    expect(embed.description).toContain('Was online for **2h 0m**');
    expect(embed.timestamp).toBe(NOW);
  });

  it('shows the session window in the ended embed', () => {
    const embed = buildSessionEndedEmbed(endedEvent, LABELS);
    const session = embed.fields?.find((f) => f.name === 'Session')?.value;
    expect(session).toBe(
      `<t:${Date.parse(sample.since) / 1000}:t> → <t:${Date.parse(NOW) / 1000}:t>`,
    );
  });

  it('builds a red standalone offline embed for the fallback path', () => {
    const embed = buildOfflineEmbed(endedEvent, LABELS);
    expect(embed.title).toContain('XAHH_TWR');
    expect(embed.color).toBe(COLOR_OFFLINE);
    expect(embed.fields?.map((f) => f.value)).toContain('2h 0m');
  });

  it('escapes IVAO-supplied markdown in the station/location line so it cannot break embed formatting', () => {
    const embed = buildOnlineEmbed(
      { ...sample, station: '*Evil* __Tower__', location: '`injected` [link](http://example.test)' },
      undefined, LABELS,
    );
    expect(embed.description).toContain('\\*Evil\\* \\_\\_Tower\\_\\_');
    expect(embed.description).toContain('\\`injected\\` \\[link\\](http:\\/\\/example.test)');
    expect(embed.description).not.toContain('**Evil**');
  });

  it('breaks bare URL autolinks while keeping the text readable', () => {
    expect(escapeMarkdown('Visit https://phish.example.test/login'))
      .toBe('Visit https:\\/\\/phish.example.test/login');
    expect(escapeMarkdown('a://b and c://d')).toBe('a:\\/\\/b and c:\\/\\/d');
    expect(escapeMarkdown('Tower 118.100')).toBe('Tower 118.100');
  });

  it.each([
    ['# Fake header', '\\# Fake header'],
    ['-# Fake subtext', '\\-# Fake subtext'],
    ['- fake list item', '\\- fake list item'],
    ['  # indented header', '  \\# indented header'],
    ['\n# header after newline', ' \\# header after newline'],
  ])('escapes a leading header or list marker in %j', (input, expected) => {
    expect(escapeMarkdown(input)).toBe(expected);
  });

  it('keeps a mid-text # or - as is', () => {
    expect(escapeMarkdown('Gate #3 - North')).toBe('Gate #3 - North');
  });

  it('removes bidi overrides and zero-width characters', () => {
    expect(escapeMarkdown('Safe\u202Eevil\u202C Tower\u200B\u2066\u200D')).toBe('Safeevil Tower');
    expect(escapeMarkdown('\u200B# hidden header')).toBe('\\# hidden header');
    expect(escapeMarkdown('http:\u200B//hidden.example.test')).toBe('http:\\/\\/hidden.example.test');
  });

  it('escapes angle brackets so an IVAO-supplied role mention cannot ping', () => {
    const embed = buildOnlineEmbed({ ...sample, station: '<@&123>' }, undefined, LABELS);
    expect(embed.description).toContain('\\<@&123\\>');
    expect(embed.description).not.toContain('<@&123>');
  });

  it('collapses embedded newlines to a single space instead of adding embed lines', () => {
    expect(escapeMarkdown('line one\nline two\r\nline three')).toBe('line one line two line three');
  });

  it('collapses Unicode line and paragraph separators like newlines', () => {
    expect(escapeMarkdown('row one\u2028QXXX_TWR fake\u2029\u2028row three')).toBe('row one QXXX_TWR fake row three');
    expect(escapeMarkdown('\u2028# header after separator')).toBe(' \\# header after separator');
  });

  it.each([
    ['1. fake item', '1\\. fake item'],
    ['  12. indented item', '  12\\. indented item'],
    ['\n3.\tafter newline', ' 3\\.\tafter newline'],
  ])('escapes a leading ordered-list marker in %j', (input, expected) => {
    expect(escapeMarkdown(input)).toBe(expected);
  });

  it.each(['118.100 MHz', '1.5 nm', 'Runway 1. North', '1.'])('leaves %j without a list marker as is', (text) => {
    expect(escapeMarkdown(text)).toBe(text);
  });
});

function other(callsign: string, over: Partial<OnlineAtc> = {}): OnlineAtc {
  return {
    sessionId: 2,
    userId: 500,
    callsign,
    frequency: 121.7,
    position: 'GND',
    station: `${callsign} Ground`,
    location: null,
    ...over,
  };
}

describe('also-online roster', () => {
  it('renders nothing when no one else is online', () => {
    expect(formatRoster([], LABELS)).toBeUndefined();
  });

  it('strips backticks from roster cells so they cannot prematurely close the code block', () => {
    const text = formatRoster([other('QCTT_GND', { station: '``` @everyone' })], LABELS) ?? '';
    // Only the opening and closing code fences remain; the injected backticks are gone.
    expect(text.split('```').length - 1).toBe(2);
    expect(text).toContain("''' @everyone");
  });

  it('omits controllers that have not tuned a frequency yet', () => {
    expect(formatRoster([other('QESS_APP', { frequency: 0 })], LABELS)).toBeUndefined();
    const mixed = formatRoster([other('QESS_APP', { frequency: 0 }), other('QCTT_GND')], LABELS);
    expect(mixed).toContain('QCTT_GND');
    expect(mixed).not.toContain('QESS_APP');
  });

  it('wraps the roster in a code block so the columns line up', () => {
    const text = formatRoster([other('QCTT_GND')], LABELS) ?? '';
    expect(text.startsWith('```\n')).toBe(true);
    expect(text.endsWith('\n```')).toBe(true);
  });

  it('groups by FIR with a flag, and sorts stations by callsign', () => {
    const text = formatRoster([
      other('QGLL_TWR', { station: 'Example West Tower' }),
      other('QESS_APP', { station: 'Example North Approach' }),
      other('QESI_TWR', { station: 'Example East Tower' }),
    ], LABELS) ?? '';
    const rows = text.split('\n').slice(1, -1);

    expect(rows[0]).toContain('🇨🇦');
    expect(rows[0]).toContain('Canada');
    expect(rows[0]).toContain('QESI_TWR');
    // Second Canadian station: indented, no repeated FIR label.
    expect(rows[1]).toContain('QESS_APP');
    expect(rows[1]).not.toContain('Canada');
    expect(rows[1]?.startsWith('   ')).toBe(true);
    expect(rows[2]).toContain('🇫🇷');
    expect(rows[2]).toContain('France');
  });

  it('orders FIR groups alphabetically', () => {
    const text = formatRoster([other('QHTS_TWR'), other('QCTT_GND'), other('QESS_APP')], LABELS) ?? '';
    const names = text.split('\n').slice(1, -1).map((r) => r.trim().split(/\s{2,}/)[0]);
    expect(names.map((n) => n?.replace(/^\S+\s/, ''))).toEqual(['Brazil', 'Canada', 'Sweden']);
  });

  it('aligns the callsign column across groups', () => {
    const text = formatRoster([other('QCTT_GND'), other('QESS_APP')], LABELS) ?? '';
    const rows = text.split('\n').slice(1, -1);
    const cols = rows.map((r) => r.indexOf('Q', 4));
    expect(new Set(cols).size).toBe(1);
  });

  it('falls back to a neutral marker for an unmapped prefix', () => {
    const text = formatRoster([other('KJFK_TWR')], LABELS) ?? '';
    expect(text).toContain('🌐');
    expect(text).toContain('Other');
  });

  it('never splits a surrogate pair when cutting a long station name to the column width', () => {
    // 21 ASCII units then an astral character spanning units 21-22 of the 22-unit column.
    const station = `${'A'.repeat(21)}\u{1F600}${'B'.repeat(10)}`;
    const text = formatRoster([other('QCTT_GND', { station })], LABELS) ?? '';
    expect(text).not.toMatch(LONE_SURROGATE);
    expect(text).toContain(`${'A'.repeat(21)} `);
    const kept = formatRoster([other('QCTT_GND', { station: `${'A'.repeat(20)}\u{1F600}${'B'.repeat(10)}` })], LABELS) ?? '';
    expect(kept).toContain(`${'A'.repeat(20)}\u{1F600}`);
    expect(kept).not.toMatch(LONE_SURROGATE);
  });

  it('shows every station when more than ten are online', () => {
    const many = Array.from({ length: 14 }, (_, i) => other(`QE0${i}_TWR`));
    const text = formatRoster(many, LABELS) ?? '';
    const rows = text.split('\n').slice(1, -1);
    expect(rows).toHaveLength(many.length);
    for (const atc of many) expect(text).toContain(atc.callsign);
    expect(text).not.toContain('more');
    expect(text).not.toContain('/atc');
  });

  it('keeps the complete roster in valid code blocks across multiple embed fields', () => {
    const many = [
      other('QCTT_GND'),
      ...Array.from({ length: 40 }, (_, i) => other(`QE${String(i).padStart(2, '0')}_TWR`, {
        station: 'A long station name that fills the station column',
      })),
      other('QHTS_TWR'),
    ];
    const [embed] = buildOnlineEmbeds(sample, many, undefined, LABELS);
    const fields = embed.fields?.filter((field) => field.name.startsWith('Also online')) ?? [];
    expect(fields.length).toBeGreaterThan(1);
    expect(fields[0]?.name).toBe(`Also online now (${many.length})`);

    const rows: string[] = [];
    for (const field of fields) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
      expect(field.value.startsWith('```\n')).toBe(true);
      expect(field.value.endsWith('\n```')).toBe(true);
      expect(field.inline).toBe(false);
      rows.push(...field.value.split('\n').slice(1, -1));
    }
    expect(rows).toHaveLength(many.length);
    for (const atc of many) {
      expect(rows.filter((row) => row.includes(atc.callsign))).toHaveLength(1);
    }
    expect(['```', ...rows, '```'].join('\n')).toBe(formatRoster(many, LABELS));
  });

  it.each([100, 400, 900])('delivers all %i stations within every message limit', (count) => {
    const many = Array.from({ length: count }, (_, i) => other(`QE${String(i).padStart(2, '0')}_TWR`, {
      station: 'Regional Approach Area',
    }));
    const pages = buildOnlineEmbeds(sample, many, undefined, LABELS);
    expect(pages.length).toBeGreaterThan(1);
    const rows: string[] = [];
    for (const page of pages) {
      const fields = page.fields ?? [];
      expect(fields.length).toBeLessThanOrEqual(25);
      const text = [page.title ?? '', page.description ?? '', page.footer?.text ?? '',
        ...fields.flatMap((field) => [field.name, field.value])].join('');
      expect(text.length).toBeLessThanOrEqual(6000);
      for (const field of fields) {
        expect(field.name.length).toBeLessThanOrEqual(256);
        expect(field.value.length).toBeLessThanOrEqual(1024);
        if (field.name.startsWith('Also online')) {
          expect(field.value.startsWith('```\n')).toBe(true);
          expect(field.value.endsWith('\n```')).toBe(true);
          rows.push(...field.value.split('\n').slice(1, -1));
        }
      }
    }
    expect(rows).toHaveLength(count);
    expect(['```', ...rows, '```'].join('\n')).toBe(formatRoster(many, LABELS));
  });

  it.each([2000, 20_000])('caps continuation pages for an anomalous %i-station roster', (count) => {
    const many = Array.from({ length: count }, (_, i) => other(`QE${String(i).padStart(2, '0')}_TWR`, {
      station: 'Regional Approach Area',
    }));
    const pages = buildOnlineEmbeds(sample, many, undefined, LABELS);
    expect(pages).toHaveLength(1 + MAX_ROSTER_CONTINUATION_PAGES);
    const fields = pages.flatMap((page) => page.fields ?? []).filter((field) => field.name.startsWith('Also online'));
    // The label still reports every tuned station; delivered rows are a prefix of the roster.
    expect(fields[0]?.name).toBe(`Also online now (${count})`);
    const rows = fields.flatMap((field) => field.value.split('\n').slice(1, -1));
    expect(rows.length).toBeLessThan(count);
    const all = (formatRoster(many, LABELS) ?? '').split('\n').slice(1, -1);
    expect(rows).toEqual(all.slice(0, rows.length));
  });

  it('is absent from the online embed by default', () => {
    const embed = buildOnlineEmbed(sample, undefined, LABELS);
    expect(embed.fields?.some((f) => f.name.startsWith('Also online'))).toBe(false);
  });

  it('is added to the online embed when others are passed', () => {
    const [embed] = buildOnlineEmbeds(sample, [other('QCTT_GND'), other('QESS_APP')], undefined, LABELS);
    const field = embed.fields?.find((f) => f.name.startsWith('Also online'));
    expect(field?.name).toBe('Also online now (2)');
    expect(field?.value).toContain('QCTT_GND');
    expect(field?.inline).toBe(false);
  });

  it('counts only tuned stations in the field label', () => {
    const [embed] = buildOnlineEmbeds(sample, [other('QCTT_GND'), other('QESS_APP', { frequency: 0 })], undefined, LABELS);
    expect(embed.fields?.find((f) => f.name.startsWith('Also online'))?.name).toBe(
      'Also online now (1)',
    );
  });

  it('puts a blank spacer field above the roster', () => {
    const [embed] = buildOnlineEmbeds(sample, [other('QCTT_GND')], undefined, LABELS);
    const names = embed.fields?.map((f) => f.name) ?? [];
    const rosterAt = names.findIndex((n) => n.startsWith('Also online'));
    expect(rosterAt).toBeGreaterThan(0);
    expect(names[rosterAt - 1]).toBe('\u200b');
    expect(embed.fields?.[rosterAt - 1]?.value).toBe('\u200b');
  });

  it('adds no spacer when there is no roster', () => {
    const embed = buildOnlineEmbed(sample, undefined, LABELS);
    expect(embed.fields?.some((f) => f.name === '\u200b')).toBe(false);
  });

  it('never appears on the grey session-ended card', () => {
    const embed = buildSessionEndedEmbed(endedEvent, LABELS);
    expect(embed.fields?.some((f) => f.name.startsWith('Also online'))).toBe(false);
  });
});

describe('messageNonce', () => {
  it('is deterministic for the same session and channel', () => {
    expect(messageNonce('session-1', 'channel-1')).toBe(messageNonce('session-1', 'channel-1'));
  });

  it('differs across sessions and channels', () => {
    expect(messageNonce('session-1', 'channel-1')).not.toBe(messageNonce('session-2', 'channel-1'));
    expect(messageNonce('session-1', 'channel-1')).not.toBe(messageNonce('session-1', 'channel-2'));
  });

  it('stays within Discord\'s 25-char nonce limit', () => {
    for (const [session, channel] of [['s', 'c'], ['a-very-long-session-key-1234567890', '9999999999999999']]) {
      const nonce = messageNonce(session!, channel!);
      expect(nonce.length).toBeLessThanOrEqual(25);
      expect(nonce.length).toBeGreaterThan(0);
    }
  });
});

describe('REST calls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(...responses: Response[]) {
    const fetchMock = vi.fn();
    for (const res of responses) fetchMock.mockResolvedValueOnce(res);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('escapes markdown in callsigns and positions but keeps word-internal underscores', () => {
    const embed = buildOnlineEmbed({ ...sample, callsign: 'LE*MD_TWR', position: '<@&1>\nTWR' }, undefined, LABELS);
    expect(embed.title).toContain('LE\\*MD_TWR');
    expect(embed.fields?.find((field) => field.name === 'Position')?.value).toBe('\\<@&1\\> TWR');
  });

  it.each([
    new Response(null, { status: 200 }),
    new Response('not json', { status: 200 }),
    Response.json({}),
  ])('reports a 2xx POST without a usable id as unconfirmed', async (response) => {
    const fetchMock = stubFetch(response);
    await expect(postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, new DiscordRateLimits()))
      .rejects.toBeInstanceOf(DiscordUnconfirmedPostError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the id of the posted message', async () => {
    const fetchMock = stubFetch(Response.json({ id: '100000000000000999' }));
    const id = await postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), '<@&100000000000000777>', undefined, new DiscordRateLimits());
    expect(id).toBe('100000000000000999');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://discord.com/api/v10/channels/100000000000000123/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).content).toBe('<@&100000000000000777>');
  });

  it('allows only the configured role mention to ping, never every role', async () => {
    const fetchMock = stubFetch(Response.json({ id: '100000000000000999' }));
    await postMessage('token', '100000000000000123', { title: 'Synthetic' }, '<@&100000000000000777>', undefined, new DiscordRateLimits());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).allowed_mentions)
      .toEqual({ parse: [], roles: ['100000000000000777'], replied_user: false });
  });

  it.each([undefined, '<@&role>', '<@&123>', '@everyone', '<@&100000000000000777> <@&100000000000000778>'])(
    'lets content %j ping nobody', async (content) => {
      const fetchMock = stubFetch(Response.json({ id: '100000000000000999' }));
      await postMessage('token', '100000000000000123', { title: 'Synthetic' }, content, undefined, new DiscordRateLimits());
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).allowed_mentions)
        .toEqual({ parse: [], replied_user: false });
    });

  it('ignores listed messages whose id is not a snowflake when scanning for unseen posts', async () => {
    const botId = '100000000000000009';
    const token = `${btoa(botId)}.synthetic.token`;
    const at = 1_800_000_000_000;
    const snowflake = ((BigInt(at - 1_420_070_400_000) << 22n) + 1n).toString();
    stubFetch(Response.json([
      { id: snowflake, author: { id: botId } },
      { id: '123', author: { id: botId } },
      { id: '1'.repeat(21), author: { id: botId } },
    ]));
    await expect(findBotMessages(token, '100000000000000123', { from: at, to: at }, new DiscordRateLimits(), () => true))
      .resolves.toEqual([snowflake]);
  });

  it.each(['999', 'posted-1', '../100000000000000999', '100000000000000999/x'])(
    'treats a returned message id %j that is not a snowflake as unconfirmed', async (id) => {
      stubFetch(Response.json({ id }));
      await expect(postMessage('token', '100000000000000123', { title: 'Synthetic' }, undefined, undefined, new DiscordRateLimits()))
        .rejects.toBeInstanceOf(DiscordUnconfirmedPostError);
    });

  it('includes a nonce and enforce_nonce when a nonce is supplied', async () => {
    const fetchMock = stubFetch(Response.json({ id: '100000000000000999' }));
    await postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, new DiscordRateLimits(), 'abc123');
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.nonce).toBe('abc123');
    expect(payload.enforce_nonce).toBe(true);
  });

  it('omits nonce and enforce_nonce when no nonce is supplied', async () => {
    const fetchMock = stubFetch(Response.json({ id: '100000000000000999' }));
    await postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, new DiscordRateLimits());
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.nonce).toBeUndefined();
    expect(payload.enforce_nonce).toBeUndefined();
  });

  it('posts continuations as replies without pinging the parent author', async () => {
    const fetchMock = stubFetch(Response.json({ id: '100000000000000999' }));
    await postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, 'parent', new DiscordRateLimits());
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.message_reference).toEqual({ message_id: 'parent', fail_if_not_exists: false });
    expect(payload.allowed_mentions.replied_user).toBe(false);
    expect(payload.content).toBeUndefined();
  });

  it('deletes obsolete continuations and accepts an already-deleted message', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }), new Response(null, { status: 404 }));
    await deleteMessage('token', '100000000000000123', '100000000000000999', new DiscordRateLimits());
    await deleteMessage('token', '100000000000000123', '100000000000000999', new DiscordRateLimits());
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'DELETE' && init.body === undefined)).toBe(true);
  });

  it('patches the original message when a session ends', async () => {
    const fetchMock = stubFetch(Response.json({ id: '100000000000000999' }));
    await editMessage('token', '100000000000000123', '100000000000000999', buildSessionEndedEmbed(endedEvent, LABELS), new DiscordRateLimits());
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://discord.com/api/v10/channels/100000000000000123/messages/100000000000000999');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body).embeds[0].color).toBe(COLOR_ENDED);
  });

  it('retries a rate-limited request', async () => {
    const fetchMock = stubFetch(
      Response.json({ retry_after: 0 }, { status: 429 }),
      Response.json({ id: '100000000000000042' }),
    );
    await expect(postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, new DiscordRateLimits())).resolves.toBe('100000000000000042');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a deleted message as gone without retrying', async () => {
    const fetchMock = stubFetch(Response.json({ message: 'Unknown Message' }, { status: 404 }));
    const err = await editMessage('token', '100000000000000123', '100000000000000999', buildOnlineEmbed(sample, undefined, LABELS), new DiscordRateLimits()).catch((e) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).isGone).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after four attempts', async () => {
    const fetchMock = stubFetch(
      ...Array.from({ length: 4 }, () => Response.json({ retry_after: 0 }, { status: 429 })),
    );
    await expect(postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, new DiscordRateLimits())).rejects.toThrow(
      'Discord API 429',
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('never retries a POST on a 5xx, to avoid posting a duplicate card', async () => {
    const fetchMock = stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    const err = await postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, new DiscordRateLimits()).catch((e) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying a PATCH/DELETE on a 5xx, since they are idempotent', async () => {
    const fetchMock = stubFetch(
      Response.json({ message: 'server error' }, { status: 503 }),
      Response.json({ id: '100000000000000999' }),
    );
    await editMessage('token', '100000000000000123', '100000000000000999', buildSessionEndedEmbed(endedEvent, LABELS), new DiscordRateLimits());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying a PATCH/DELETE on a 5xx, and marks an outage as soon as its retry budget is exhausted', async () => {
    const fetchMock = stubFetch(
      ...Array.from({ length: 4 }, () => Response.json({ message: 'server error' }, { status: 503 })),
    );
    const limits = new DiscordRateLimits();
    await expect(
      editMessage('token', '100000000000000123', '100000000000000999', buildSessionEndedEmbed(endedEvent, LABELS), limits),
    ).rejects.toBeInstanceOf(DiscordApiError);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // A single PATCH/DELETE exhausting its own retry budget is already an
    // outage: a later request in the same poll must not spend its own budget
    // against a service that just proved to be down.
    const err = await postMessage('token', '100000000000000456', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits).catch((e) => e);
    expect(err).toMatchObject({ status: 429, requestMade: false, reason: 'outage' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not mark an outage after a single POST 5xx, only after a second consecutive one', async () => {
    // POST never retries a 5xx in-request (see above), so a lone blip must
    // not defer the rest of the poll — only two in a row should.
    const fetchMock = stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    const limits = new DiscordRateLimits();
    await expect(
      postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A different destination in the same poll still gets its own attempt.
    const fetchMock2 = stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(
      postMessage('token', '100000000000000456', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);
    expect(fetchMock2).toHaveBeenCalledTimes(1);

    // The second consecutive POST failure now declares an outage; a third
    // destination fails fast without spending a network call.
    const err = await postMessage('token', '789', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits).catch((e) => e);
    expect(err).toMatchObject({ status: 429, requestMade: false, reason: 'outage' });
  });

  it('resets the POST failure streak after a success, so a lone blip afterward does not immediately declare an outage', async () => {
    const limits = new DiscordRateLimits();
    stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(
      postMessage('token', '1', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);

    stubFetch(Response.json({ id: '100000000000000999' }));
    await expect(
      postMessage('token', '2', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).resolves.toBe('100000000000000999');

    const fetchMock = stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(
      postMessage('token', '3', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reset the POST failure streak on a 5xx response', async () => {
    const limits = new DiscordRateLimits();
    stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(
      postMessage('token', '1', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);

    // A second consecutive 5xx still declares an outage: the first 5xx must
    // not have reset the streak.
    const fetchMock = stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(
      postMessage('token', '2', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A third destination now fails fast, proving the outage was marked.
    const err = await postMessage('token', '3', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits).catch((e) => e);
    expect(err).toMatchObject({ status: 429, requestMade: false, reason: 'outage' });
  });

  it('resets the POST failure streak on a non-5xx failure such as 400, so a later 5xx does not immediately declare an outage', async () => {
    const limits = new DiscordRateLimits();
    stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(
      postMessage('token', '1', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);

    stubFetch(Response.json({ message: 'bad request' }, { status: 400 }));
    await expect(
      postMessage('token', '2', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);

    const fetchMock = stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(
      postMessage('token', '3', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resets the POST failure streak on a non-5xx response from a different method (PATCH), so a later POST 5xx does not immediately declare an outage', async () => {
    const limits = new DiscordRateLimits();
    stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(
      postMessage('token', '1', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);

    stubFetch(Response.json({ message: 'Unknown Message' }, { status: 404 }));
    await expect(
      editMessage('token', '100000000000000123', '100000000000000999', buildOnlineEmbed(sample, undefined, LABELS), limits),
    ).rejects.toBeInstanceOf(DiscordApiError);

    const fetchMock = stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(
      postMessage('token', '2', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(DiscordApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks an outage before rethrowing a thrown fetch error (timeout/network) for PATCH/DELETE', async () => {
    const network = vi.fn().mockRejectedValueOnce(new TypeError('upstream request timed out'));
    vi.stubGlobal('fetch', network);
    const limits = new DiscordRateLimits();
    await expect(
      editMessage('token', '100000000000000123', '100000000000000999', buildOnlineEmbed(sample, undefined, LABELS), limits),
    ).rejects.toBeInstanceOf(TypeError);
    expect(network).toHaveBeenCalledTimes(1);

    // A later request in the same poll fails fast instead of hanging again.
    const err = await editMessage('token', '100000000000000456', '100000000000000999', buildOnlineEmbed(sample, undefined, LABELS), limits).catch((e) => e);
    expect(err).toMatchObject({ status: 429, requestMade: false, reason: 'outage' });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('requires a second consecutive thrown-fetch-error before marking an outage for POST', async () => {
    const network = vi.fn().mockRejectedValue(new TypeError('network error'));
    vi.stubGlobal('fetch', network);
    const limits = new DiscordRateLimits();
    await expect(
      postMessage('token', '1', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      postMessage('token', '2', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits),
    ).rejects.toBeInstanceOf(TypeError);

    const err = await postMessage('token', '3', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, limits).catch((e) => e);
    expect(err).toMatchObject({ status: 429, requestMade: false, reason: 'outage' });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('does not mask a rate-limit error with a message that carries a response body', async () => {
    const fetchMock = stubFetch(Response.json({ message: 'You are being rate limited.', code: 0 }, { status: 429, headers: { 'retry-after': '1' } }));
    const err = await postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, new DiscordRateLimits()).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.message).not.toContain('You are being rate limited');
  });

  it('reports the Discord numeric code in the message, without echoing the rest of the response body', async () => {
    const body = { message: 'Missing Permissions and a lot of extra detail that must never reach a log line', code: 50013 };
    const fetchMock = stubFetch(Response.json(body, { status: 403 }));
    const err = await editMessage('token', '100000000000000123', '100000000000000999', buildOnlineEmbed(sample, undefined, LABELS), new DiscordRateLimits()).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).message).toBe('Discord API 403 (code 50013)');
    expect((err as DiscordApiError).body).toContain('a lot of extra detail');
    expect((err as DiscordApiError).isGone).toBe(true);
  });

  it('treats an oversized channel scan as a budgeted lookup failure without deferring later posts', async () => {
    const botId = '100000000000000009';
    const token = `${btoa(botId)}.synthetic.token`;
    const at = 1_800_000_000_000;
    const fetchMock = stubFetch(
      new Response('[]', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
      Response.json({ id: '100000000000000999' }),
    );
    const limits = new DiscordRateLimits();
    const err = await findBotMessages(token, '100000000000000123', { from: at, to: at }, limits, () => true)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordResponseTooLargeError);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect(countsAgainstBudget(err)).toBe(true);
    expect((err as DiscordApiError).isGone).toBe(false);
    expect((err as DiscordResponseTooLargeError).upstreamStatus).toBe(200);
    expect((err as Error).message).toBe('Discord API response exceeded size limit');
    // No outage was marked: the next post in the same poll is still sent.
    await expect(postMessage('token', '100000000000000456', { title: 'Synthetic' }, undefined, undefined, limits))
      .resolves.toBe('100000000000000999');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not count an oversized response towards the POST outage streak', async () => {
    const limits = new DiscordRateLimits();
    stubFetch(Response.json({ message: 'server error' }, { status: 503 }));
    await expect(postMessage('token', '100000000000000123', { title: 'Synthetic' }, undefined, undefined, limits))
      .rejects.toBeInstanceOf(DiscordApiError);
    stubFetch(new Response('x', { status: 400, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }));
    await expect(postMessage('token', '100000000000000123', { title: 'Synthetic' }, undefined, undefined, limits))
      .rejects.toBeInstanceOf(DiscordResponseTooLargeError);
    // The oversized response proved Discord reachable, so one more 5xx is not yet an outage.
    const fetchMock = stubFetch(Response.json({ message: 'server error' }, { status: 503 }), Response.json({ id: '100000000000000999' }));
    await expect(postMessage('token', '100000000000000123', { title: 'Synthetic' }, undefined, undefined, limits))
      .rejects.toMatchObject({ status: 503 });
    await expect(postMessage('token', '100000000000000456', { title: 'Synthetic' }, undefined, undefined, limits))
      .resolves.toBe('100000000000000999');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports an accepted POST with an oversized response as unconfirmed, never as a rejection', async () => {
    stubFetch(new Response('x', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }));
    await expect(postMessage('token', '100000000000000123', { title: 'Synthetic' }, undefined, undefined, new DiscordRateLimits()))
      .rejects.toBeInstanceOf(DiscordUnconfirmedPostError);
  });

  it.each(['../100000000000000999', '100000000000000999/reactions', 'posted-1', '123', '1'.repeat(21), ''])(
    'never places a stored message id %j that is not a snowflake in a request path', async (messageId) => {
      const fetchMock = stubFetch(Response.json({ id: '100000000000000999' }), new Response(null, { status: 204 }));
      const edit = await editMessage('token', '100000000000000123', messageId, { title: 'Synthetic' }, new DiscordRateLimits())
        .catch((e: unknown) => e);
      // Unaddressable, so treated as gone: callers fall back as for a deleted card.
      expect(edit).toBeInstanceOf(DiscordInvalidMessageIdError);
      expect((edit as DiscordApiError).isGone).toBe(true);
      expect((edit as Error).message).not.toContain(messageId || 'unused');
      const del = await deleteMessage('token', '100000000000000123', messageId, new DiscordRateLimits())
        .catch((e: unknown) => e);
      // Not silently treated as deleted: a budgeted permanent failure instead.
      expect(del).toBeInstanceOf(DiscordInvalidMessageIdError);
      expect(countsAgainstBudget(del)).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it('names rate-limit errors for log clarity', async () => {
    const fetchMock = stubFetch(Response.json({ retry_after: 0.5 }, { status: 429 }));
    const err = await postMessage('token', '100000000000000123', buildOnlineEmbed(sample, undefined, LABELS), undefined, undefined, new DiscordRateLimits()).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err.name).toBe('DiscordRateLimitError');
  });
});
