/**
 * GCA records published by staff (approvals and home overrides), stored in
 * the coordinator's SQLite storage. Once a stored record exists it replaces
 * the GCA_APPROVALS / GCA_HOME_OVERRIDES secrets; GCA_REGIONS stays a secret
 * and every stored record is re-validated against it on each poll.
 *
 * Nothing here logs a VID, a request body or record contents: only versions,
 * an 8-character digest prefix and counts.
 */
import {
  byVid, finishGcaPolicy, parseApprovals, parseGcaPolicy, parseHomeOverrides, parseJsonRejectDuplicateKeys,
  parseRegions, validateApprovals, validateHomeOverrides, type GcaApproval, type GcaPolicy, type GcaRecordsError,
  type GcaRegions,
} from './gca';

/** A validated record: lists keyed by VID string. */
export interface GcaRecords {
  approvals: Record<string, GcaApproval[]>;
  homeOverrides: Record<string, string>;
}

/**
 * A request the Worker has already authenticated (signature, key id and
 * timestamp window checked). The coordinator re-checks its shape, binds it to
 * the method and path of the RPC it reached, and enforces the nonce and rate.
 */
export interface GcaSignedRequest {
  method: string;
  path: string;
  keyId: string;
  /** The signed timestamp (unix ms). */
  ts: number;
  nonce: string;
  bodyBytes: ArrayBuffer | Uint8Array;
}

/** Refusals before any record change: replay or a malformed request (both 401), rate or nonce cap (429). */
export type GcaAdmissionError = 'replay' | 'invalid_request' | 'rate_limited';
/** 400 categories of the PUT body. */
export type GcaBodyError = GcaRecordsError | 'invalid_json' | 'empty_requires_confirm' | 'invalid_base_version';

export type GcaWriteResult =
  | { ok: true; version: string; digest: string; updatedAt: string }
  | { ok: false; error: GcaAdmissionError | GcaBodyError | 'regions_invalid' }
  | { ok: false; error: 'conflict'; currentVersion: string | null; currentDigest: string | null };

export type GcaRecordsSource = 'durable-object' | 'secrets' | 'invalid';

export interface GcaMeta {
  version: string | null;
  digest: string | null;
  updatedAt: string | null;
  counts: { approvals: number; homeOverrides: number };
  source: GcaRecordsSource;
}

export type GcaMetaResult = ({ ok: true } & GcaMeta) | { ok: false; error: GcaAdmissionError };
export type GcaPurgeResult = { ok: true; kept: 0 | 1 } | { ok: false; error: GcaAdmissionError };
export interface GcaDeleteResult { ok: true; deleted: 0 | 1; history: number }

export const GCA_RECORDS_PATH = '/gca/records';
export const GCA_RECORDS_META_PATH = '/gca/records/meta';
export const GCA_RECORDS_PURGE_PATH = '/gca/records/history/purge';
export const GCA_MAX_BODY_BYTES = 64 * 1024;
/** Authenticated write attempts (PUT and purge, including refused ones) per sliding hour. */
export const GCA_WRITES_PER_HOUR = 30;
/** Unexpired nonces kept at most; a request beyond it is refused (429). */
export const GCA_NONCE_CAP = 2000;
export const GCA_HISTORY_MAX_AGE_MS = 30 * 86_400_000;
export const GCA_HISTORY_MAX_VERSIONS = 20;
const HOUR_MS = 3_600_000;
/** Deeper than any valid record (object, list, array, item): refused as invalid JSON. */
const MAX_JSON_DEPTH = 32;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const BASE_VERSION = /^[1-9]\d{0,15}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TABLES = ['gca_records_current', 'gca_records_history', 'gca_records_meta', 'gca_records_nonces', 'gca_records_writes'];

/** Created inside the writing transaction, idempotently; readers never create them. */
export function ensureGcaRecordsSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS gca_records_current (
    id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, digest TEXT NOT NULL,
    updated_at INTEGER NOT NULL, approvals_json TEXT NOT NULL, home_overrides_json TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS gca_records_history (
    version INTEGER PRIMARY KEY, digest TEXT NOT NULL, updated_at INTEGER NOT NULL,
    json TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  sql.exec('CREATE TABLE IF NOT EXISTS gca_records_meta (id INTEGER PRIMARY KEY CHECK (id = 1), next_version INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS gca_records_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS gca_records_nonces_expires_idx ON gca_records_nonces (expires_at)');
  sql.exec('CREATE TABLE IF NOT EXISTS gca_records_writes (at INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS gca_records_writes_at_idx ON gca_records_writes (at)');
}

function existingTables(sql: SqlStorage): Set<string> {
  return new Set(sql.exec<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(', ')})`, ...TABLES,
  ).toArray().map((row) => row.name));
}

// ---------------------------------------------------------------------------
// Canonical JSON and digest (hand-built: never JSON.stringify of an object)

/** Keys in UTF-16 code-unit order (the default sort), so "100001" < "99999" < "4294967297" is not numeric order. */
function sortedKeys(object: object): string[] {
  return Object.keys(object).sort();
}

export function canonicalApprovals(approvals: Record<string, GcaApproval[]>): string {
  return `{${sortedKeys(approvals).map((vid) => `${JSON.stringify(vid)}:[${approvals[vid]!
    .map((item) => `{"level":${canonicalLevel(item.level)},"region":${JSON.stringify(item.region)}}`).join(',')}]`).join(',')}}`;
}

export function canonicalHomeOverrides(homeOverrides: Record<string, string>): string {
  return `{${sortedKeys(homeOverrides).map((vid) => `${JSON.stringify(vid)}:${JSON.stringify(homeOverrides[vid])}`).join(',')}}`;
}

function canonicalLevel(level: number): string {
  if (!Number.isSafeInteger(level)) throw new TypeError('non-integer level');
  return String(level);
}

function joinCanonical(approvalsJson: string, homeOverridesJson: string): string {
  return `{"approvals":${approvalsJson},"homeOverrides":${homeOverridesJson}}`;
}

export function canonicalGcaRecords(records: GcaRecords): string {
  return joinCanonical(canonicalApprovals(records.approvals), canonicalHomeOverrides(records.homeOverrides));
}

export async function sha256Hex(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Strict validation (published and stored records)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Both lists in strict mode against the current regions. */
export function validateGcaRecords(
  approvals: unknown, homeOverrides: unknown, regionNames: Record<string, string>,
): { ok: true; records: GcaRecords } | { ok: false; error: GcaRecordsError } {
  if (!isPlainObject(approvals) || !isPlainObject(homeOverrides)) return { ok: false, error: 'invalid_records' };
  const checkedApprovals = validateApprovals(approvals, regionNames, true);
  if (!checkedApprovals.ok) return checkedApprovals;
  const checkedOverrides = validateHomeOverrides(homeOverrides, true);
  if (!checkedOverrides.ok) return checkedOverrides;
  return { ok: true, records: { approvals: checkedApprovals.value, homeOverrides: checkedOverrides.value } };
}

/** Strict JSON text (duplicate keys, depth): any parse failure, including a RangeError, is null. */
function parseStrictJson(text: string): unknown {
  try {
    return parseJsonRejectDuplicateKeys(text, MAX_JSON_DEPTH);
  } catch {
    return undefined;
  }
}

const BODY_KEYS = new Set(['approvals', 'homeOverrides', 'baseVersion', 'confirmEmpty']);

export type GcaParsedBody =
  | { ok: true; records: GcaRecords; baseVersion: string | null }
  | { ok: false; error: GcaBodyError };

/**
 * The PUT body: fatal UTF-8 without a BOM, strict JSON, exact top-level keys
 * (`confirmEmpty` optional and only `true`), `baseVersion` a decimal string or
 * null, both lists strict. Checked in this order, so the category is stable.
 */
export function parseGcaRecordsBody(bytes: Uint8Array, regionNames: Record<string, string>): GcaParsedBody {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (text.startsWith('﻿')) return { ok: false, error: 'invalid_json' };
  const body = parseStrictJson(text);
  if (!isPlainObject(body)) return { ok: false, error: 'invalid_json' };
  if (Object.keys(body).some((key) => !BODY_KEYS.has(key))) return { ok: false, error: 'unknown_field' };
  if (!Object.hasOwn(body, 'baseVersion')) return { ok: false, error: 'invalid_base_version' };
  const { baseVersion } = body;
  if (baseVersion !== null && (typeof baseVersion !== 'string' || !BASE_VERSION.test(baseVersion))) {
    return { ok: false, error: 'invalid_base_version' };
  }
  if (Object.hasOwn(body, 'confirmEmpty') && body.confirmEmpty !== true) return { ok: false, error: 'invalid_records' };
  const checked = validateGcaRecords(body.approvals, body.homeOverrides, regionNames);
  if (!checked.ok) return checked;
  // An empty approvals list makes every covered controller "unapproved".
  if (!Object.keys(checked.records.approvals).length && body.confirmEmpty !== true) {
    return { ok: false, error: 'empty_requires_confirm' };
  }
  return { ok: true, records: checked.records, baseVersion };
}

// ---------------------------------------------------------------------------
// Reading the stored record (one function for the poll and for meta)

interface CurrentRow {
  version: unknown;
  digest: unknown;
  updated_at: unknown;
  approvals_json: unknown;
  home_overrides_json: unknown;
}

export type GcaResolved =
  | { source: 'secrets' }
  | { source: 'durable-object'; version: number; digest: string; updatedAt: number; records: GcaRecords; regions: GcaRegions }
  | { source: 'invalid'; version: number | null; digest: string | null; updatedAt: number | null };

const validVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const validTime = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8.64e15;
const validDigest = (value: unknown): value is string => typeof value === 'string' && DIGEST.test(value);

function readCurrent(sql: SqlStorage): CurrentRow | undefined {
  return sql.exec<Record<string, SqlStorageValue>>(
    'SELECT version, digest, updated_at, approvals_json, home_overrides_json FROM gca_records_current WHERE id = 1',
  ).toArray()[0] as CurrentRow | undefined;
}

/**
 * Which record drives the policy: a stored record that still validates
 * (exact canonical form, digest, current GCA_REGIONS), else "invalid" (no
 * fallback to the secrets), or the secrets when nothing is stored. Never
 * throws; a storage failure reads as "invalid", since a stored record may exist.
 */
export async function resolveGcaRecords(env: Env, sql: SqlStorage): Promise<GcaResolved> {
  let row: CurrentRow | undefined;
  try {
    if (!existingTables(sql).has('gca_records_current')) return { source: 'secrets' };
    row = readCurrent(sql);
  } catch {
    return { source: 'invalid', version: null, digest: null, updatedAt: null };
  }
  if (!row) return { source: 'secrets' };
  const invalid: GcaResolved = {
    source: 'invalid',
    version: validVersion(row.version) ? row.version : null,
    digest: validDigest(row.digest) ? row.digest : null,
    updatedAt: validTime(row.updated_at) ? row.updated_at : null,
  };
  try {
    const { approvals_json: approvalsJson, home_overrides_json: overridesJson } = row;
    if (invalid.version === null || invalid.digest === null || invalid.updatedAt === null) return invalid;
    if (typeof approvalsJson !== 'string' || typeof overridesJson !== 'string') return invalid;
    const regions = parseRegions(env.GCA_REGIONS);
    if (!regions) return invalid;
    const checked = validateGcaRecords(parseStrictJson(approvalsJson), parseStrictJson(overridesJson), regions.regionNames);
    if (!checked.ok) return invalid;
    const canonicalA = canonicalApprovals(checked.records.approvals);
    const canonicalH = canonicalHomeOverrides(checked.records.homeOverrides);
    if (canonicalA !== approvalsJson || canonicalH !== overridesJson) return invalid;
    if (await sha256Hex(joinCanonical(canonicalA, canonicalH)) !== invalid.digest) return invalid;
    return {
      source: 'durable-object', version: invalid.version, digest: invalid.digest, updatedAt: invalid.updatedAt,
      records: checked.records, regions,
    };
  } catch {
    return invalid;
  }
}

/**
 * Drops non-current history older than 30 days or beyond the newest 20
 * versions. Runs on every write, purge and poll; a no-op without the table.
 */
export function pruneGcaRecordsHistory(sql: SqlStorage, now: number): void {
  const tables = existingTables(sql);
  if (!tables.has('gca_records_history')) return;
  const current = tables.has('gca_records_current') ? 'SELECT version FROM gca_records_current' : 'SELECT NULL WHERE 0';
  sql.exec(`DELETE FROM gca_records_history WHERE version NOT IN (${current}) AND (created_at < ? OR version NOT IN (
    SELECT version FROM gca_records_history ORDER BY version DESC LIMIT ?))`, now - GCA_HISTORY_MAX_AGE_MS, GCA_HISTORY_MAX_VERSIONS);
}

let loggedPruneFailed = false;

/** Test-only: forget which once-per-isolate failures were logged. */
export function resetGcaRecordsLogForTests(): void {
  loggedPruneFailed = false;
}

/**
 * The poll's one GCA policy, used for both reminders and the public marker.
 * Never throws. A stored record wins over the secrets; an invalid stored
 * record turns GCA off (null, logged with reason "records"), with no
 * fallback to secrets that may be older. Without storage, the secrets.
 */
export async function loadGcaPolicy(env: Env, storage?: DurableObjectStorage, now = Date.now()): Promise<GcaPolicy | null> {
  try {
    if (!storage) return parseGcaPolicy(env);
    try {
      pruneGcaRecordsHistory(storage.sql, now);
    } catch (err) {
      if (!loggedPruneFailed) {
        loggedPruneFailed = true;
        console.error(JSON.stringify({ event: 'gca_records_prune_failed', error: err instanceof Error ? err.name : typeof err }));
      }
    }
    const resolved = await resolveGcaRecords(env, storage.sql);
    if (resolved.source === 'secrets') return parseGcaPolicy(env);
    if (resolved.source === 'durable-object') {
      return finishGcaPolicy(env, resolved.regions, byVid(resolved.records.approvals), byVid(resolved.records.homeOverrides));
    }
  } catch {
    // Fall through: an unexpected failure must not stop the public cards.
  }
  console.error(JSON.stringify({ event: 'gca_config_invalid', reason: 'records' }));
  return null;
}

// ---------------------------------------------------------------------------
// Signed requests: admission (nonce + sliding-hour rate) inside the transaction

interface Admitted {
  ts: number;
  nonce: string;
  body: Uint8Array;
}

/** Shape and binding of an already-verified request; null when it does not belong to this RPC. */
function admissible(request: GcaSignedRequest | undefined, method: string, path: string): Admitted | null {
  if (!request || typeof request !== 'object') return null;
  const { method: m, path: p, keyId, ts, nonce, bodyBytes } = request;
  const body = bodyBytes instanceof Uint8Array ? bodyBytes : bodyBytes instanceof ArrayBuffer ? new Uint8Array(bodyBytes) : null;
  if (m !== method || p !== path || typeof keyId !== 'string' || !KEY_ID.test(keyId)) return null;
  if (!Number.isSafeInteger(ts) || ts < 1e12 || ts >= 1e13) return null;
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return null;
  if (!body || body.byteLength > GCA_MAX_BODY_BYTES) return null;
  return { ts, nonce, body };
}

/**
 * Inside the caller's transaction: refuse a replayed nonce (401), a full nonce
 * table or, for writes, a spent hourly budget (429) without recording
 * anything; otherwise record the nonce until max(now + 601 s, ts + 360 s) and,
 * for writes, the attempt. A refusal after this point (400, 409, 503) keeps them.
 */
function admit(sql: SqlStorage, request: Admitted, now: number, countsAsWrite: boolean): GcaAdmissionError | null {
  sql.exec('DELETE FROM gca_records_nonces WHERE expires_at <= ?', now);
  if (sql.exec('SELECT 1 FROM gca_records_nonces WHERE nonce = ?', request.nonce).toArray().length) return 'replay';
  if (sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM gca_records_nonces').one().n >= GCA_NONCE_CAP) return 'rate_limited';
  if (countsAsWrite) {
    sql.exec('DELETE FROM gca_records_writes WHERE at <= ?', now - HOUR_MS);
    if (sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM gca_records_writes').one().n >= GCA_WRITES_PER_HOUR) return 'rate_limited';
    sql.exec('INSERT INTO gca_records_writes (at) VALUES (?)', now);
  }
  sql.exec('INSERT INTO gca_records_nonces (nonce, expires_at) VALUES (?, ?)', request.nonce,
    Math.max(now + 601_000, request.ts + 360_000));
  return null;
}

// ---------------------------------------------------------------------------
// RPC bodies (the coordinator's methods call these)

/**
 * PUT /gca/records. Parsing and the digest run first (pure); then one
 * transaction admits the request, applies the regions, body and baseVersion
 * checks, and stores the record with a new version from a counter that is
 * never reset. A throw inside it rolls everything back, nonce included.
 */
export async function writeGcaRecords(
  storage: DurableObjectStorage, env: Env, request: GcaSignedRequest,
): Promise<GcaWriteResult> {
  const admitted = admissible(request, 'PUT', GCA_RECORDS_PATH);
  if (!admitted) return { ok: false, error: 'invalid_request' };
  const regions = parseRegions(env.GCA_REGIONS);
  const parsed = regions ? parseGcaRecordsBody(admitted.body, regions.regionNames) : undefined;
  const approvalsJson = parsed?.ok ? canonicalApprovals(parsed.records.approvals) : '';
  const overridesJson = parsed?.ok ? canonicalHomeOverrides(parsed.records.homeOverrides) : '';
  const canonical = joinCanonical(approvalsJson, overridesJson);
  const digest = parsed?.ok ? await sha256Hex(canonical) : '';
  const now = Date.now();
  const sql = storage.sql;
  const result = storage.transactionSync((): GcaWriteResult => {
    ensureGcaRecordsSchema(sql);
    const refused = admit(sql, admitted, now, true);
    if (refused) return { ok: false, error: refused };
    if (!parsed) return { ok: false, error: 'regions_invalid' };
    if (!parsed.ok) return parsed;
    const current = sql.exec<{ version: SqlStorageValue; digest: SqlStorageValue }>(
      'SELECT version, digest FROM gca_records_current WHERE id = 1').toArray()[0];
    const currentVersion = current && validVersion(current.version) ? String(current.version) : null;
    if (current ? parsed.baseVersion === null || parsed.baseVersion !== currentVersion : parsed.baseVersion !== null) {
      return {
        ok: false, error: 'conflict', currentVersion,
        currentDigest: current && validDigest(current.digest) ? current.digest : null,
      };
    }
    const counter = sql.exec<{ next_version: SqlStorageValue }>('SELECT next_version FROM gca_records_meta WHERE id = 1').toArray()[0];
    // The counter decides; a damaged counter still never reuses a stored version.
    const floor = currentVersion === null ? 1 : Number(currentVersion) + 1;
    const version = Math.max(counter && validVersion(counter.next_version) ? counter.next_version : 1, floor,
      (sql.exec<{ v: number | null }>('SELECT MAX(version) AS v FROM gca_records_history').one().v ?? 0) + 1);
    sql.exec('INSERT OR REPLACE INTO gca_records_meta (id, next_version) VALUES (1, ?)', version + 1);
    sql.exec(`INSERT OR REPLACE INTO gca_records_current (id, version, digest, updated_at, approvals_json, home_overrides_json)
      VALUES (1, ?, ?, ?, ?, ?)`, version, digest, now, approvalsJson, overridesJson);
    sql.exec('INSERT INTO gca_records_history (version, digest, updated_at, json, created_at) VALUES (?, ?, ?, ?, ?)',
      version, digest, now, canonical, now);
    pruneGcaRecordsHistory(sql, now);
    return { ok: true, version: String(version), digest, updatedAt: new Date(now).toISOString() };
  });
  if (result.ok && parsed?.ok) {
    console.log(JSON.stringify({
      event: 'gca_records_updated', version: result.version, digestPrefix: digest.slice(0, 8),
      counts: { approvals: Object.keys(parsed.records.approvals).length, homeOverrides: Object.keys(parsed.records.homeOverrides).length },
    }));
  }
  return result;
}

/**
 * GET /gca/records/meta when signed (the nonce is consumed, not counted as a
 * write), or the operator's bearer route when `request` is omitted. The
 * source comes from resolveGcaRecords, the same function the poll uses.
 */
export async function gcaRecordsMeta(
  storage: DurableObjectStorage, env: Env, request?: GcaSignedRequest,
): Promise<GcaMetaResult> {
  if (request !== undefined) {
    const admitted = admissible(request, 'GET', GCA_RECORDS_META_PATH);
    if (!admitted || admitted.body.byteLength) return { ok: false, error: 'invalid_request' };
    const now = Date.now();
    const refused = storage.transactionSync(() => {
      ensureGcaRecordsSchema(storage.sql);
      return admit(storage.sql, admitted, now, false);
    });
    if (refused) return { ok: false, error: refused };
  }
  const resolved = await resolveGcaRecords(env, storage.sql);
  if (resolved.source === 'durable-object') {
    return {
      ok: true, source: resolved.source, version: String(resolved.version), digest: resolved.digest,
      updatedAt: new Date(resolved.updatedAt).toISOString(),
      counts: {
        approvals: Object.keys(resolved.records.approvals).length,
        homeOverrides: Object.keys(resolved.records.homeOverrides).length,
      },
    };
  }
  if (resolved.source === 'invalid') {
    return {
      ok: true, source: resolved.source, version: resolved.version === null ? null : String(resolved.version),
      digest: resolved.digest, updatedAt: resolved.updatedAt === null ? null : new Date(resolved.updatedAt).toISOString(),
      counts: { approvals: 0, homeOverrides: 0 },
    };
  }
  // Counts of the secrets in use (0 when unusable), without logging.
  const regions = parseRegions(env.GCA_REGIONS);
  const approvals = regions ? parseApprovals(env.GCA_APPROVALS, regions.regionNames) : null;
  const overrides = parseHomeOverrides(env.GCA_HOME_OVERRIDES);
  return {
    ok: true, source: 'secrets', version: null, digest: null, updatedAt: null,
    counts: { approvals: approvals ? Object.keys(approvals).length : 0, homeOverrides: overrides ? Object.keys(overrides).length : 0 },
  };
}

/** POST /gca/records/history/purge: keeps only the current version's history row (kept 0 without a record). */
export function purgeGcaRecordsHistory(storage: DurableObjectStorage, request: GcaSignedRequest): GcaPurgeResult {
  const admitted = admissible(request, 'POST', GCA_RECORDS_PURGE_PATH);
  if (!admitted || admitted.body.byteLength) return { ok: false, error: 'invalid_request' };
  const now = Date.now();
  const sql = storage.sql;
  const result = storage.transactionSync((): GcaPurgeResult => {
    ensureGcaRecordsSchema(sql);
    const refused = admit(sql, admitted, now, true);
    if (refused) return { ok: false, error: refused };
    sql.exec('DELETE FROM gca_records_history WHERE version NOT IN (SELECT version FROM gca_records_current)');
    const kept = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM gca_records_history').one().n;
    return { ok: true, kept: kept ? 1 : 0 };
  });
  if (result.ok) console.log(JSON.stringify({ event: 'gca_records_purged', kept: result.kept }));
  return result;
}

/**
 * Operator emergency delete (HISTORY_SECRET bearer route): removes the
 * current record and all history. The version counter, nonces and write
 * attempts stay, so a later record never reuses a version (no ABA).
 */
export function deleteGcaRecords(storage: DurableObjectStorage): GcaDeleteResult {
  const sql = storage.sql;
  const result = storage.transactionSync((): GcaDeleteResult => {
    const tables = existingTables(sql);
    const clear = (table: string) => {
      if (!tables.has(table)) return 0;
      const { n } = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one();
      sql.exec(`DELETE FROM ${table}`);
      return n;
    };
    const deleted = clear('gca_records_current');
    const history = clear('gca_records_history');
    return { ok: true, deleted: deleted ? 1 : 0, history };
  });
  console.log(JSON.stringify({ event: 'gca_records_deleted', deleted: result.deleted, history: result.history }));
  return result;
}
