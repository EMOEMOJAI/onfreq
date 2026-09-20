import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBuffered, REQUEST_TIMEOUT_MS } from '../src/http';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bounded upstream requests', () => {
  it('aborts a stalled connection', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    const result = expect(fetchBuffered('https://upstream.test')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also aborts a stalled body after headers have arrived', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
      },
    }))));
    const result = expect(fetchBuffered('https://upstream.test')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout on success and preserves status, headers, and payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ retry_after: 2 }, {
      status: 429, headers: { 'retry-after': '2' },
    })));
    const result = await fetchBuffered('https://upstream.test');
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe('2');
    expect(await result.json()).toEqual({ retry_after: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
