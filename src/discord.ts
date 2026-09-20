import {
  COLOR_ENDED,
  COLOR_OFFLINE,
  COLOR_ONLINE,
  EMBED_FOOTER,
  firOf,
  type FirLabel,
} from './config';
import { hasFrequency } from './ivao';
import type { OfflineEvent, OnlineAtc, TrackedAtc } from './types';
import { DiscordRateLimitError, DiscordRateLimits } from './discord-rate-limit';
import { countryCode } from './member-country';

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

// --- Formatting helpers ------------------------------------------------------

export function formatFrequency(frequency: number): string {
  // 0.000 means the controller has connected but not tuned yet. Cards are
  // held back until a real frequency arrives, so this is only a safety net.
  if (!hasFrequency({ frequency })) return 'freq pending';
  return `${frequency.toFixed(3)} MHz`;
}

export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSeconds}s`;
}

function stationLine(atc: TrackedAtc): string | undefined {
  if (atc.station && atc.location && atc.station !== atc.location) {
    return `**${atc.station}** — ${atc.location}`;
  }
  if (atc.station) return `**${atc.station}**`;
  if (atc.location) return `**${atc.location}**`;
  return undefined;
}

/** Discord renders `<t:…:R>` as a live-updating relative time in every client. */
function relativeTime(iso: string): string {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:R>`;
}

function shortTime(iso: string): string {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:t>`;
}

function describe(atc: TrackedAtc, extra: string): string {
  const station = stationLine(atc);
  return station ? `${station}\n${extra}` : extra;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region', style: 'short', fallback: 'none' });

function stationFlag(atc: OnlineAtc, labels: FirLabel[]): string {
  const code = countryCode(atc.airport?.countryId);
  if (!code || !regionNames.of(code)) return firOf(atc.callsign, labels).flag;
  return String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

function formatController(atc: OnlineAtc): string {
  const code = countryCode(atc.memberCountry?.countryId);
  const country = code ? regionNames.of(code) : undefined;
  return `VID ${atc.userId}${country ? ` · ${country}` : ''}`;
}

/** Only explicitly associated airport positions; no inferred top-down coverage. */
function airportCoverage(atc: OnlineAtc, current: OnlineAtc[]): string | undefined {
  if (!atc.airport?.icao) return undefined;
  const order = ['DEL', 'GND', 'TWR', 'APP', 'DEP', 'CTR', 'FSS'];
  const positions = [...new Set(current
    .filter((other) => other.airport?.icao === atc.airport!.icao && hasFrequency(other))
    .map((other) => other.position.toUpperCase())
    .filter((position) => order.includes(position)))]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return positions.length ? positions.map((position) => `✅ ${position}`).join(' · ') : 'No positions reported online';
}

const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_TEXT_LIMIT = 6000;
const EMBED_FIELD_LIMIT = 25;
const FIR_NAME_WIDTH = 12;
/** A flag emoji occupies roughly two cells in Discord's monospace block. */
const FIR_COL_WIDTH = 2 + 1 + FIR_NAME_WIDTH;

/**
 * Render the "also online now" roster, grouped by FIR.
 *
 * Wrapped in a code block because Discord embed text is proportional —
 * without monospace the columns would not line up. The FIR label appears
 * once per group; the rest of that group's stations are indented under it.
 *
 * `others` must already exclude the controller whose card this is. Stations
 * that have not tuned a frequency yet are left out — they are not announced
 * anywhere else either, so listing them here would be inconsistent.
 */
export function formatRoster(others: OnlineAtc[], labels: FirLabel[] = []): string | undefined {
  const usable = others.filter(hasFrequency);
  if (usable.length === 0) return undefined;

  const sorted = [...usable].sort((a, b) => a.callsign.localeCompare(b.callsign));
  const groups = new Map<string, { flag: string; name: string; items: OnlineAtc[] }>();
  for (const atc of sorted) {
    const fir = firOf(atc.callsign, labels);
    const group = groups.get(fir.name) ?? { ...fir, items: [] };
    group.items.push(atc);
    groups.set(fir.name, group);
  }

  const callsignWidth = Math.max(8, ...sorted.map((a) => a.callsign.length));
  const stationWidth = Math.min(22, Math.max(8, ...sorted.map((a) => (a.station ?? '').length)));

  const lines: string[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    group.items.forEach((atc, i) => {
      // Only the first row of a group carries the flag and FIR name; the
      // rest are indented so the callsign column stays aligned.
      const label =
        i === 0 ? `${group.flag} ${group.name.padEnd(FIR_NAME_WIDTH)}` : ' '.repeat(FIR_COL_WIDTH);
      const station = (atc.station ?? '').slice(0, stationWidth).padEnd(stationWidth);
      lines.push(
        `${label}${atc.callsign.padEnd(callsignWidth)}  ${station}  ${atc.frequency.toFixed(3)}`,
      );
    });
  }
  return ['```', ...lines, '```'].join('\n');
}

/** Keep every station, splitting only between rows to fit Discord's field limit. */
function splitRoster(roster: string): string[] {
  const chunks: string[] = [];
  let chunk = '```';
  for (const line of roster.split('\n').slice(1, -1)) {
    // Include the newline before this row and the closing code fence.
    if (chunk.length + 1 + line.length + '\n```'.length > EMBED_FIELD_VALUE_LIMIT) {
      chunks.push(`${chunk}\n\`\`\``);
      chunk = '```';
    }
    chunk += `\n${line}`;
  }
  chunks.push(`${chunk}\n\`\`\``);
  return chunks;
}

/** How many stations the roster is counting, for the field label. */
export function rosterCount(others: OnlineAtc[]): number {
  return others.filter(hasFrequency).length;
}

/**
 * The card posted when a controller connects. It stays in the channel for
 * the whole session; the `<t:…:R>` stamp makes the "online since" line tick
 * up on its own, with no further API calls.
 *
 * Use buildOnlineEmbeds for the roster-bearing card so overflow pages are
 * delivered too. This single-message helper builds only the session card.
 */
export function buildOnlineEmbed(
  atc: TrackedAtc, current: OnlineAtc[] = [atc], labels: FirLabel[] = [],
): DiscordEmbed {
  return buildOnlineEmbeds(atc, [], current, labels)[0];
}

/** All pages of the card; each must be sent in a separate Discord message. */
export function buildOnlineEmbeds(
  atc: TrackedAtc, others: OnlineAtc[] = [], current: OnlineAtc[] = [atc, ...others],
  labels: FirLabel[] = [],
): [DiscordEmbed, ...DiscordEmbed[]] {
  const fields: NonNullable<DiscordEmbed['fields']> = [
    { name: 'Frequency', value: formatFrequency(atc.frequency), inline: true },
    { name: 'Position', value: atc.position, inline: true },
    { name: 'Controller', value: formatController(atc), inline: true },
  ];

  const coverage = airportCoverage(atc, current);
  if (coverage) fields.push({ name: `Online at ${atc.airport!.icao}`, value: coverage, inline: false });

  const first: DiscordEmbed = {
    title: `🟢 ${stationFlag(atc, labels)} ${atc.callsign} is now ONLINE`,
    description: describe(atc, `Online since ${relativeTime(atc.since)}`),
    color: COLOR_ONLINE,
    fields,
    footer: { text: EMBED_FOOTER },
    timestamp: atc.since,
  };
  const pages: [DiscordEmbed, ...DiscordEmbed[]] = [first];
  const roster = formatRoster(others, labels);
  if (roster) {
    // An empty field renders as a blank line, separating the roster from
    // the inline frequency/position/controller row above it.
    fields.push({ name: '\u200b', value: '\u200b', inline: false });
    const count = rosterCount(others);
    let page = first;
    let length = embedTextLength(page);
    splitRoster(roster).forEach((value, i) => {
      const field = {
        name: i === 0 ? `Also online now (${count})` : 'Also online now (continued)',
        value,
        inline: false,
      };
      if (length + field.name.length + value.length > EMBED_TEXT_LIMIT ||
          page.fields!.length >= EMBED_FIELD_LIMIT) {
        page = {
          title: `🟢 Also online now — ${atc.callsign} (continued)`,
          color: COLOR_ONLINE,
          fields: [],
          footer: { text: EMBED_FOOTER },
          timestamp: atc.since,
        };
        pages.push(page);
        length = embedTextLength(page);
      }
      page.fields!.push(field);
      length += field.name.length + value.length;
    });
  }

  return pages;
}

function embedTextLength(embed: DiscordEmbed): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}

/**
 * The same card after the session ended — this replaces the online embed in
 * the original message, so a channel scroll shows one entry per session:
 * green while the position is staffed, grey once it is not.
 */
export function buildSessionEndedEmbed(event: OfflineEvent, labels: FirLabel[] = []): DiscordEmbed {
  return {
    title: `⚪ ${stationFlag(event, labels)} ${event.callsign} is OFFLINE`,
    description: describe(
      event,
      `Was online for **${formatDuration(event.durationSeconds)}** · disconnected ${relativeTime(
        event.endedAt,
      )}`,
    ),
    color: COLOR_ENDED,
    fields: [
      {
        name: 'Session',
        value: `${shortTime(event.since)} → ${shortTime(event.endedAt)}`,
        inline: true,
      },
      { name: 'Frequency', value: formatFrequency(event.frequency), inline: true },
      { name: 'Position', value: event.position, inline: true },
      { name: 'Controller', value: formatController(event), inline: true },
    ],
    footer: { text: EMBED_FOOTER },
    timestamp: event.endedAt,
  };
}

/**
 * Standalone offline notice. Only used as a fallback when the original
 * online message can no longer be edited (deleted, or posted before this
 * bot started tracking message IDs).
 */
export function buildOfflineEmbed(event: OfflineEvent, labels: FirLabel[] = []): DiscordEmbed {
  return {
    title: `🔴 ${stationFlag(event, labels)} ${event.callsign} went OFFLINE`,
    description: stationLine(event),
    color: COLOR_OFFLINE,
    fields: [
      { name: 'Was online for', value: formatDuration(event.durationSeconds), inline: true },
      { name: 'Frequency', value: formatFrequency(event.frequency), inline: true },
      { name: 'Controller', value: formatController(event), inline: true },
    ],
    footer: { text: EMBED_FOOTER },
    timestamp: event.endedAt,
  };
}

// --- REST --------------------------------------------------------------------

/** Parse the comma-separated DISCORD_CHANNEL_IDS var. */
export function parseChannelIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Discord API ${status}: ${body.slice(0, 300)}`);
    this.name = 'DiscordApiError';
  }

  /** The target message is gone (deleted, or the channel is inaccessible). */
  get isGone(): boolean {
    return this.status === 404 || this.status === 403;
  }
}

const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry transient server errors within a bounded budget. Positive rate-limit
 * cooldowns defer delivery to a later poll instead of holding the coordinator.
 */
async function discordRequest(
  botToken: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: unknown,
  limits = new DiscordRateLimits(),
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await limits.fetch(path, {
      method,
      headers: {
        authorization: `Bot ${botToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }).catch((err: unknown) => {
      // A zero-second rejection permits a bounded immediate retry.
      if (err instanceof DiscordRateLimitError && err.requestMade &&
          err.retryAt <= Date.now() && attempt < MAX_ATTEMPTS) return null;
      throw err;
    });
    if (!res) continue;
    if (res.ok) return res;

    const body = await res.text();
    const retryable = res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new DiscordApiError(res.status, body);
    }
    await sleep(500 * 2 ** (attempt - 1));
  }
}

/** Post a message and return its ID so it can be edited later. */
export async function postMessage(
  botToken: string,
  channelId: string,
  embed: DiscordEmbed,
  content?: string,
  replyTo?: string,
  limits?: DiscordRateLimits,
): Promise<string> {
  const res = await discordRequest(botToken, 'POST', `/channels/${channelId}/messages`, {
    content,
    embeds: [embed],
    allowed_mentions: { parse: ['roles'], replied_user: false },
    ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
  }, limits);
  const message = (await res.json()) as { id?: string };
  if (!message.id) throw new Error('Discord API returned a message without an id');
  return message.id;
}

/** Replace the embed of a message this bot posted earlier. */
export async function editMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  embed: DiscordEmbed,
  limits?: DiscordRateLimits,
): Promise<void> {
  await discordRequest(botToken, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
    embeds: [embed],
  }, limits);
}

/** Remove an obsolete roster continuation; already-deleted messages are clean. */
export async function deleteMessage(botToken: string, channelId: string, messageId: string, limits?: DiscordRateLimits): Promise<void> {
  try {
    await discordRequest(botToken, 'DELETE', `/channels/${channelId}/messages/${messageId}`, undefined, limits);
  } catch (err) {
    if (!(err instanceof DiscordApiError && err.status === 404)) throw err;
  }
}
