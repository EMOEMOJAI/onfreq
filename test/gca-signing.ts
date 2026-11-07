/**
 * Test-side signer for the GCA records routes, written from the contract with
 * Web Crypto (independent of src/gca-records-http.ts), plus an env whose
 * coordinator runs the real PollCoordinator code on the real "onfreq" storage
 * with chosen settings (the Durable Object's own bindings have no GCA_REGIONS).
 */
import { env } from 'cloudflare:workers';
import { SELF, runInDurableObject } from 'cloudflare:test';
import worker from '../src/index';
import { COORDINATOR_NAME } from '../src/config';
import { PollCoordinator } from '../src/coordinator';
import type { GcaSignedRequest } from '../src/gca-records';

/** The plan's fixed-vector dummy key: the GCA_ADMIN_HMAC_KEY binding in vitest.config.ts. */
export const KEY = 'synthetic-gca-admin-test-key-0001-abcdef';
/** The distinct GCA_ADMIN_HMAC_KEY_NEXT binding. */
export const NEXT_KEY = 'synthetic-gca-admin-next-key-0002-abcdef';
/** 2026-01-01T00:00:00.000Z, the fixed vectors' timestamp. */
export const START = 1_767_225_600_000;
export const ORIGIN = 'https://example.com';

/** Fictional coverage naming the fixed vectors' synthetic regions. */
export const VECTOR_REGIONS = JSON.stringify({
  AA: { name: 'Example One', prefixes: ['XA'] },
  AB: { name: 'Example Three', prefixes: ['XC'] },
  AC: { name: 'Example Two', prefixes: ['XB'] },
  AD: { name: 'Example Four', prefixes: ['XD'] },
});

const encode = (text: string) => new TextEncoder().encode(text);
export const hexOf = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (data: string | Uint8Array) =>
  hexOf(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encode(data) : data));
export const keyIdOf = async (key: string) => (await sha256(`onfreq-gca-key-id-v1\n${key}`)).slice(0, 16);

export async function hmacHex(key: string, text: string): Promise<string> {
  const imported = await crypto.subtle.importKey('raw', encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await crypto.subtle.sign('HMAC', imported, encode(text)));
}

export interface SignOptions {
  body?: string | Uint8Array;
  key?: string;
  ts?: number;
  nonce?: string;
  /** Header overrides applied after signing (null removes the header). */
  headers?: Record<string, string | null>;
  /** Appended to the URL after signing, e.g. a query or trailing slash. */
  suffix?: string;
}

export interface Signed {
  url: string;
  init: RequestInit;
  nonce: string;
  signature: string;
}

/** A request signed per the contract: METHOD\nPATH\nkeyId\nts\nnonce\nhex(sha256(body)). */
export async function sign(method: string, path: string, options: SignOptions = {}): Promise<Signed> {
  const { key = KEY, ts = Date.now(), nonce = crypto.randomUUID() } = options;
  const body = typeof options.body === 'string' ? encode(options.body) : options.body ?? new Uint8Array();
  const keyId = await keyIdOf(key);
  const signature = await hmacHex(key, `${method}\n${path}\n${keyId}\n${ts}\n${nonce}\n${await sha256(body)}`);
  const headers: Record<string, string> = {
    'x-xe-gca-key-id': keyId, 'x-xe-gca-timestamp': String(ts), 'x-xe-gca-nonce': nonce, 'x-xe-gca-signature': signature,
  };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  return {
    url: `${ORIGIN}${path}${options.suffix ?? ''}`, nonce, signature,
    init: { method, headers, body: body.byteLength ? body : undefined },
  };
}

/** Through the real Worker entry and the real "onfreq" coordinator (bindings as configured). */
export const viaSelf = (request: Signed) => SELF.fetch(request.url, request.init);

/**
 * An env whose POLL_COORDINATOR runs the real coordinator code on the real
 * "onfreq" storage, with `coordinatorSettings` as the Durable Object's env.
 */
export function recordsEnv(overrides: Partial<Env> = {}, coordinatorSettings: Partial<Env> = { GCA_REGIONS: VECTOR_REGIONS }): Env {
  const call = <T>(run: (coordinator: PollCoordinator) => T | Promise<T>) =>
    runInDurableObject(env.POLL_COORDINATOR.getByName(COORDINATOR_NAME), (_instance, ctx) =>
      run(new PollCoordinator(ctx, { ...env, ...coordinatorSettings })));
  const coordinator = {
    gcaRecordsWrite: (request: GcaSignedRequest) => call((c) => c.gcaRecordsWrite(request)),
    gcaRecordsMeta: (request?: GcaSignedRequest) => call((c) => c.gcaRecordsMeta(request)),
    gcaRecordsPurge: (request: GcaSignedRequest) => call((c) => c.gcaRecordsPurge(request)),
    gcaRecordsOperatorDelete: () => call((c) => c.gcaRecordsOperatorDelete()),
  };
  return { ...env, ...overrides, POLL_COORDINATOR: { getByName: () => coordinator } as unknown as Env['POLL_COORDINATOR'] };
}

/** Through the Worker entry with `recordsEnv`. */
export function viaWorker(request: Signed | Request, config: Env = recordsEnv()): Promise<Response> {
  const req = request instanceof Request ? request : new Request(request.url, request.init);
  return worker.fetch(req as Parameters<typeof worker.fetch>[0], config, {} as ExecutionContext);
}

/** Row counts of every records table in the "onfreq" coordinator (0 for a missing table). */
export function recordRows() {
  return runInDurableObject(env.POLL_COORDINATOR.getByName(COORDINATOR_NAME), (_instance, ctx) => {
    const sql = ctx.storage.sql;
    const tables = new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name));
    const count = (table: string) => tables.has(table) ? sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n : 0;
    return {
      current: count('gca_records_current'), history: count('gca_records_history'),
      nonces: count('gca_records_nonces'), writes: count('gca_records_writes'),
    };
  });
}

/** A PUT body: the vector record by default, with overrides. */
export const recordBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  approvals: { 100001: [{ level: 3, region: 'AA' }] }, homeOverrides: {}, baseVersion: null, ...overrides,
});
