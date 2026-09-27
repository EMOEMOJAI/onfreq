import { fetchBuffered, ResponseTooLargeError } from './http';

const KEY = 'discord-rate-limits-v1'; // gitleaks:allow — storage key name, not a credential
const GLOBAL = '*';
/** No Discord cooldown, however reported, may block delivery longer than this. */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
/**
 * Discord responses (member-list pages of up to 1000 members, 100-message
 * channel scans that include other users' messages) can approach the default
 * 1 MiB buffer cap, so they get a larger bounded one.
 */
const DISCORD_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Cooldown for a 429 whose body exceeded the cap, so its retry_after was never read. */
const UNREADABLE_RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * `rate_limit`: a real Discord 429. `soft`: an in-memory cooldown inferred
 * from a 2xx response's rate-limit headers. `outage`: this route/instance
 * recently exhausted its 5xx retry budget and is failing fast instead.
 */
export type DiscordRateLimitReason = 'rate_limit' | 'soft' | 'outage';

function messageFor(reason: DiscordRateLimitReason): string {
  switch (reason) {
    case 'outage': return 'Discord request deferred (outage cooldown)';
    case 'soft': return 'Discord request deferred (soft cooldown from response headers)';
    default: return 'Discord API 429: delivery deferred until cooldown expires';
  }
}

export class DiscordRateLimitError extends Error {
  /** Kept for compatibility with callers that only branch on status; use `reason` for diagnostics. */
  readonly status = 429;
  constructor(
    readonly retryAt: number,
    readonly requestMade: boolean,
    readonly global = false,
    readonly reason: DiscordRateLimitReason = 'rate_limit',
  ) {
    super(messageFor(reason));
    this.name = 'DiscordRateLimitError';
  }
  get retryMs(): number { return Math.max(0, this.retryAt - Date.now()); }
}

/** Conservatively share message-route cooldowns within a channel, never across channels. */
function routeKey(path: string): string {
  const channel = /^\/channels\/([^/]+)\/messages(?:\/|$)/.exec(path);
  return channel ? `/channels/${channel[1]}/messages` : path.split('?')[0]!;
}

/** One instance per serialized poll, shared by public cards and private reminders. */
export class DiscordRateLimits {
  /** In-memory only: never persisted, and reset every poll along with the instance. */
  private outageUntil = 0;
  /** In-memory only per-route soft cooldowns inferred from 2xx rate headers. */
  private readonly softDeadlines: Record<string, number> = {};
  /** Consecutive POST 5xx/timeout failures since Discord last returned a non-5xx, non-429 response. */
  private postFailureStreak = 0;

  constructor(
    private readonly storage?: DurableObjectStorage,
    private readonly deadlines: Record<string, number> = {},
  ) {}

  static async load(storage?: DurableObjectStorage): Promise<DiscordRateLimits> {
    const stored = await storage?.get<Record<string, number>>(KEY) ?? {};
    // A deadline beyond the cap can only come from an older, unclamped write
    // or corrupt storage; dropping it lets delivery resume.
    const now = Date.now();
    return new DiscordRateLimits(storage, Object.fromEntries(Object.entries(stored)
      .filter(([, until]) => Number.isFinite(until) && until > now && until <= now + MAX_RATE_LIMIT_COOLDOWN_MS)));
  }

  /**
   * Record a short, in-memory-only outage after a request exhausts its 5xx
   * retries, so later requests in the same poll fail fast instead of each
   * paying the same retry budget against a service that is already down.
   */
  markOutage(ms: number): void {
    this.outageUntil = Math.max(this.outageUntil, Date.now() + ms);
  }

  /**
   * Record a POST failure (5xx or a thrown fetch error) that this request
   * never retried in-request. Returns true once this is the second such
   * failure in a row, meaning the caller should now declare an outage.
   */
  notePostFailure(): boolean {
    this.postFailureStreak += 1;
    return this.postFailureStreak >= 2;
  }

  /**
   * Any non-5xx HTTP response on any method proves Discord itself is
   * reachable and breaks the POST failure streak; a 4xx such as an
   * unknown-message 404 is not an outage signal. A 429 never reaches this
   * point: it is thrown as a DiscordRateLimitError by `fetch` instead.
   */
  noteDiscordResponded(): void {
    this.postFailureStreak = 0;
  }

  async fetch(path: string, init: RequestInit): Promise<Response> {
    const route = routeKey(path);
    const globalDeadline = this.deadlines[GLOBAL] ?? 0;
    const routeDeadline = this.deadlines[route] ?? 0;
    const softDeadline = this.softDeadlines[route] ?? 0;
    const blockedUntil = Math.max(globalDeadline, routeDeadline, softDeadline, this.outageUntil);
    if (blockedUntil > Date.now()) {
      const reason: DiscordRateLimitReason =
        blockedUntil === globalDeadline || blockedUntil === routeDeadline ? 'rate_limit' :
        blockedUntil === this.outageUntil ? 'outage' : 'soft';
      throw new DiscordRateLimitError(blockedUntil, false, blockedUntil === globalDeadline, reason);
    }

    let response: Response;
    try {
      response = await fetchBuffered(`https://discord.com/api/v10${path}`, init,
        { maxBytes: DISCORD_MAX_RESPONSE_BYTES });
    } catch (err) {
      // An oversized 429 is still a rate limit, but its retry_after and scope
      // headers/body were discarded unread: record a conservative route
      // cooldown instead of letting it pass as a definite rejection.
      if (err instanceof ResponseTooLargeError && err.status === 429) {
        const until = await this.record(route, Date.now() + UNREADABLE_RATE_LIMIT_COOLDOWN_MS);
        throw new DiscordRateLimitError(until, true, false);
      }
      throw err;
    }
    if (response.status !== 429) {
      // A 2xx that reports an exhausted bucket is worth a soft, in-memory-only
      // cooldown: nothing to persist (it will refill on its own), but later
      // calls this poll should not walk straight into a 429.
      if (response.ok && response.headers.get('x-ratelimit-remaining') === '0') {
        const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));
        if (Number.isFinite(resetAfter) && resetAfter >= 0) {
          // Clamped like a real 429, so one absurd header cannot block the route.
          this.softDeadlines[route] = Date.now() + Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, Math.ceil(resetAfter * 1000));
        }
      }
      return response;
    }
    const body = await response.json().catch(() => null) as { retry_after?: unknown; global?: unknown } | null;
    const header = response.headers.get('retry-after');
    const values = [header?.trim() ? Number(header) : NaN,
      typeof body?.retry_after === 'number' ? body.retry_after : NaN]
      .filter((seconds) => Number.isFinite(seconds) && seconds >= 0);
    // Keep the full server cooldown, including fractional seconds. An unusable
    // response gets a conservative fallback rather than an immediate retry.
    // An absurd value is clamped so one bad 429 cannot silence delivery.
    const delay = Math.ceil((values.length ? Math.max(...values) : 60) * 1000);
    const retryAt = Date.now() + Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, Number.isFinite(delay) ? delay : 60_000);
    const global = body?.global === true || response.headers.get('x-ratelimit-global') === 'true' ||
      response.headers.get('x-ratelimit-scope') === 'global';
    throw new DiscordRateLimitError(await this.record(global ? GLOBAL : route, retryAt), true, global);
  }

  /** Extend and persist a real 429 cooldown; returns the effective deadline for `key`. */
  private async record(key: string, retryAt: number): Promise<number> {
    this.deadlines[key] = Math.max(this.deadlines[key] ?? 0, retryAt);
    // Persist before returning to callers. A storage failure here must not
    // mask the rate-limit error itself — the in-memory deadline still applies
    // to the rest of this poll either way.
    try {
      await this.storage?.put(KEY, this.deadlines);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'discord_rate_limit_persist_failed', error: String(err) }));
    }
    return this.deadlines[key]!;
  }
}
