import { extractBearer, secretsMatch } from './auth';
import { getCoordinator } from './config';

export { PollCoordinator } from './coordinator';

/**
 * Manual poll trigger, for when Cloudflare's cron scheduler is not firing.
 *
 * Runs exactly the same logic as the scheduled handler, so an external
 * scheduler can stand in for the cron without any behavioural difference.
 * Requires `Authorization: Bearer <POLL_SECRET>`; disabled entirely when
 * that secret is unset, so it can never be triggered anonymously.
 */
async function handlePollRequest(request: Request, env: Env): Promise<Response> {
  const expected = env.POLL_SECRET?.trim();
  if (!expected) {
    return Response.json(
      { ok: false, error: 'poll endpoint disabled: POLL_SECRET is not set' },
      { status: 503 },
    );
  }

  const provided = extractBearer(request.headers.get('authorization'));
  if (!(await secretsMatch(provided, expected))) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const result = await getCoordinator(env).poll();
    return Response.json({ ok: true, source: 'http', ...result, durationMs: Date.now() - startedAt });
  } catch (err) {
    console.error(JSON.stringify({ event: 'poll_failed', source: 'http', error: String(err) }));
    return Response.json(
      { ok: false, source: 'http', error: String(err), durationMs: Date.now() - startedAt },
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
      const expected = env.POLL_SECRET?.trim();
      if (!expected) return Response.json({ error: 'endpoint disabled' }, { status: 503, headers });
      if (!await secretsMatch(extractBearer(request.headers.get('authorization')), expected)) {
        return Response.json({ error: 'unauthorized' }, { status: 401, headers });
      }
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
      const expected = env.POLL_SECRET?.trim();
      if (!expected) return Response.json({ error: 'history endpoint disabled' }, { status: 503, headers });
      if (!await secretsMatch(extractBearer(request.headers.get('authorization')), expected)) {
        return Response.json({ error: 'unauthorized' }, { status: 401, headers });
      }
      const after = url.searchParams.get('after') ?? '';
      if (after && !/^\d{1,16}:\d{1,16}$/.test(after)) {
        return Response.json({ error: 'invalid cursor' }, { status: 400, headers });
      }
      const history = await getCoordinator(env).getGcaHistory(after);
      return Response.json({ ...history, note: 'lastSeenAt is the last observed connection time, not the delivery time. Failed/reserved attempts may have delivered; counts are detections, not confirmed offences.' }, { headers });
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
