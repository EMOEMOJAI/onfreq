/**
 * Signed GCA records routes for the staff website:
 *   PUT  /gca/records                  publish a record
 *   GET  /gca/records/meta             current version, digest and source
 *   POST /gca/records/history/purge    keep only the current history row
 *
 * Each request is signed with HMAC-SHA256 under GCA_ADMIN_HMAC_KEY (or, during
 * rotation, GCA_ADMIN_HMAC_KEY_NEXT). The Worker checks everything it can
 * without state, in a fixed order, before the coordinator is called, so
 * unauthenticated traffic never touches Durable Object storage:
 *   method (405) -> raw `?` (400) -> key configuration (503) -> header formats
 *   (401) -> body size (413) -> timestamp window (401) -> key id and signature
 *   (401) -> coordinator RPC (nonce, rate, validation, version).
 *
 * Nothing here logs a nonce, key id, signature, body or key: rejections log a
 * fixed reason once per isolate.
 */
import { configuredSecret, GCA_KEY_NAMES, logConfigInvalidOnce } from './auth';
import { getCoordinator } from './config';
import { BodyTooLargeError, errorResponse, readCapped } from './http';
import {
  GCA_MAX_BODY_BYTES, GCA_RECORDS_META_PATH, GCA_RECORDS_PATH, GCA_RECORDS_PURGE_PATH,
  type GcaMeta, type GcaMetaResult, type GcaPurgeResult, type GcaSignedRequest, type GcaWriteResult,
} from './gca-records';

/** Accept a signed timestamp at most this far from the Worker's clock, either way. */
export const GCA_TIMESTAMP_TOLERANCE_MS = 300_000;

/** Domain separation for the public key id, so it is never a hash of the bare key. */
const KEY_ID_PREFIX = 'onfreq-gca-key-id-v1\n';

/** The one allowed method of each signed route (exact pathname match). */
export const GCA_SIGNED_ROUTES: ReadonlyMap<string, 'PUT' | 'GET' | 'POST'> = new Map([
  [GCA_RECORDS_PATH, 'PUT'],
  [GCA_RECORDS_META_PATH, 'GET'],
  [GCA_RECORDS_PURGE_PATH, 'POST'],
]);

const KEY_ID = /^[0-9a-f]{16}$/;
const TIMESTAMP = /^[1-9]\d{12}$/;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

/** Secrets a GCA key must never equal: they are held by monitors, staff, IVAO or Discord. */
const OTHER_SECRETS = ['POLL_SECRET', 'HISTORY_SECRET', 'IVAO_WEBHOOK_SECRET', 'IVAO_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'] as const;

/** Fixed rejection reasons, logged without any request content. */
type RejectReason =
  | 'method_not_allowed' | 'query_not_allowed' | 'endpoint_disabled' | 'headers_invalid' | 'payload_too_large'
  | 'body_unreadable' | 'timestamp_out_of_window' | 'unknown_key_id' | 'signature_mismatch'
  | 'replay' | 'invalid_request' | 'rate_limited' | 'conflict' | 'regions_invalid' | 'coordinator_unavailable'
  | 'invalid_json' | 'invalid_records' | 'unknown_field' | 'too_many_vids' | 'too_many_approvals'
  | 'empty_requires_confirm' | 'invalid_base_version';

/** 400 categories returned as `{ error: <category> }`. */
const BAD_REQUEST = new Set<RejectReason>([
  'invalid_json', 'invalid_records', 'unknown_field', 'too_many_vids', 'too_many_approvals',
  'empty_requires_confirm', 'invalid_base_version',
]);

const loggedRejections = new Set<RejectReason>();

function logRejectionOnce(reason: RejectReason): void {
  if (loggedRejections.has(reason)) return;
  loggedRejections.add(reason);
  console.error(JSON.stringify({ event: 'gca_records_rejected', reason }));
}

/** Test-only: forget which rejections were logged and which keys were imported. */
export function resetGcaRecordsHttpForTests(): void {
  loggedRejections.clear();
  keyCache.clear();
}

const unauthorized = (reason: RejectReason) => {
  logRejectionOnce(reason);
  return errorResponse('unauthorized', 401);
};

// ---------------------------------------------------------------------------
// Keys

interface GcaKey {
  id: string;
  key: CryptoKey;
}

/** Imported keys by secret value, reused across requests in this isolate. */
const keyCache = new Map<string, Promise<GcaKey>>();
/** More distinct keys than a rotation needs means the cache is cleared rather than grown. */
const KEY_CACHE_MAX = 4;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** First 16 lowercase hex of SHA-256("onfreq-gca-key-id-v1\n" + trimmed key). */
export async function gcaKeyId(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY_ID_PREFIX + secret));
  return hex(digest).slice(0, 16);
}

function importGcaKey(secret: string): Promise<GcaKey> {
  let entry = keyCache.get(secret);
  if (!entry) {
    if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
    entry = (async () => ({
      id: await gcaKeyId(secret),
      key: await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']),
    }))();
    const pending = entry;
    keyCache.set(secret, pending);
    // A failed import must not stay cached.
    pending.catch(() => { if (keyCache.get(secret) === pending) keyCache.delete(secret); });
  }
  return entry;
}

/**
 * The configured signing secrets (primary first), or null when the endpoint is
 * disabled: the primary unset, any set key shorter than 32 characters, the
 * next key equal to the primary, or either key equal to another secret. Each
 * reason is logged once per isolate, by name only.
 */
export function gcaSecrets(env: Env): string[] | null {
  const [primaryName, nextName] = GCA_KEY_NAMES;
  const primary = configuredSecret(env[primaryName], primaryName);
  if (!primary) {
    if (!env[primaryName]?.trim()) logConfigInvalidOnce(`${primaryName}_unset`);
    return null;
  }
  const secrets = [primary];
  if (env[nextName]?.trim()) {
    const next = configuredSecret(env[nextName], nextName);
    if (!next) return null;
    if (next === primary) {
      logConfigInvalidOnce(`${nextName}_equals_${primaryName}`);
      return null;
    }
    secrets.push(next);
  }
  for (const [index, secret] of secrets.entries()) {
    for (const other of OTHER_SECRETS) {
      if (secret === env[other]?.trim()) {
        logConfigInvalidOnce(`${GCA_KEY_NAMES[index]}_reuses_${other}`);
        return null;
      }
    }
  }
  return secrets;
}

// ---------------------------------------------------------------------------
// Request checks

interface SignedHeaders {
  keyId: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

function signedHeaders(headers: Headers): SignedHeaders | null {
  const keyId = headers.get('x-xe-gca-key-id');
  const timestamp = headers.get('x-xe-gca-timestamp');
  const nonce = headers.get('x-xe-gca-nonce');
  const signature = headers.get('x-xe-gca-signature');
  if (keyId === null || !KEY_ID.test(keyId) || timestamp === null || !TIMESTAMP.test(timestamp) ||
      nonce === null || !NONCE.test(nonce) || signature === null || !SIGNATURE.test(signature)) return null;
  return { keyId, timestamp, nonce, signature };
}

/** The raw body, null when it exceeds the cap (declared or streamed). Other read failures throw. */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > GCA_MAX_BODY_BYTES) return null;
  try {
    return await readCapped(request.body, GCA_MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return null;
    throw err;
  }
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** `METHOD\nPATH\nkeyId\ntimestamp\nnonce\nhex(sha256(body))`, as UTF-8. */
async function signedContent(method: string, path: string, headers: SignedHeaders, body: Uint8Array): Promise<Uint8Array> {
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', body));
  return new TextEncoder().encode(`${method}\n${path}\n${headers.keyId}\n${headers.timestamp}\n${headers.nonce}\n${bodyHash}`);
}

/**
 * True when the key id names a configured key and the signature verifies
 * under it. `crypto.subtle.verify` compares in constant time.
 */
async function verified(
  secrets: string[], method: string, path: string, headers: SignedHeaders, body: Uint8Array,
): Promise<'ok' | 'unknown_key_id' | 'signature_mismatch'> {
  const keys = await Promise.all(secrets.map(importGcaKey));
  const match = keys.find((key) => key.id === headers.keyId);
  if (!match) return 'unknown_key_id';
  const content = await signedContent(method, path, headers, body);
  return await crypto.subtle.verify('HMAC', match.key, hexBytes(headers.signature), content) ? 'ok' : 'signature_mismatch';
}

// ---------------------------------------------------------------------------
// Coordinator results

type RpcError = Exclude<GcaWriteResult | GcaMetaResult | GcaPurgeResult, { ok: true }>;

/** Map a coordinator refusal to its fixed response; an unknown error is a generic 503. */
function refused(result: RpcError): Response {
  switch (result.error) {
    case 'replay':
    case 'invalid_request':
      return unauthorized(result.error);
    case 'rate_limited':
      logRejectionOnce('rate_limited');
      return errorResponse('rate_limited', 429);
    case 'conflict':
      logRejectionOnce('conflict');
      return Response.json({ currentVersion: result.currentVersion, currentDigest: result.currentDigest }, { status: 409 });
    case 'regions_invalid':
      logRejectionOnce('regions_invalid');
      return errorResponse('gca regions invalid', 503);
    default: {
      const category = result.error as RejectReason;
      if (BAD_REQUEST.has(category)) {
        logRejectionOnce(category);
        return errorResponse(category, 400);
      }
      logRejectionOnce('coordinator_unavailable');
      return errorResponse('coordinator unavailable', 503);
    }
  }
}

/** The meta response body, exactly the contract's fields (shared with the operator route). */
export function gcaMetaResponse(meta: GcaMeta): Response {
  const { version, digest, updatedAt, counts, source } = meta;
  return Response.json({ version, digest, updatedAt, counts: { approvals: counts.approvals, homeOverrides: counts.homeOverrides }, source });
}

async function callCoordinator(env: Env, signed: GcaSignedRequest): Promise<Response> {
  const coordinator = getCoordinator(env);
  if (signed.path === GCA_RECORDS_PATH) {
    const result = await coordinator.gcaRecordsWrite(signed);
    if (!result.ok) return refused(result);
    return Response.json({ version: result.version, digest: result.digest, updatedAt: result.updatedAt });
  }
  if (signed.path === GCA_RECORDS_META_PATH) {
    const result = await coordinator.gcaRecordsMeta(signed);
    if (!result.ok) return refused(result);
    return gcaMetaResponse(result);
  }
  const result = await coordinator.gcaRecordsPurge(signed);
  if (!result.ok) return refused(result);
  return Response.json({ ok: true, kept: result.kept });
}

/**
 * One signed route. The caller marks the response no-store; this function
 * never throws for a coordinator failure (generic 503, error type logged).
 */
export async function handleGcaRecords(request: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  const method = GCA_SIGNED_ROUTES.get(path);
  if (!method) return new Response('Not found', { status: 404 });
  if (request.method !== method) {
    logRejectionOnce('method_not_allowed');
    return errorResponse('method not allowed', 405, { allow: method });
  }
  // Any query, even an empty one: the signature covers the path only.
  if (request.url.includes('?')) {
    logRejectionOnce('query_not_allowed');
    return errorResponse('query_not_allowed', 400);
  }
  const secrets = gcaSecrets(env);
  if (!secrets) {
    logRejectionOnce('endpoint_disabled');
    return errorResponse('endpoint disabled', 503);
  }
  const headers = signedHeaders(request.headers);
  if (!headers) return unauthorized('headers_invalid');
  let body: Uint8Array | null;
  try {
    body = await readBody(request);
  } catch {
    return unauthorized('body_unreadable');
  }
  if (!body) {
    logRejectionOnce('payload_too_large');
    return errorResponse('payload too large', 413);
  }
  const ts = Number(headers.timestamp);
  if (Math.abs(Date.now() - ts) > GCA_TIMESTAMP_TOLERANCE_MS) return unauthorized('timestamp_out_of_window');
  const check = await verified(secrets, method, path, headers, body);
  if (check !== 'ok') return unauthorized(check);
  try {
    return await callCoordinator(env, { method, path, keyId: headers.keyId, ts, nonce: headers.nonce, bodyBytes: body });
  } catch (err) {
    logRejectionOnce('coordinator_unavailable');
    console.error(JSON.stringify({
      event: 'route_failed', route: path, error: err instanceof Error ? err.name : typeof err,
    }));
    return errorResponse('coordinator unavailable', 503);
  }
}
