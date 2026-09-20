/** Bound both response headers and body reads so a stalled service cannot
 * hold the shared poll coordinator indefinitely. These APIs return small JSON
 * payloads that their callers already consume in full.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export async function fetchBuffered(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream request timed out')), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}
