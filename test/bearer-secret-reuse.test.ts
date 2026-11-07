import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { resetConfigInvalidLogForTests } from '../src/auth';
import { callRoute, HISTORY_ONLY, POLL_ONLY } from './helpers';

// T1-5 D: a bearer secret equal to IVAO_CLIENT_SECRET or DISCORD_BOT_TOKEN disables its routes.
// Synthetic values of 32+ characters, so only the reuse check (never the length check) can disable a route.
const REUSED = 'synthetic-reused-bearer-and-api-credential-0123456789';
/** Distinct API credentials: the reuse check under test must be the only one that can match. */
const DISTINCT_OTHERS: Partial<Env> = {
  IVAO_CLIENT_SECRET: 'synthetic-distinct-ivao-client-secret-0123456789',
  DISCORD_BOT_TOKEN: 'synthetic-distinct-discord-bot-token-0123456789',
};

const ROUTES = {
  // /health first: before the fix it fails there, so a wrongly enabled /poll is never run.
  POLL_SECRET: [['/health', 'GET'], ['/poll', 'POST']],
  HISTORY_SECRET: [['/gca-history', 'GET'], ['/gca-history/cleanup', 'GET'], ['/gca-history/cleanup', 'POST'],
    ['/gca-history/records', 'GET'], ['/gca-history/records/delete', 'POST']],
} as const;

/** Confirmation headers, so a route that is wrongly enabled would reach its handler rather than stop at a 400. */
const CONFIRM = { 'x-onfreq-confirm': 'delete-old-copies' };

let log: MockInstance<typeof console.error>;
const lines = () => log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);

beforeEach(() => {
  // The once-per-isolate log is reset for every parameterized case.
  resetConfigInvalidLogForTests();
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

/** The secret under test holds REUSED; the other bearer secret stays distinct. */
function bearers(name: keyof typeof ROUTES): Partial<Env> {
  return name === 'POLL_SECRET' ? { POLL_SECRET: REUSED, HISTORY_SECRET: HISTORY_ONLY } : { POLL_SECRET: POLL_ONLY, HISTORY_SECRET: REUSED };
}

/** The other secret's routes still answer with their own token: health reports, history records lists. */
async function expectOtherRoutesFine(name: keyof typeof ROUTES, overrides: Partial<Env>) {
  if (name === 'POLL_SECRET') {
    const response = await callRoute('/gca-history/records', 'GET', HISTORY_ONLY, overrides);
    expect(response.status).toBe(200);
  } else {
    const response = await callRoute('/health', 'GET', POLL_ONLY, overrides);
    expect(await response.json()).toMatchObject({ ok: false, maxAgeSeconds: 300 });
  }
}

describe.each(['POLL_SECRET', 'HISTORY_SECRET'] as const)('T1-5 D: %s', (name) => {
  it.each(['IVAO_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'] as const)('equal to %s (trimmed) disables its routes with 503', async (other) => {
    const overrides: Partial<Env> = { ...bearers(name), ...DISTINCT_OTHERS, [other]: ` ${REUSED}\n` };
    for (const [path, method] of ROUTES[name]) {
      for (let i = 0; i < 2; i++) {
        const response = await callRoute(path, method, REUSED, overrides, CONFIRM);
        expect(response.status, `${method} ${path}`).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ error: 'endpoint disabled' });
      }
    }
    // Exactly one config_invalid line, naming settings only.
    expect(lines()).toEqual([{ event: 'config_invalid', reason: `${name}_reuses_${other}` }]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(REUSED);
    await expectOtherRoutesFine(name, overrides);
    expect(JSON.stringify(log.mock.calls)).not.toContain(REUSED);
  });

  it('distinct IVAO_CLIENT_SECRET and DISCORD_BOT_TOKEN values leave its routes enabled', async () => {
    const overrides: Partial<Env> = { ...bearers(name), ...DISTINCT_OTHERS };
    if (name === 'POLL_SECRET') {
      expect(await (await callRoute('/health', 'GET', REUSED, overrides)).json()).toMatchObject({ ok: false, maxAgeSeconds: 300 });
    } else {
      expect((await callRoute('/gca-history/records', 'GET', REUSED, overrides)).status).toBe(200);
      expect((await callRoute('/gca-history', 'GET', REUSED, overrides)).status).toBe(200);
    }
    expect(lines()).not.toContainEqual(expect.objectContaining({ event: 'config_invalid' }));
    await expectOtherRoutesFine(name, overrides);
  });
});
