import { configuredSecret, extractBearer, logConfigInvalidOnce, secretsMatch } from './auth';
import { getCoordinator } from './config';

export { PollCoordinator } from './coordinator';

/**
 * A bearer-gated route. POLL_SECRET protects /poll and /health; HISTORY_SECRET
 * alone protects the private /gca-history routes.
 */
interface Route {
  methods: readonly string[];
  secret: 'POLL_SECRET' | 'HISTORY_SECRET';
  handle(request: Request, url: URL, env: Env): Promise<Response>;
}

/** Error bodies are `{ error }` with a fixed message: never stored errors, identifiers or variable names. */
const errorResponse = (error: string, status: number, headers?: Record<string, string>) =>
  Response.json({ error }, { status, headers });

/**
 * Returns a disabled/unauthorized Response to short-circuit the caller, or
 * `null` when the request is authenticated and handling should continue.
 * Unset or too-short secrets disable the endpoint. A HISTORY_SECRET equal to
 * POLL_SECRET also disables the history routes, since the poll token is held
 * by monitors and the Mac helper.
 */
async function requireSecret(request: Request, env: Env, name: Route['secret']): Promise<Response | null> {
  let expected = configuredSecret(env[name], name);
  if (expected && name === 'HISTORY_SECRET' && expected === env.POLL_SECRET?.trim()) {
    // Reusing the poll token would silently undo the privilege split: fail closed.
    logConfigInvalidOnce('HISTORY_SECRET_reuses_POLL_SECRET');
    expected = '';
  }
  if (!expected) return errorResponse('endpoint disabled', 503);
  const provided = extractBearer(request.headers.get('authorization'));
  if (!(await secretsMatch(provided, expected))) return errorResponse('unauthorized', 401);
  return null;
}

/**
 * The one place for per-route HTTP policy: method check, then bearer auth,
 * then the handler, with a generic 503 if the handler throws. Every response,
 * including errors, is marked no-store.
 */
async function serve(route: Route, request: Request, url: URL, env: Env): Promise<Response> {
  let response: Response;
  if (!route.methods.includes(request.method)) {
    response = errorResponse('method not allowed', 405, { allow: route.methods.join(', ') });
  } else {
    const denied = await requireSecret(request, env, route.secret);
    if (denied) {
      response = denied;
    } else {
      try {
        response = await route.handle(request, url, env);
      } catch {
        // Responses must never expose stored errors or identifiers.
        response = errorResponse('coordinator unavailable', 503);
      }
    }
  }
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Manual poll trigger, for when Cloudflare's cron scheduler is not firing.
 *
 * Runs exactly the same logic as the scheduled handler, so an external
 * scheduler can stand in for the cron without any behavioural difference.
 * Keeps its own 500 result body, which mirrors the `ok: true` success body.
 */
async function handlePoll(_request: Request, _url: URL, env: Env): Promise<Response> {
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

/** Reads the stored success time only: never polls or refreshes it. */
async function handleHealth(_request: Request, _url: URL, env: Env): Promise<Response> {
  const health = await getCoordinator(env).getHealth();
  return Response.json(health, { status: health.ok ? 200 : 503 });
}

async function handleHistory(_request: Request, url: URL, env: Env): Promise<Response> {
  // Opaque numeric cursor only: member ids must never appear in request URLs.
  const after = url.searchParams.get('after') ?? '';
  if (after && !/^\d{1,12}$/.test(after)) return errorResponse('invalid cursor', 400);
  const history = await getCoordinator(env).getGcaHistory(after ? Number(after) : 0);
  return Response.json({ ...history, note: 'lastSeenAt is the last observed connection time, not the delivery time. Failed/reserved attempts may have delivered; counts are detections, not confirmed offences.' });
}

/** GET previews; POST deletes only with explicit confirmation. 409 while a poll is in flight. */
async function handleCleanup(request: Request, _url: URL, env: Env): Promise<Response> {
  const apply = request.method === 'POST';
  if (apply && request.headers.get('x-onfreq-confirm') !== 'delete-old-copies') {
    return errorResponse('preview with GET, then confirm with X-Onfreq-Confirm: delete-old-copies', 400);
  }
  const result = await getCoordinator(env).cleanupGcaHistory(apply);
  return Response.json(result, { status: result.busy ? 409 : 200 });
}

const ROUTES = new Map<string, Route>([
  ['/poll', { methods: ['POST'], secret: 'POLL_SECRET', handle: handlePoll }],
  ['/health', { methods: ['GET'], secret: 'POLL_SECRET', handle: handleHealth }],
  ['/gca-history', { methods: ['GET'], secret: 'HISTORY_SECRET', handle: handleHistory }],
  ['/gca-history/cleanup', { methods: ['GET', 'POST'], secret: 'HISTORY_SECRET', handle: handleCleanup }],
]);

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);

    const route = ROUTES.get(url.pathname);
    if (route) return serve(route, request, url, env);

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
