import {
  COLOR_ENDED,
  COLOR_OFFLINE,
  COLOR_ONLINE,
  EMBED_FOOTER,
  firOf,
  type FirLabel,
} from './config';
import { hasFrequency, sliceCodePoints } from './ivao';
import type { OfflineEvent, OnlineAtc, TrackedAtc } from './types';
import { DiscordRateLimitError, DiscordRateLimits } from './discord-rate-limit';
import { ResponseTooLargeError } from './http';
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

/**
 * Escape characters Discord treats as markdown or mentions, so IVAO-derived
 * text can't break embed formatting or invoke `<@&123>`-style pings. Runs of
 * CR/LF and Unicode line/paragraph separators are collapsed to a single space
 * so injected newlines can't fake extra embed lines. An underscore between
 * two letters or digits (as in `EGLL_TWR`) cannot start or end emphasis, so it
 * is left readable.
 *
 * Invisible format characters (bidi overrides, zero-width characters) are
 * removed; a leading `#`, `-` or ordered-list marker (`1.`) is escaped so it
 * cannot start a header or list item; `://` is written as `:\/\/`, which
 * Discord displays as `://` without turning the text into a clickable link.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/\p{Cf}/gu, '').replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\\*_~`|[\]<>]/g, (char, index: number, whole: string) =>
      char === '_' && /[A-Za-z0-9]/.test(whole[index - 1] ?? '') && /[A-Za-z0-9]/.test(whole[index + 1] ?? '')
        ? char : `\\${char}`)
    .replace(/:\/\//g, ':\\/\\/')
    .replace(/^(\s*)([#-])/, '$1\\$2')
    .replace(/^(\s*)(\d+)\.(?=\s)/, '$1$2\\.');
}

function stationLine(atc: TrackedAtc): string | undefined {
  if (atc.station && atc.location && atc.station !== atc.location) {
    return `**${escapeMarkdown(atc.station)}** — ${escapeMarkdown(atc.location)}`;
  }
  if (atc.station) return `**${escapeMarkdown(atc.station)}**`;
  if (atc.location) return `**${escapeMarkdown(atc.location)}**`;
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

function formatController(atc: OnlineAtc, gcaMismatch = false): string {
  const code = countryCode(atc.memberCountry?.countryId);
  const country = code ? regionNames.of(code) : undefined;
  return `VID ${atc.userId}${country ? ` · ${gcaMismatch ? '🔴 ' : ''}${country}` : ''}`;
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
 * Bound the continuation messages one card can need, whatever the feed
 * reports; each one is a separate Discord request per channel. The first
 * roster field still reports the full count.
 */
export const MAX_ROSTER_CONTINUATION_PAGES = 10;

/** A backtick inside a roster cell would otherwise prematurely close the code block. */
function stripBackticks(text: string): string {
  return text.replace(/`/g, "'");
}

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
      // Cut on a code-point boundary: a split surrogate pair is invalid text.
      const station = stripBackticks(sliceCodePoints(atc.station ?? '', stationWidth)).padEnd(stationWidth);
      lines.push(
        `${label}${stripBackticks(atc.callsign).padEnd(callsignWidth)}  ${station}  ${atc.frequency.toFixed(3)}`,
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
  gcaMismatch = false,
): DiscordEmbed {
  return buildOnlineEmbeds(atc, [], current, labels, gcaMismatch)[0];
}

/** All pages of the card; each must be sent in a separate Discord message. */
export function buildOnlineEmbeds(
  atc: TrackedAtc, others: OnlineAtc[] = [], current: OnlineAtc[] = [atc, ...others],
  labels: FirLabel[] = [], gcaMismatch = false,
): [DiscordEmbed, ...DiscordEmbed[]] {
  const fields: NonNullable<DiscordEmbed['fields']> = [
    { name: 'Frequency', value: formatFrequency(atc.frequency), inline: true },
    { name: 'Position', value: escapeMarkdown(atc.position), inline: true },
    { name: 'Controller', value: formatController(atc, gcaMismatch), inline: true },
  ];

  const coverage = airportCoverage(atc, current);
  if (coverage) fields.push({ name: `Online at ${atc.airport!.icao}`, value: coverage, inline: false });

  const first: DiscordEmbed = {
    title: `${gcaMismatch ? '🔴' : '🟢'} ${stationFlag(atc, labels)} ${escapeMarkdown(atc.callsign)} is now ONLINE`,
    description: describe(atc, `Online since ${relativeTime(atc.since)}`),
    color: gcaMismatch ? COLOR_OFFLINE : COLOR_ONLINE,
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
    for (const [i, value] of splitRoster(roster).entries()) {
      const field = {
        name: i === 0 ? `Also online now (${count})` : 'Also online now (continued)',
        value,
        inline: false,
      };
      if (length + field.name.length + value.length > EMBED_TEXT_LIMIT ||
          page.fields!.length >= EMBED_FIELD_LIMIT) {
        if (pages.length > MAX_ROSTER_CONTINUATION_PAGES) break;
        page = {
          title: `${gcaMismatch ? '🔴' : '🟢'} Also online now — ${escapeMarkdown(atc.callsign)} (continued)`,
          color: gcaMismatch ? COLOR_OFFLINE : COLOR_ONLINE,
          fields: [],
          footer: { text: EMBED_FOOTER },
          timestamp: atc.since,
        };
        pages.push(page);
        length = embedTextLength(page);
      }
      page.fields!.push(field);
      length += field.name.length + value.length;
    }
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
    title: `⚪ ${stationFlag(event, labels)} ${escapeMarkdown(event.callsign)} is OFFLINE`,
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
      { name: 'Position', value: escapeMarkdown(event.position), inline: true },
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
    title: `🔴 ${stationFlag(event, labels)} ${escapeMarkdown(event.callsign)} went OFFLINE`,
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

/** A Discord snowflake id, safe to place in an API path. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/**
 * Parse the comma-separated DISCORD_CHANNEL_IDS var. Entries that are not
 * snowflakes are skipped and counted in a log line that omits their values.
 */
export function parseChannelIds(raw: string | undefined): string[] {
  const ids = (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const valid = ids.filter((id) => SNOWFLAKE_PATTERN.test(id));
  if (valid.length < ids.length) {
    console.error(JSON.stringify({
      event: 'config_invalid', reason: 'discord_channel_ids', count: ids.length - valid.length,
    }));
  }
  return valid;
}

/**
 * Only an exact `<@&id>` role mention may ping, and only that role; any other
 * content pings nobody.
 */
function allowedMentions(content: string | undefined): { parse: []; roles?: string[]; replied_user: false } {
  const role = /^<@&(\d+)>$/.exec(content ?? '')?.[1];
  return role && SNOWFLAKE_PATTERN.test(role)
    ? { parse: [], roles: [role], replied_user: false }
    : { parse: [], replied_user: false };
}

/** A 2xx message POST whose response carried no usable message id. */
export class DiscordUnconfirmedPostError extends Error {
  constructor() {
    super('Discord API accepted a message without returning its id');
    this.name = 'DiscordUnconfirmedPostError';
  }
}

export class DiscordApiError extends Error {
  /** Discord's own numeric error code, when the body carried one. */
  readonly code?: number;

  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    const code = DiscordApiError.parseCode(body);
    super(`Discord API ${status}${code !== undefined ? ` (code ${code})` : ''}`);
    this.name = 'DiscordApiError';
    this.code = code;
  }

  private static parseCode(body: string): number | undefined {
    try {
      const parsed = JSON.parse(body) as { code?: unknown };
      return typeof parsed.code === 'number' ? parsed.code : undefined;
    } catch {
      return undefined;
    }
  }

  /** The target message is gone (deleted, or the channel is inaccessible). */
  get isGone(): boolean {
    return this.status === 404 || this.status === 403;
  }
}

/**
 * Discord answered with a body over the response cap (a channel scan whose
 * messages were stuffed with large content, say). Discord is reachable, so
 * this never marks an outage; it is classified as a definite 4xx-like
 * rejection so every budgeted caller (`countsAgainstBudget`) gives up after
 * its bounded retries instead of retrying every poll. The synthetic status
 * never reaches Discord; `upstreamStatus` is the status of the discarded response.
 */
export class DiscordResponseTooLargeError extends DiscordApiError {
  constructor(readonly upstreamStatus: number) {
    super(413, '');
    this.name = 'DiscordResponseTooLargeError';
    this.message = 'Discord API response exceeded size limit';
  }
}

/**
 * A stored message id (from an older deploy, or corrupt storage) that is not
 * a snowflake is never placed in a request path. No request is made; the
 * message is reported as gone (it cannot be addressed), with a non-404 status
 * so a delete of it is budgeted rather than silently treated as done.
 */
export class DiscordInvalidMessageIdError extends DiscordApiError {
  constructor() {
    super(400, '');
    this.name = 'DiscordInvalidMessageIdError';
    this.message = 'Stored Discord message id is not a snowflake; request skipped';
  }

  override get isGone(): boolean {
    return true;
  }
}

function assertMessageId(messageId: string): void {
  if (!SNOWFLAKE_PATTERN.test(messageId)) throw new DiscordInvalidMessageIdError();
}

const MAX_ATTEMPTS = 4;

/** How long later calls in the same poll fail fast after a request exhausts its 5xx retries. */
const OUTAGE_COOLDOWN_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry transient server errors within a bounded budget. Positive rate-limit
 * cooldowns defer delivery to a later poll instead of holding the coordinator.
 *
 * POST is never retried on a 5xx: a successful-but-unacknowledged POST would
 * otherwise be resent, posting a duplicate card and re-pinging a role. The
 * next poll re-delivers instead — duplicates across polls are deduped by
 * Discord only within its own nonce window (a few minutes), via the optional
 * `enforce_nonce` payload built from `messageNonce`. PATCH/DELETE are
 * idempotent and keep retrying.
 */
async function discordRequest(
  botToken: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload: unknown,
  limits: DiscordRateLimits,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    // A number stands for a 5xx response whose oversized body was discarded.
    const res: Response | number | null = await limits.fetch(path, {
      method,
      headers: {
        authorization: `Bot ${botToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }).catch((err: unknown) => {
      if (err instanceof DiscordRateLimitError) {
        // A zero-second rejection permits a bounded immediate retry.
        if (err.requestMade && err.retryAt <= Date.now() && attempt < MAX_ATTEMPTS) return null;
        throw err;
      }
      if (err instanceof ResponseTooLargeError) {
        // An oversized 5xx is an ordinary server error with its body dropped:
        // it takes the normal 5xx path below (retries, outage marking, and a
        // POST whose outcome is unknown). An oversized 429 never gets here;
        // the rate limiter turns it into a conservative cooldown.
        if (err.status >= 500) return err.status;
        // Discord responded, so this is neither an outage nor a POST failure.
        limits.noteDiscordResponded();
        // An accepted POST created its message even though its id is unreadable.
        if (method === 'POST' && err.status >= 200 && err.status < 300) throw new DiscordUnconfirmedPostError();
        throw new DiscordResponseTooLargeError(err.status);
      }
      // A thrown fetch error (timeout, network failure, TypeError) never
      // gets an in-request retry — there is no response to retry against.
      // For POST, only mark an outage after a second consecutive failure so
      // one blip doesn't defer the rest of the poll; PATCH/DELETE mark
      // immediately since a thrown error already exhausts their only attempt.
      if (method !== 'POST' || limits.notePostFailure()) limits.markOutage(OUTAGE_COOLDOWN_MS);
      throw err;
    });
    if (res === null) continue;
    const status = typeof res === 'number' ? res : res.status;
    // Any non-5xx response — regardless of method — proves Discord is
    // reachable, so it resets the POST failure streak even when this call
    // was itself a PATCH/DELETE, or a POST that came back with a non-5xx
    // failure such as 404.
    if (status < 500) limits.noteDiscordResponded();
    if (typeof res !== 'number' && res.ok) return res;

    const body = typeof res === 'number' ? '' : await res.text();
    const retryable = method !== 'POST' && status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      if (status >= 500) {
        // PATCH/DELETE have exhausted their real retry budget here; POST
        // never retries in-request, so it instead needs a second consecutive
        // 5xx/timeout before an outage is declared.
        if (method !== 'POST' || limits.notePostFailure()) limits.markOutage(OUTAGE_COOLDOWN_MS);
      }
      throw new DiscordApiError(status, body);
    }
    await sleep(500 * 2 ** (attempt - 1));
  }
}

/**
 * A deterministic, ≤25-char nonce for `enforce_nonce`: the same session and
 * channel always produce the same value, so a re-post of the same card
 * (e.g. after a POST 5xx whose success/failure was never learned) is deduped
 * by Discord itself — but only within its own nonce window (a few minutes).
 */
export function messageNonce(sessionKey: string, channelId: string): string {
  const input = `${sessionKey}:${channelId}`;
  // Two independent 32-bit FNV-1a-style hashes combined into ~64 bits give
  // enough spread to avoid collisions without a hashing library.
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  const combined = (BigInt(h1 >>> 0) << 32n) | BigInt(h2 >>> 0);
  return combined.toString(36).slice(0, 25);
}

/** Post a message and return its ID so it can be edited later. */
export async function postMessage(
  botToken: string,
  channelId: string,
  embed: DiscordEmbed,
  content: string | undefined,
  replyTo: string | undefined,
  limits: DiscordRateLimits,
  nonce?: string,
): Promise<string> {
  const res = await discordRequest(botToken, 'POST', `/channels/${channelId}/messages`, {
    content,
    embeds: [embed],
    allowed_mentions: allowedMentions(content),
    ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
    ...(nonce ? { nonce, enforce_nonce: true } : {}),
  }, limits);
  const message = await res.json().catch(() => null) as { id?: unknown } | null;
  if (typeof message?.id !== 'string' || !SNOWFLAKE_PATTERN.test(message.id)) throw new DiscordUnconfirmedPostError();
  return message.id;
}

/** Replace the embed of a message this bot posted earlier. */
export async function editMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  embed: DiscordEmbed,
  limits: DiscordRateLimits,
): Promise<void> {
  assertMessageId(messageId);
  await discordRequest(botToken, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
    embeds: [embed],
  }, limits);
}

/** The bot's user id, which Discord encodes as base64 in the token's first segment. */
function botUserId(botToken: string): string | undefined {
  try {
    const id = atob(botToken.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'));
    return /^\d{17,20}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

const DISCORD_EPOCH_MS = 1_420_070_400_000;

function snowflakeAt(ms: number): string {
  return (BigInt(Math.max(0, ms - DISCORD_EPOCH_MS)) << 22n).toString();
}

function snowflakeTime(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
}

/** Messages requested per channel-scan page, and the smaller retry size for an oversized page. */
const SCAN_PAGE_SIZE = 100;
const SCAN_FALLBACK_PAGE_SIZE = 25;

/** The fields of a fetched Discord message this bot inspects. */
export interface FetchedMessage {
  id: string;
  author?: { id?: unknown };
  message_reference?: { message_id?: unknown };
  embeds?: { title?: string; timestamp?: string }[];
}

/**
 * Ids of this bot's messages matching `match`, among up to 500 messages
 * (fewer once an oversized page forces smaller pages) posted within the
 * given time window (a minute of slack either side). Used
 * to find messages whose POST succeeded without the bot learning their id.
 * Returns nothing when the bot's own id is unknown.
 */
export async function findBotMessages(
  botToken: string, channelId: string, window: { from: number; to: number }, limits: DiscordRateLimits,
  match: (message: FetchedMessage) => boolean,
): Promise<string[]> {
  const botId = botUserId(botToken);
  if (!botId) return [];
  const found: string[] = [];
  let after = snowflakeAt(window.from - 60_000);
  let limit = SCAN_PAGE_SIZE;
  for (let page = 0; page < 5; page++) {
    const path = () => `/channels/${channelId}/messages?after=${after}&limit=${limit}`;
    let res: Response;
    try {
      res = await discordRequest(botToken, 'GET', path(), undefined, limits);
    } catch (err) {
      // Other users' messages can make a full page exceed the response cap.
      // Retry the same page smaller once, and keep the smaller size for the
      // rest of the scan, before reporting the lookup as failed.
      if (!(err instanceof DiscordResponseTooLargeError) || limit === SCAN_FALLBACK_PAGE_SIZE) throw err;
      limit = SCAN_FALLBACK_PAGE_SIZE;
      res = await discordRequest(botToken, 'GET', path(), undefined, limits);
    }
    const list = await res.json().catch(() => null) as unknown;
    if (!Array.isArray(list)) throw new Error('Discord returned an invalid message list');
    let newest = after;
    for (const item of list as Partial<FetchedMessage>[]) {
      if (typeof item?.id !== 'string' || !SNOWFLAKE_PATTERN.test(item.id)) continue;
      if (BigInt(item.id) > BigInt(newest)) newest = item.id;
      const at = snowflakeTime(item.id);
      if (at < window.from - 60_000 || at > window.to + 60_000) continue;
      if (item.author?.id === botId && match(item as FetchedMessage)) found.push(item.id);
    }
    if (list.length < limit || newest === after || snowflakeTime(newest) > window.to + 60_000) break;
    after = newest;
  }
  return found;
}

/** Ids of this bot's replies to a message within the given time window. */
export function findBotReplies(
  botToken: string, channelId: string, parentMessageId: string,
  window: { from: number; to: number }, limits: DiscordRateLimits,
): Promise<string[]> {
  return findBotMessages(botToken, channelId, window, limits,
    (message) => message.message_reference?.message_id === parentMessageId);
}

/** Remove an obsolete roster continuation; already-deleted messages are clean. */
export async function deleteMessage(botToken: string, channelId: string, messageId: string, limits: DiscordRateLimits): Promise<void> {
  try {
    assertMessageId(messageId);
    await discordRequest(botToken, 'DELETE', `/channels/${channelId}/messages/${messageId}`, undefined, limits);
  } catch (err) {
    if (!(err instanceof DiscordApiError && err.status === 404)) throw err;
  }
}
