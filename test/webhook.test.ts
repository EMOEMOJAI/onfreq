import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import worker from '../src/index';
import { resetConfigInvalidLogForTests } from '../src/auth';
import {
  parseHook0Signature, resetWebhookDebounceForTests, resetWebhookLogForTests, verifyHook0Signature,
} from '../src/webhook';
import { POLL_ONLY, HISTORY_ONLY } from './helpers';

// Matches the synthetic IVAO_WEBHOOK_SECRET binding in vitest.config.ts.
const SECRET = 'synthetic-ivao-webhook-signing-secret-vitest';
const NOW_S = 1_792_278_069;
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const SIGNED = 'content-type x-event-id x-event-type';
const STARTED = '{"sessionId":1,"callsign":"XA_SYN_CTR","userId":100,"connectionType":"ATC","resume":false}';
/**
 * Fixed vector, computed independently of this code with:
 * printf '%s' '1792278069.content-type x-event-id x-event-type.application/json.00000000-0000-4000-8000-000000000001.tracker.session.started.{"sessionId":1,"callsign":"XA_SYN_CTR","userId":100,"connectionType":"ATC","resume":false}' \
 *   | openssl dgst -sha256 -hmac 'synthetic-ivao-webhook-signing-secret-vitest'
 */
const FIXED_V1 = '6fae3d7c2af8f5a5aab8bc77621cb3fd222bc91a38dfcbcb1d0c6ee847a3cafc';
const WEBHOOK_URL = 'https://example.test/ivao/webhook';

let requestEarlyPoll: ReturnType<typeof vi.fn<() => Promise<void>>>;
let getByName: ReturnType<typeof vi.fn>;
let log: MockInstance<typeof console.error>;

beforeEach(() => {
  resetConfigInvalidLogForTests();
  resetWebhookLogForTests();
  resetWebhookDebounceForTests();
  vi.spyOn(Date, 'now').mockReturnValue(NOW_S * 1000);
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  requestEarlyPoll = vi.fn(async () => {});
  getByName = vi.fn(() => ({ requestEarlyPoll }));
});
afterEach(() => { vi.restoreAllMocks(); });

const encoder = new TextEncoder();

async function hmacHex(secret: string, content: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, content))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Signing {
  body?: string;
  eventType?: string;
  t?: number | string;
  h?: string;
  secret?: string;
  /** Builds the signature header from the correct v1 value. */
  header?: (v1: string, t: string, h: string) => string;
  /** Headers sent with the request; values for missing listed names sign as ''. */
  extraHeaders?: Record<string, string>;
  omit?: string[];
  /** Body actually sent, when it differs from the signed one. */
  sentBody?: BodyInit;
}

async function signed(options: Signing = {}): Promise<Request> {
  const { body = STARTED, eventType = 'tracker.session.started', t = NOW_S, h = SIGNED, secret = SECRET } = options;
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'x-event-id': EVENT_ID, 'x-event-type': eventType, ...options.extraHeaders,
  };
  for (const name of options.omit ?? []) delete headers[name];
  const values = h.split(' ').map((name) => headers[name] ?? '').join('.');
  const v1 = await hmacHex(secret, encoder.encode(`${t}.${h}.${values}.${body}`));
  headers['x-hook0-signature'] = options.header ? options.header(v1, String(t), h) : `t=${t},h=${h},v1=${v1}`;
  return new Request(WEBHOOK_URL, { method: 'POST', headers, body: options.sentBody ?? body });
}

function send(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], {
    ...env, POLL_COORDINATOR: { getByName } as unknown as Env['POLL_COORDINATOR'], ...overrides,
  }, createExecutionContext());
}

async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error });
  // Rejected requests never reach a Durable Object.
  expect(getByName).not.toHaveBeenCalled();
  expect(requestEarlyPoll).not.toHaveBeenCalled();
}

async function expectAccepted(response: Response, earlyPolls: number) {
  expect(response.status).toBe(204);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).toBe('');
  expect(requestEarlyPoll).toHaveBeenCalledTimes(earlyPolls);
  expect(getByName).toHaveBeenCalledTimes(earlyPolls);
}

const rejectionLines = () => log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);

describe('Hook0 signature', () => {
  it('reproduces the independently computed fixed vector', async () => {
    const headers = new Headers({
      'content-type': 'application/json', 'x-event-id': EVENT_ID, 'x-event-type': 'tracker.session.started',
      'x-hook0-signature': `t=${NOW_S},h=${SIGNED},v1=${FIXED_V1}`,
    });
    const parsed = parseHook0Signature(headers, NOW_S);
    expect(typeof parsed).toBe('object');
    const request = parsed as Exclude<typeof parsed, string>;
    expect(request.prefix).toBe(`${NOW_S}.${SIGNED}.application/json.${EVENT_ID}.tracker.session.started.`);
    expect(await verifyHook0Signature(SECRET, request, encoder.encode(STARTED))).toBe(true);
    expect(await verifyHook0Signature(`${SECRET}x`, request, encoder.encode(STARTED))).toBe(false);
    expect(await hmacHex(SECRET, encoder.encode(`${request.prefix}${STARTED}`))).toBe(FIXED_V1);
    await expectAccepted(await send(new Request(WEBHOOK_URL, { method: 'POST', headers, body: STARTED })), 1);
  });

  it('accepts a valid signature and asks the configured coordinator for one early poll', async () => {
    await expectAccepted(await send(await signed(), { COORDINATOR_NAME: ' preserved-state ' }), 1);
    expect(getByName).toHaveBeenCalledExactlyOnceWith('preserved-state');
    expect(log).not.toHaveBeenCalled();
  });

  it.each([300, -300])('accepts a timestamp %i seconds away', async (offset) => {
    await expectAccepted(await send(await signed({ t: NOW_S + offset })), 1);
  });

  it.each([301, -301])('rejects a timestamp %i seconds away', async (offset) => {
    await expectError(await send(await signed({ t: NOW_S + offset })), 401, 'unauthorized');
    expect(rejectionLines()).toEqual([{ event: 'webhook_rejected', reason: 'signature_expired' }]);
  });

  it.each([
    ['a non-numeric t', { t: 'abc' }],
    ['an empty t', { t: '' }],
    ['an exponent t', { t: '1e9' }],
    ['a negative t', { t: '-1' }],
    ['a 13-digit t', { t: '1792278069000' }],
    ['a duplicate t', { header: (v1: string, t: string, h: string) => `t=${t},t=${t},h=${h},v1=${v1}` }],
    ['a duplicate h', { header: (v1: string, t: string, h: string) => `t=${t},h=${h},h=${h},v1=${v1}` }],
    ['no t', { header: (v1: string, _t: string, h: string) => `h=${h},v1=${v1}` }],
    ['no h', { header: (v1: string, t: string) => `t=${t},v1=${v1}` }],
    ['no v1', { header: (_v1: string, t: string, h: string) => `t=${t},h=${h}` }],
    ['three v1 values', { header: (v1: string, t: string, h: string) => `t=${t},h=${h},v1=${v1},v1=${v1},v1=${v1}` }],
    ['a short v1', { header: (v1: string, t: string, h: string) => `t=${t},h=${h},v1=${v1.slice(1)}` }],
    ['a long v1', { header: (v1: string, t: string, h: string) => `t=${t},h=${h},v1=${v1}0` }],
    ['an uppercase v1', { header: (v1: string, t: string, h: string) => `t=${t},h=${h},v1=${v1.toUpperCase()}` }],
    ['a part without "="', { header: (v1: string, t: string, h: string) => `t=${t},h=${h},v1=${v1},junk` }],
    ['an empty part', { header: (v1: string, t: string, h: string) => `t=${t},,h=${h},v1=${v1}` }],
    ['spaces around parts', { header: (v1: string, t: string, h: string) => `t=${t}, h=${h}, v1=${v1}` }],
  ])('rejects %s', async (_label, options) => {
    await expectError(await send(await signed(options as Signing)), 401, 'unauthorized');
    expect(rejectionLines()).toEqual([{ event: 'webhook_rejected', reason: 'signature_header_invalid' }]);
  });

  it('rejects a missing signature header', async () => {
    const headers = new Headers((await signed()).headers);
    headers.delete('x-hook0-signature');
    await expectError(await send(new Request(WEBHOOK_URL, { method: 'POST', headers, body: STARTED })), 401, 'unauthorized');
  });

  it('passes when the second v1 verifies and the first does not', async () => {
    await expectAccepted(await send(await signed({
      header: (v1, t, h) => `t=${t},h=${h},v1=${'0'.repeat(64)},v1=${v1}`,
    })), 1);
  });

  it('rejects two v1 values when neither verifies', async () => {
    await expectError(await send(await signed({
      header: (_v1, t, h) => `t=${t},h=${h},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`,
    })), 401, 'unauthorized');
    expect(rejectionLines()).toEqual([{ event: 'webhook_rejected', reason: 'signature_mismatch' }]);
  });

  it('ignores unknown keys such as v0', async () => {
    await expectAccepted(await send(await signed({
      header: (v1, t, h) => `v0=legacy,t=${t},h=${h},v1=${v1},x=y=z`,
    })), 1);
  });

  it('accepts additional signed headers that are present', async () => {
    await expectAccepted(await send(await signed({
      h: 'x-event-type content-type x-event-id x-extra', extraHeaders: { 'x-extra': 'synthetic' },
    })), 1);
  });

  it.each([
    ['without x-event-type', 'content-type x-event-id'],
    ['without x-event-id', 'content-type x-event-type'],
    ['with an uppercase name', 'Content-Type x-event-id x-event-type'],
    ['with a duplicate name', 'content-type x-event-id x-event-type x-event-id'],
    ['with a double space', 'content-type  x-event-id x-event-type'],
    ['with an invalid character', 'content_type x-event-id x-event-type'],
  ])('rejects h %s', async (_label, h) => {
    await expectError(await send(await signed({ h })), 401, 'unauthorized');
    expect(rejectionLines()).toEqual([{ event: 'webhook_rejected', reason: 'signed_headers_invalid' }]);
  });

  it('rejects a listed header that is absent instead of signing it as empty', async () => {
    // The signature covers '' for the absent header, as a lenient verifier would compute.
    await expectError(await send(await signed({ h: `${SIGNED} x-missing` })), 401, 'unauthorized');
    expect(rejectionLines()).toEqual([{ event: 'webhook_rejected', reason: 'signed_header_missing' }]);
  });

  it('rejects a body changed by one byte', async () => {
    const tampered = STARTED.replace('"userId":100', '"userId":101');
    expect(tampered).toHaveLength(STARTED.length);
    await expectError(await send(await signed({ sentBody: tampered })), 401, 'unauthorized');
  });

  it('rejects a signature made with another secret', async () => {
    await expectError(await send(await signed({ secret: POLL_ONLY })), 401, 'unauthorized');
  });

  it('logs each rejection reason once and never logs request content', async () => {
    for (let i = 0; i < 5; i++) {
      await send(await signed({ sentBody: STARTED.replace('XA_SYN_CTR', 'XA_SYN_TWR') }));
      await send(await signed({ t: NOW_S - 400 }));
    }
    expect(rejectionLines()).toEqual([
      { event: 'webhook_rejected', reason: 'signature_mismatch' },
      { event: 'webhook_rejected', reason: 'signature_expired' },
    ]);
    const logged = JSON.stringify(log.mock.calls);
    for (const detail of ['XA_SYN', '100', EVENT_ID, SECRET]) expect(logged).not.toContain(detail);
  });
});

describe('body limit', () => {
  const padded = (bytes: number) => {
    const base = '{"connectionType":"ATC","callsign":"XA_SYN_CTR","pad":""}';
    return base.replace('"pad":""', `"pad":"${'x'.repeat(bytes - base.length)}"`);
  };

  it('accepts a signed body of exactly 8 KiB', async () => {
    const body = padded(8 * 1024);
    expect(encoder.encode(body).byteLength).toBe(8192);
    await expectAccepted(await send(await signed({ body })), 1);
  });

  it('rejects a 9 KiB body declared by content-length with 413 before reading it', async () => {
    const body = padded(9 * 1024);
    const request = await signed({ body, extraHeaders: { 'content-length': String(9 * 1024) } });
    expect(request.headers.get('content-length')).toBe('9216');
    await expectError(await send(request), 413, 'payload too large');
    expect(request.bodyUsed).toBe(false);
    expect(rejectionLines()).toEqual([{ event: 'webhook_rejected', reason: 'payload_too_large' }]);
  });

  it('rejects a 9 KiB streamed body without content-length with 413', async () => {
    const body = padded(9 * 1024);
    const bytes = encoder.encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += 1024) controller.enqueue(bytes.slice(offset, offset + 1024));
        controller.close();
      },
    });
    const request = await signed({ body, sentBody: stream });
    expect(request.headers.get('content-length')).toBeNull();
    await expectError(await send(request), 413, 'payload too large');
  });

  it('accepts a small streamed body without content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(STARTED)); controller.close(); },
    });
    const request = await signed({ sentBody: stream });
    expect(request.headers.get('content-length')).toBeNull();
    await expectAccepted(await send(request), 1);
  });
});

describe('configuration and method', () => {
  it.each([
    ['unset', { IVAO_WEBHOOK_SECRET: undefined }, []],
    ['empty', { IVAO_WEBHOOK_SECRET: '  ' }, []],
    ['short', { IVAO_WEBHOOK_SECRET: 'w'.repeat(31) }, ['IVAO_WEBHOOK_SECRET_too_short']],
    ['equal to POLL_SECRET', { IVAO_WEBHOOK_SECRET: ` ${POLL_ONLY} `, POLL_SECRET: POLL_ONLY },
      ['IVAO_WEBHOOK_SECRET_reuses_POLL_SECRET']],
    ['equal to HISTORY_SECRET', { IVAO_WEBHOOK_SECRET: HISTORY_ONLY, HISTORY_SECRET: ` ${HISTORY_ONLY} ` },
      ['IVAO_WEBHOOK_SECRET_reuses_HISTORY_SECRET']],
    ['equal to IVAO_CLIENT_SECRET', { IVAO_WEBHOOK_SECRET: SECRET, IVAO_CLIENT_SECRET: ` ${SECRET} ` },
      ['IVAO_WEBHOOK_SECRET_reuses_IVAO_CLIENT_SECRET']],
    ['equal to DISCORD_BOT_TOKEN', { IVAO_WEBHOOK_SECRET: ` ${SECRET}`, DISCORD_BOT_TOKEN: `${SECRET} ` },
      ['IVAO_WEBHOOK_SECRET_reuses_DISCORD_BOT_TOKEN']],
  ])('is disabled when the secret is %s, even for a matching signature', async (_label, overrides, reasons) => {
    const secret = overrides.IVAO_WEBHOOK_SECRET?.trim() || SECRET;
    for (let i = 0; i < 3; i++) {
      await expectError(await send(await signed({ secret }), overrides as Partial<Env>), 503, 'endpoint disabled');
    }
    expect(rejectionLines()).toEqual(reasons.map((reason) => ({ event: 'config_invalid', reason })));
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it.each(['GET', 'PUT', 'DELETE'])('rejects %s with 405 before checking anything', async (method) => {
    const response = await send(new Request(WEBHOOK_URL, { method }), { IVAO_WEBHOOK_SECRET: '' });
    expect(response.headers.get('allow')).toBe('POST');
    await expectError(response, 405, 'method not allowed');
  });

  it('returns a generic 503 when the coordinator fails, logging only the error type', async () => {
    requestEarlyPoll.mockRejectedValueOnce(new Error('synthetic private coordinator detail'));
    const response = await send(await signed());
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'coordinator unavailable' });
    expect(rejectionLines()).toEqual([{ event: 'route_failed', route: '/ivao/webhook', error: 'Error' }]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic private');
  });

  it('returns a generic 503 when the handler itself throws', async () => {
    getByName.mockImplementationOnce(() => { throw new TypeError('synthetic private binding detail'); });
    const response = await send(await signed());
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'coordinator unavailable' });
    expect(rejectionLines()).toEqual([{ event: 'route_failed', route: '/ivao/webhook', error: 'TypeError' }]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic private');
  });
});

describe('debounce', () => {
  const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(NOW_S * 1000 + ms);

  it('skips the coordinator for 15 s after a successful call, still acknowledging with 204', async () => {
    await expectAccepted(await send(await signed()), 1);
    at(14_999);
    await expectAccepted(await send(await signed()), 1);
    at(15_000);
    await expectAccepted(await send(await signed()), 2);
  });

  it('does not debounce after a failed coordinator call', async () => {
    requestEarlyPoll.mockRejectedValueOnce(new Error('synthetic failure'));
    expect((await send(await signed())).status).toBe(503);
    at(1_000);
    await expectAccepted(await send(await signed()), 2);
  });

  it('does not debounce events that need no early poll', async () => {
    await expectAccepted(await send(await signed({ eventType: 'tracker.session.ended' })), 0);
    await expectAccepted(await send(await signed()), 1);
  });

  it('is cleared by the test-only reset hook', async () => {
    await expectAccepted(await send(await signed()), 1);
    resetWebhookDebounceForTests();
    await expectAccepted(await send(await signed()), 2);
  });
});

describe('verified events', () => {
  const event = (fields: Record<string, unknown>) => JSON.stringify({
    sessionId: 1, callsign: 'XA_SYN_CTR', userId: 100, connectionType: 'ATC', resume: false, ...fields,
  });

  it.each([
    ['a pilot connection', { body: event({ connectionType: 'PILOT' }) }, {}],
    ['a session end', { eventType: 'tracker.session.ended' }, {}],
    ['a frequency transfer', { eventType: 'tracker.frequency_message.atc_transferred' }, {}],
    ['an unmonitored prefix', { body: event({ callsign: 'ZZZZ_CTR' }) }, {}],
    ['a listed excluded callsign', {}, { EXCLUDED_CALLSIGNS: 'QC_OTHER, xa_syn_ctr' }],
    ['a special position', { body: event({ callsign: 'XAAA_X_APP' }) }, {}],
    ['an empty callsign', { body: event({ callsign: '' }) }, {}],
    ['a numeric callsign', { body: event({ callsign: 7 }) }, {}],
    ['invalid JSON', { body: '{"connectionType":"ATC",' }, {}],
    ['a JSON array', { body: '[{"connectionType":"ATC","callsign":"XA_SYN_CTR"}]' }, {}],
    ['JSON null', { body: 'null' }, {}],
    ['an empty body', { body: '' }, {}],
    ['invalid UTF-8', { body: '' }, {}],
    ['invalid FIR_PREFIXES', {}, { FIR_PREFIXES: 'not-a-prefix' }],
  ])('acknowledges %s with 204 and no coordinator call', async (label, options, overrides) => {
    let request = await signed(options as Signing);
    if (label === 'invalid UTF-8') {
      const bytes = new Uint8Array([0x7b, 0xff, 0x7d]);
      const v1 = await hmacHex(SECRET, new Uint8Array([
        ...encoder.encode(`${NOW_S}.${SIGNED}.application/json.${EVENT_ID}.tracker.session.started.`), ...bytes]));
      const headers = new Headers(request.headers);
      headers.set('x-hook0-signature', `t=${NOW_S},h=${SIGNED},v1=${v1}`);
      request = new Request(WEBHOOK_URL, { method: 'POST', headers, body: bytes });
    }
    await expectAccepted(await send(request, overrides as Partial<Env>), 0);
    expect(log).not.toHaveBeenCalled();
  });

  it('matches monitored prefixes case-insensitively', async () => {
    await expectAccepted(await send(await signed({ body: event({ callsign: 'qe_syn_app' }) })), 1);
  });

  it('acknowledges a reconnection on a monitored callsign as a start', async () => {
    await expectAccepted(await send(await signed({ body: event({ resume: true }) })), 1);
  });
});
