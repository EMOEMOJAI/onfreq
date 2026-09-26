/** Bound both response headers and body reads so a stalled service cannot
 * hold the shared poll coordinator indefinitely. These APIs return small JSON
 * payloads that their callers already consume in full.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Default cap on a buffered response body; callers with larger payloads override it. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Fixed messages: never echo the URL, headers or body of the rejected response. */
const TOO_LARGE_MESSAGE = 'upstream response exceeded size limit';
const REDIRECT_MESSAGE = 'upstream request was redirected';

/**
 * The upstream answered, but its body exceeded the caller's cap. Distinct from
 * a timeout or network failure: the service is reachable, so callers must not
 * treat this as an outage. `status` is the HTTP status of the discarded response.
 */
export class ResponseTooLargeError extends Error {
  constructor(readonly status: number) {
    super(TOO_LARGE_MESSAGE);
    this.name = 'ResponseTooLargeError';
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(response.status);
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Redirects are never followed: none of these APIs redirect, and following
 * one would resend credentials (client secret, bearer or bot token) to the
 * redirect target.
 */
export async function fetchBuffered(
  url: string,
  init?: RequestInit,
  { maxBytes = DEFAULT_MAX_RESPONSE_BYTES }: { maxBytes?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream request timed out')), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      await response.body?.cancel().catch(() => {});
      throw new Error(REDIRECT_MESSAGE);
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ResponseTooLargeError(response.status);
    }
    const body = await readCapped(response, maxBytes);
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}
