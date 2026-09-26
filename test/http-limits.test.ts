import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_RESPONSE_BYTES, fetchBuffered } from '../src/http';

afterEach(() => vi.unstubAllGlobals());

const URL = 'https://upstream.test/private-path?secret=1';

/** A body delivered in chunks with no content-length header. */
function chunked(chunkBytes: number, chunks: number, onCancel = () => {}): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ >= chunks) return controller.close();
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel: onCancel,
  });
}

describe('response size cap', () => {
  it('rejects a declared content-length over the cap without echoing the URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {
      headers: { 'content-length': String(DEFAULT_MAX_RESPONSE_BYTES + 1) },
    })));
    const err = await fetchBuffered(URL).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('upstream response exceeded size limit');
    expect(err?.message).not.toContain('upstream.test');
  });

  it('stops reading an undeclared streamed body once it passes the cap', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(chunked(64 * 1024, 1000, cancel))));
    await expect(fetchBuffered(URL)).rejects.toThrow('upstream response exceeded size limit');
    expect(cancel).toHaveBeenCalled();
  });

  it('accepts a body of exactly the default cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(chunked(64 * 1024, DEFAULT_MAX_RESPONSE_BYTES / (64 * 1024)))));
    const res = await fetchBuffered(URL);
    expect((await res.arrayBuffer()).byteLength).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it('honours a per-call override in both directions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(chunked(64 * 1024, 32))));
    await expect(fetchBuffered(URL, undefined, { maxBytes: 3 * 1024 * 1024 })).resolves.toMatchObject({ status: 200 });
    await expect(fetchBuffered(URL, undefined, { maxBytes: 1024 })).rejects.toThrow('exceeded size limit');
  });
});

describe('redirects', () => {
  it('never follows redirects, even when the caller asks to', async () => {
    const network = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', network);
    await fetchBuffered(URL, { method: 'POST', body: '{}', redirect: 'follow' });
    expect((network.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it.each([301, 302, 303, 307, 308])('treats a %i as a failure without echoing the target', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status, headers: { location: 'https://attacker.test/collect' },
    })));
    const err = await fetchBuffered(URL, { method: 'POST', body: '{"client_secret":"synthetic"}' })
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('upstream request was redirected');
    expect(err?.message).not.toMatch(/attacker|upstream\.test/);
  });
});
