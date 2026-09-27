import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { vi } from 'vitest';
import worker from '../src/index';
import { COORDINATOR_NAME } from '../src/config';
import { ensureGcaSchema } from '../src/gca';

/** Bearer header matching the synthetic POLL_SECRET binding in vitest.config.ts (/poll, /health). */
export const AUTH_HEADERS = { authorization: 'Bearer synthetic-poll-secret-for-vitest-only' } as const;

/** Bearer header matching the distinct synthetic HISTORY_SECRET binding (/gca-history routes). */
export const HISTORY_AUTH_HEADERS = { authorization: 'Bearer synthetic-history-secret-for-vitest-only' } as const;

/** Synthetic, distinct secrets for explicit overrides, so route separation does not depend on the fixture. */
export const POLL_ONLY = 'synthetic-poll-only-secret-0123456789';
export const HISTORY_ONLY = 'synthetic-history-only-secret-01234567';

/** Call a route directly with a bearer token and binding overrides. */
export function callRoute(
  path: string, method: string, token: string, overrides: Partial<Env>, headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`https://example.com${path}`, { method, headers: { authorization: `Bearer ${token}`, ...headers } }),
    { ...env, ...overrides }, {} as ExecutionContext);
}

/** A synthetic Discord snowflake created at `ms`, with `n` in its low (worker/sequence) bits. */
export function snowflakeAt(ms: number, n = 0): string {
  return ((BigInt(ms - 1_420_070_400_000) << 22n) + BigInt(n)).toString();
}

/** A synthetic bot user id, and a token whose first segment encodes it so channel scans recognise its messages. */
export const BOT_ID = '100000000000000009';
export const BOT_TOKEN = `${btoa(BOT_ID)}.synthetic.token`;

/** Create the coordinator's real GCA tables, then seed them. */
export function seedGca(seed: (sql: SqlStorage) => void): Promise<void> {
  return runInDurableObject(env.POLL_COORDINATOR.getByName(COORDINATOR_NAME), (_instance, ctx) => {
    ensureGcaSchema(ctx.storage.sql);
    seed(ctx.storage.sql);
  });
}

/** An in-memory KV namespace holding JSON values. */
export function fakeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    get: vi.fn(async (key: string) => {
      const raw = store.get(key);
      return raw ? JSON.parse(raw) : null;
    }),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  };
}

/** Synthetic IVAO credentials backed by a fake KV token cache. */
export function ivaoAuth(kv: ReturnType<typeof fakeKv>) {
  return { clientId: 'id', clientSecret: 'secret', kv: kv as unknown as KVNamespace };
}
