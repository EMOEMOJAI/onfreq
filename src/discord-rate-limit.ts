import { fetchBuffered } from './http';

const KEY = 'discord-rate-limits-v1'; // gitleaks:allow — storage key name, not a credential
const GLOBAL = '*';

export class DiscordRateLimitError extends Error {
  readonly status = 429;
  constructor(readonly retryAt: number, readonly requestMade: boolean, readonly global = false) {
    super('Discord API 429: delivery deferred until cooldown expires');
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

  constructor(
    private readonly storage?: DurableObjectStorage,
    private readonly deadlines: Record<string, number> = {},
  ) {}

  static async load(storage?: DurableObjectStorage): Promise<DiscordRateLimits> {
    const stored = await storage?.get<Record<string, number>>(KEY) ?? {};
    return new DiscordRateLimits(storage, Object.fromEntries(Object.entries(stored)
      .filter(([, until]) => Number.isFinite(until) && until > Date.now())));
  }

  /**
   * Record a short, in-memory-only outage after a request exhausts its 5xx
   * retries, so later requests in the same poll fail fast instead of each
   * paying the same retry budget against a service that is already down.
   */
  markOutage(ms: number): void {
    this.outageUntil = Math.max(this.outageUntil, Date.now() + ms);
  }

  async fetch(path: string, init: RequestInit): Promise<Response> {
    const route = routeKey(path);
    const blockedUntil = Math.max(
      this.deadlines[GLOBAL] ?? 0,
      this.deadlines[route] ?? 0,
      this.softDeadlines[route] ?? 0,
      this.outageUntil,
    );
    if (blockedUntil > Date.now()) {
      throw new DiscordRateLimitError(blockedUntil, false, blockedUntil === this.deadlines[GLOBAL]);
    }

    const response = await fetchBuffered(`https://discord.com/api/v10${path}`, init);
    if (response.status !== 429) {
      // A 2xx that reports an exhausted bucket is worth a soft, in-memory-only
      // cooldown: nothing to persist (it will refill on its own), but later
      // calls this poll should not walk straight into a 429.
      if (response.ok && response.headers.get('x-ratelimit-remaining') === '0') {
        const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));
        if (Number.isFinite(resetAfter) && resetAfter >= 0) {
          this.softDeadlines[route] = Date.now() + Math.ceil(resetAfter * 1000);
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
    const delay = Math.ceil((values.length ? Math.max(...values) : 60) * 1000);
    const retryAt = Date.now() + (Number.isFinite(delay) ? delay : 60_000);
    const global = body?.global === true || response.headers.get('x-ratelimit-global') === 'true' ||
      response.headers.get('x-ratelimit-scope') === 'global';
    const key = global ? GLOBAL : route;
    this.deadlines[key] = Math.max(this.deadlines[key] ?? 0, retryAt);
    // Persist before returning to callers. A storage failure here must not
    // mask the rate-limit error itself — the in-memory deadline still applies
    // to the rest of this poll either way.
    try {
      await this.storage?.put(KEY, this.deadlines);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'discord_rate_limit_persist_failed', error: String(err) }));
    }
    throw new DiscordRateLimitError(this.deadlines[key], true, global);
  }
}
