import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLOR_ENDED, COLOR_OFFLINE, COLOR_ONLINE, parseFirLabels } from '../src/config';
import {
  buildOfflineEmbed,
  buildOnlineEmbed,
  buildOnlineEmbeds,
  buildSessionEndedEmbed,
  DiscordApiError,
  deleteMessage,
  formatRoster,
  editMessage,
  formatDuration,
  formatFrequency,
  parseChannelIds,
  postMessage,
} from '../src/discord';
import type { OfflineEvent, OnlineAtc, TrackedAtc } from '../src/types';

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
    expect(parseChannelIds('123, 456 ,,789')).toEqual(['123', '456', '789']);
    expect(parseChannelIds('123')).toEqual(['123']);
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

  it.each([100, 400, 1000])('delivers all %i stations within every message limit', (count) => {
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

  it('returns the id of the posted message', async () => {
    const fetchMock = stubFetch(Response.json({ id: '999' }));
    const id = await postMessage('token', '123', buildOnlineEmbed(sample, undefined, LABELS), '<@&role>');
    expect(id).toBe('999');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://discord.com/api/v10/channels/123/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).content).toBe('<@&role>');
  });

  it('posts continuations as replies without pinging the parent author', async () => {
    const fetchMock = stubFetch(Response.json({ id: '999' }));
    await postMessage('token', '123', buildOnlineEmbed(sample, undefined, LABELS), undefined, 'parent');
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.message_reference).toEqual({ message_id: 'parent', fail_if_not_exists: false });
    expect(payload.allowed_mentions.replied_user).toBe(false);
    expect(payload.content).toBeUndefined();
  });

  it('deletes obsolete continuations and accepts an already-deleted message', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }), new Response(null, { status: 404 }));
    await deleteMessage('token', '123', '999');
    await deleteMessage('token', '123', '999');
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'DELETE' && init.body === undefined)).toBe(true);
  });

  it('patches the original message when a session ends', async () => {
    const fetchMock = stubFetch(Response.json({ id: '999' }));
    await editMessage('token', '123', '999', buildSessionEndedEmbed(endedEvent, LABELS));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://discord.com/api/v10/channels/123/messages/999');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body).embeds[0].color).toBe(COLOR_ENDED);
  });

  it('retries a rate-limited request', async () => {
    const fetchMock = stubFetch(
      Response.json({ retry_after: 0 }, { status: 429 }),
      Response.json({ id: '42' }),
    );
    await expect(postMessage('token', '123', buildOnlineEmbed(sample, undefined, LABELS))).resolves.toBe('42');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a deleted message as gone without retrying', async () => {
    const fetchMock = stubFetch(Response.json({ message: 'Unknown Message' }, { status: 404 }));
    const err = await editMessage('token', '123', '999', buildOnlineEmbed(sample, undefined, LABELS)).catch((e) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).isGone).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after four attempts', async () => {
    const fetchMock = stubFetch(
      ...Array.from({ length: 4 }, () => Response.json({ retry_after: 0 }, { status: 429 })),
    );
    await expect(postMessage('token', '123', buildOnlineEmbed(sample, undefined, LABELS))).rejects.toThrow(
      'Discord API 429',
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
