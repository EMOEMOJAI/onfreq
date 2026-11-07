/**
 * Shared-secret authentication for the bearer-gated HTTP routes: POLL_SECRET
 * protects /poll and /health; HISTORY_SECRET protects /gca-history,
 * /gca-history/cleanup and the operator's /gca-history/records routes. The
 * signed GCA records routes are verified in src/gca-records-http.ts.
 *
 * /poll exists as a fallback for when Cloudflare's cron scheduler stops
 * firing (as it did on 2026-08-17): any external scheduler can drive the poll
 * over HTTP instead.
 */

/** Shorter bearer secrets are too guessable for these unthrottled endpoints. */
export const MIN_SECRET_LENGTH = 32;

/**
 * The GCA records signing keys (primary, then the optional next key during a
 * rotation). A bearer secret equal to either disables its routes, and either
 * equal to a bearer or other secret disables the signed routes.
 */
export const GCA_KEY_NAMES = ['GCA_ADMIN_HMAC_KEY', 'GCA_ADMIN_HMAC_KEY_NEXT'] as const;

/** The name of the GCA key `secret` equals (trimmed, non-empty), if any. */
export function reusedGcaKey(env: Pick<Env, (typeof GCA_KEY_NAMES)[number]>, secret: string): string | undefined {
  if (!secret) return undefined;
  return GCA_KEY_NAMES.find((name) => env[name]?.trim() === secret);
}

/**
 * Reasons already logged in this isolate. Invalid configuration is checked on
 * every request, so unauthenticated traffic must not be able to multiply the
 * `config_invalid` log lines; one line per reason per isolate is enough.
 */
const loggedConfigInvalid = new Set<string>();

/** Log a `config_invalid` reason at most once per isolate. Never pass values. */
export function logConfigInvalidOnce(reason: string): void {
  if (loggedConfigInvalid.has(reason)) return;
  loggedConfigInvalid.add(reason);
  console.error(JSON.stringify({ event: 'config_invalid', reason }));
}

/** Test-only: forget which `config_invalid` reasons were logged. */
export function resetConfigInvalidLogForTests(): void {
  loggedConfigInvalid.clear();
}

/**
 * Return the configured secret, or '' when it is unset or too short.
 *
 * A too-short secret disables its endpoints (fail closed) and logs the
 * variable name only, never the value, once per isolate.
 */
export function configuredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim() ?? '';
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    logConfigInvalidOnce(`${name}_too_short`);
    return '';
  }
  return secret;
}

/** Pull the token out of an `Authorization: Bearer <token>` header. */
export function extractBearer(header: string | null): string {
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first so the comparison always runs over 32 bytes —
 * that way the loop's duration reveals nothing about the secret's length
 * either.
 */
export async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}
