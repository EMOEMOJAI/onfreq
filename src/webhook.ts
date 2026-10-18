/**
 * Optional IVAO webhook. A verified `tracker.session.started` event for a
 * monitored ATC callsign only asks the coordinator for an earlier poll: the
 * payload is never stored, logged or used as session data.
 *
 * Requests are authenticated by their Hook0 signature, keyed by
 * IVAO_WEBHOOK_SECRET (the webhook's Signing Secret). Nothing reaches the
 * coordinator before the signature verifies.
 */
import { configuredSecret, logConfigInvalidOnce } from './auth';
import { getCoordinator } from './config';
import { BodyTooLargeError, errorResponse, readCapped } from './http';
import { isDivisionCallsign, isExcludedCallsign, parseExcludedCallsigns, parsePrefixes } from './ivao';

export const WEBHOOK_PATH = '/ivao/webhook';

/** IVAO event payloads are a few hundred bytes. */
export const WEBHOOK_MAX_BODY_BYTES = 8 * 1024;

/** Hook0 replay window: a signature older or newer than this is rejected. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * After a coordinator call that leaves an early-poll alarm pending, this
 * isolate skips further calls for this long, or until that alarm's time if
 * sooner. A skipped hint is covered: the pending alarm has not fired yet. A
 * call that scheduled nothing starts no debounce.
 */
export const WEBHOOK_DEBOUNCE_MS = 15_000;

/**
 * Handled event ids are remembered this long: a signature stays acceptable for
 * SIGNATURE_TOLERANCE_SECONDS on either side of its timestamp, so a request
 * accepted now can be replayed for up to twice that. Hook0 timestamps are
 * whole seconds, so add one second.
 */
export const WEBHOOK_SEEN_EVENT_TTL_MS = (2 * SIGNATURE_TOLERANCE_SECONDS + 1) * 1000;

/** At most this many remembered event ids per isolate; the oldest is evicted first. */
export const WEBHOOK_SEEN_EVENTS_MAX = 1_000;

/** The headers every accepted signature must cover. */
const REQUIRED_SIGNED_HEADERS = ['x-event-type', 'x-event-id'];

/** Fixed rejection reasons, logged without any request content. */
type RejectReason =
  | 'signature_header_invalid'
  | 'signature_expired'
  | 'signed_headers_invalid'
  | 'signed_header_missing'
  | 'payload_too_large'
  | 'body_unreadable'
  | 'signature_mismatch';

/** The parts of a Hook0 signature header needed to verify a request. */
interface SignedRequest {
  /** `{t}.{h}.{values of the listed headers, joined by "."}.`, signed before the raw body. */
  prefix: string;
  /** One or two decoded `v1` HMAC-SHA256 values. */
  signatures: Uint8Array[];
}

/** One line per reason per isolate: unauthenticated traffic must not multiply log lines. */
const loggedRejections = new Set<RejectReason>();

function logRejectionOnce(reason: RejectReason): void {
  if (loggedRejections.has(reason)) return;
  loggedRejections.add(reason);
  console.error(JSON.stringify({ event: 'webhook_rejected', reason }));
}

/** Test-only: forget which webhook rejections were logged. */
export function resetWebhookLogForTests(): void {
  loggedRejections.clear();
}

/**
 * The current debounce: started when a coordinator call left an alarm
 * pending, ending at the earlier of WEBHOOK_DEBOUNCE_MS later and that alarm.
 */
let earlyPollDebounce: { from: number; until: number } | undefined;

/** Test-only: forget the last early-poll request, ending the debounce. */
export function resetWebhookDebounceForTests(): void {
  earlyPollDebounce = undefined;
}

/** True while the debounce runs; a start later than now (clock moved back) is ignored. */
function debounced(now: number): boolean {
  return earlyPollDebounce !== undefined && earlyPollDebounce.from <= now && now < earlyPollDebounce.until;
}

/**
 * Handled event ids and their expiry (epoch ms), in insertion order. A replay
 * within the signature window is acknowledged without another coordinator
 * call. Per isolate only, so another isolate may still handle a replay once.
 * Event ids are never logged.
 */
const seenEvents = new Map<string, number>();

/** Test-only: forget every handled event id. */
export function resetWebhookSeenEventsForTests(): void {
  seenEvents.clear();
}

function seenRecently(id: string, now: number): boolean {
  const expiry = seenEvents.get(id);
  return expiry !== undefined && expiry > now;
}

function recordSeen(id: string, now: number): void {
  for (const [seenId, expiry] of seenEvents) {
    if (expiry <= now) seenEvents.delete(seenId);
  }
  // Re-inserting moves an id to the newest position.
  seenEvents.delete(id);
  while (seenEvents.size >= WEBHOOK_SEEN_EVENTS_MAX) {
    const oldest = seenEvents.keys().next().value;
    if (oldest === undefined) break;
    seenEvents.delete(oldest);
  }
  seenEvents.set(id, now + WEBHOOK_SEEN_EVENT_TTL_MS);
}

/**
 * The configured signing secret, or '' when the webhook is disabled. Unset or
 * short secrets disable it, as does reusing another secret: bearer secrets are
 * held by monitors and staff, and API credentials must never double as a
 * signing key for network events.
 */
function webhookSecret(env: Env): string {
  const secret = configuredSecret(env.IVAO_WEBHOOK_SECRET, 'IVAO_WEBHOOK_SECRET');
  if (!secret) return '';
  for (const other of ['POLL_SECRET', 'HISTORY_SECRET', 'IVAO_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'] as const) {
    if (secret === env[other]?.trim()) {
      logConfigInvalidOnce(`IVAO_WEBHOOK_SECRET_reuses_${other}`);
      return '';
    }
  }
  return secret;
}

/**
 * Parse `X-Hook0-Signature` (`t=<unix s>,h=<header names>,v1=<hex>`) and
 * collect the signed header values. Exactly one `t` and `h` and one or two
 * `v1` values are accepted; other keys are ignored. Every listed header must
 * be present: a missing one is rejected, never signed as ''.
 */
export function parseHook0Signature(headers: Headers, nowSeconds: number): SignedRequest | RejectReason {
  const header = headers.get('x-hook0-signature');
  if (!header) return 'signature_header_invalid';
  const timestamps: string[] = [];
  const names: string[] = [];
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const split = part.indexOf('=');
    if (split < 1) return 'signature_header_invalid';
    const key = part.slice(0, split);
    const value = part.slice(split + 1);
    if (key === 't') timestamps.push(value);
    else if (key === 'h') names.push(value);
    else if (key === 'v1') signatures.push(value);
  }
  const [t] = timestamps;
  const [h] = names;
  if (timestamps.length !== 1 || names.length !== 1 || t === undefined || h === undefined ||
      !/^\d{1,12}$/.test(t) || signatures.length < 1 || signatures.length > 2 ||
      !signatures.every((signature) => /^[0-9a-f]{64}$/.test(signature))) {
    return 'signature_header_invalid';
  }
  if (Math.abs(nowSeconds - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return 'signature_expired';
  const listed = h.split(' ');
  if (!listed.every((name) => /^[a-z0-9-]+$/.test(name)) || new Set(listed).size !== listed.length ||
      !REQUIRED_SIGNED_HEADERS.every((name) => listed.includes(name))) {
    return 'signed_headers_invalid';
  }
  const values: string[] = [];
  for (const name of listed) {
    const value = headers.get(name);
    if (value === null) return 'signed_header_missing';
    values.push(value);
  }
  // Hook0's dot-joined format is ambiguous by design: values may contain '.',
  // so different header values can sign the same content. Accepted here
  // because a verified request only ever causes one capped early poll.
  return { prefix: `${t}.${h}.${values.join('.')}.`, signatures: signatures.map(hexBytes) };
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** The imported key for the current secret, reused across requests in this isolate. */
let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    const key = crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    cachedKey = { secret, key };
    // A failed import must not stay cached.
    key.catch(() => { if (cachedKey?.key === key) cachedKey = undefined; });
  }
  return cachedKey.key;
}

/**
 * True when any `v1` value is the HMAC-SHA256 of the signed prefix followed
 * by the raw body bytes. `crypto.subtle.verify` compares in constant time.
 */
export async function verifyHook0Signature(secret: string, signed: SignedRequest, body: Uint8Array): Promise<boolean> {
  const prefix = new TextEncoder().encode(signed.prefix);
  const content = new Uint8Array(prefix.byteLength + body.byteLength);
  content.set(prefix);
  content.set(body, prefix.byteLength);
  const key = await hmacKey(secret);
  for (const signature of signed.signatures) {
    if (await crypto.subtle.verify('HMAC', key, signature, content)) return true;
  }
  return false;
}

/** The raw body, or null when it exceeds the cap, declared or streamed. */
async function readCappedBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) return null;
  try {
    return await readCapped(request.body, WEBHOOK_MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return null;
    throw err;
  }
}

/** True only for a new ATC connection on a monitored, non-excluded callsign. */
function wantsEarlyPoll(eventType: string | null, body: Uint8Array, env: Env): boolean {
  if (eventType !== 'tracker.session.started') return false;
  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return false;
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const { connectionType, callsign } = event as Record<string, unknown>;
  if (connectionType !== 'ATC' || typeof callsign !== 'string' || !callsign) return false;
  let prefixes: string[];
  try {
    prefixes = parsePrefixes(env.FIR_PREFIXES);
  } catch {
    return false;
  }
  return isDivisionCallsign(callsign, prefixes) &&
    !isExcludedCallsign(callsign, parseExcludedCallsigns(env.EXCLUDED_CALLSIGNS));
}

/**
 * POST /ivao/webhook. Checks run in order and stop at the first failure:
 * configured secret, signature header, timestamp, signed headers, body size,
 * then the HMAC. Every verified event is acknowledged with 204, so IVAO does
 * not retry events this bot ignores. A coordinator failure is thrown, for the
 * caller's generic 503. Only an acknowledged event id is remembered: IVAO
 * retries a failed delivery with the same id.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = webhookSecret(env);
  if (!secret) return errorResponse('endpoint disabled', 503);
  const signed = parseHook0Signature(request.headers, Math.floor(Date.now() / 1000));
  if (typeof signed === 'string') {
    logRejectionOnce(signed);
    return errorResponse('unauthorized', 401);
  }
  let body: Uint8Array | null;
  try {
    body = await readCappedBody(request);
  } catch {
    logRejectionOnce('body_unreadable');
    return errorResponse('bad request', 400);
  }
  if (!body) {
    logRejectionOnce('payload_too_large');
    return errorResponse('payload too large', 413);
  }
  if (!(await verifyHook0Signature(secret, signed, body))) {
    logRejectionOnce('signature_mismatch');
    return errorResponse('unauthorized', 401);
  }
  // A signed required header, so always present.
  const eventId = request.headers.get('x-event-id') ?? '';
  const now = Date.now();
  if (seenRecently(eventId, now)) return new Response(null, { status: 204 });
  if (wantsEarlyPoll(request.headers.get('x-event-type'), body, env) && !debounced(now)) {
    // Cleared first, so a failed call never debounces the next event.
    earlyPollDebounce = undefined;
    const alarmAt = await getCoordinator(env).requestEarlyPoll();
    if (typeof alarmAt === 'number') {
      earlyPollDebounce = { from: now, until: Math.min(now + WEBHOOK_DEBOUNCE_MS, alarmAt) };
    }
  }
  recordSeen(eventId, now);
  return new Response(null, { status: 204 });
}
