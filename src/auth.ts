/**
 * Shared-secret authentication for the manual poll endpoint.
 *
 * The endpoint exists as a fallback for when Cloudflare's cron scheduler
 * stops firing (as it did on 2026-08-17): any external scheduler can drive
 * the poll over HTTP instead.
 */

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
