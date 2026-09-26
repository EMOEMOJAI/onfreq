import { configuredSecret, extractBearer, secretsMatch } from './auth';
import { getCoordinator } from './config';

export { PollCoordinator } from './coordinator';

/**
 * Shared bearer-secret gate. POLL_SECRET protects /poll and /health;
 * HISTORY_SECRET alone protects the private /gca-history routes.
 *
 * Returns a disabled/unauthorized Response to short-circuit the caller, or
 * `null` when the request is authenticated and handling should continue.
 * Unset or too-short secrets disable the endpoint; bodies never name the
 * variable.
 */
async function requireSecret(
  request: Request,
  env: Env,
  name: 'POLL_SECRET' | 'HISTORY_SECRET',
  disabledBody: Record<string, unknown>,
  unauthorizedBody: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const expected = configuredSecret(env[name], name);
  if (!expected) return Response.json(disabledBody, { status: 503, headers });
  const provided = extractBearer(request.headers.get('authorization'));
  if (!(await secretsMatch(provided, expected))) {
    return Response.json(unauthorizedBody, { status: 401, headers });
  }
  return null;
}

/**
 * Manual poll trigger, for when Cloudflare's cron scheduler is not firing.
 *
 * Runs exactly the same logic as the scheduled handler, so an external
 * scheduler can stand in for the cron without any behavioural difference.
 * Requires `Authorization: Bearer <POLL_SECRET>`; disabled entirely when
 * that secret is unset or too short, so it can never be triggered anonymously.
 */
async function handlePollRequest(request: Request, env: Env): Promise<Response> {
  const denied = await requireSecret(
    request,
    env,
    'POLL_SECRET',
    { ok: false, error: 'poll endpoint disabled' },
    { ok: false, error: 'unauthorized' },
  );
  if (denied) return denied;

  const startedAt = Date.now();
  try {
    const result = await getCoordinator(env).poll();
    return Response.json({ ok: true, source: 'http', ...result, durationMs: Date.now() - startedAt });
  } catch (err) {
    console.error(JSON.stringify({ event: 'poll_failed', source: 'http', error: String(err) }));
    return Response.json(
      { ok: false, source: 'http', error: 'poll failed', durationMs: Date.now() - startedAt },
      { status: 500 },
    );
  }
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/gca-history/cleanup') {
      const headers = { 'cache-control': 'no-store' };
      const cleanup = url.pathname === '/gca-history/cleanup';
      const allowed = cleanup ? ['GET', 'POST'] : ['GET'];
      if (!allowed.includes(request.method)) {
        return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: allowed.join(', ') } });
      }
      const secret = cleanup ? 'HISTORY_SECRET' : 'POLL_SECRET';
      const denied = await requireSecret(request, env, secret, { error: 'endpoint disabled' }, { error: 'unauthorized' }, headers);
      if (denied) return denied;
      if (cleanup && request.method === 'POST' && request.headers.get('x-onfreq-confirm') !== 'delete-old-copies') {
        return Response.json({ error: 'preview with GET, then confirm with X-Onfreq-Confirm: delete-old-copies' }, { status: 400, headers });
      }
      try {
        const coordinator = getCoordinator(env);
        if (cleanup) {
          const result = await coordinator.cleanupGcaHistory(request.method === 'POST');
          return Response.json(result, { status: result.busy ? 409 : 200, headers });
        }
        const health = await coordinator.getHealth();
        return Response.json(health, { status: health.ok ? 200 : 503, headers });
      } catch {
        // Health and maintenance responses must never expose stored errors or identifiers.
        return Response.json({ error: 'coordinator unavailable' }, { status: 503, headers });
      }
    }

    if (url.pathname === '/poll') {
      if (request.method !== 'POST') {
        return new Response('Use POST', { status: 405, headers: { allow: 'POST' } });
      }
      return handlePollRequest(request, env);
    }

    if (url.pathname === '/gca-history') {
      const headers = { 'cache-control': 'no-store' };
      if (request.method !== 'GET') return new Response('Use GET', { status: 405, headers: { ...headers, allow: 'GET' } });
      const denied = await requireSecret(request, env, 'HISTORY_SECRET', { error: 'history endpoint disabled' }, { error: 'unauthorized' }, headers);
      if (denied) return denied;
      const after = url.searchParams.get('after') ?? '';
      if (after && !/^\d{1,16}:\d{1,16}$/.test(after)) {
        return Response.json({ error: 'invalid cursor' }, { status: 400, headers });
      }
      try {
        const history = await getCoordinator(env).getGcaHistory(after);
        return Response.json({ ...history, note: 'lastSeenAt is the last observed connection time, not the delivery time. Failed/reserved attempts may have delivered; counts are detections, not confirmed offences.' }, { headers });
      } catch {
        // History responses must never expose stored errors or identifiers.
        return Response.json({ error: 'coordinator unavailable' }, { status: 503, headers });
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('onfreq HTTP endpoint is reachable. Poll freshness requires authenticated GET /health.\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env, _ctx): Promise<void> {
    try {
      await getCoordinator(env).poll();
    } catch (err) {
      console.error(JSON.stringify({ event: 'poll_failed', error: String(err) }));
      // Re-throw so the invocation is recorded as failed in observability.
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
