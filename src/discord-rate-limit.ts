import { fetchBuffered } from './http';

const KEY = 'discord-rate-limits-v1'; // gitleaks:allow — storage key name, not a credential
const GLOBAL = '*';

export class DiscordRateLimitError extends Error {
  readonly status = 429;
  constructor(readonly retryAt: number, readonly requestMade: boolean) {
    super('Discord API 429: delivery deferred until cooldown expires');
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
  constructor(
    private readonly storage?: DurableObjectStorage,
    private readonly deadlines: Record<string, number> = {},
  ) {}

  static async load(storage?: DurableObjectStorage): Promise<DiscordRateLimits> {
    const stored = await storage?.get<Record<string, number>>(KEY) ?? {};
    return new DiscordRateLimits(storage, Object.fromEntries(Object.entries(stored)
      .filter(([, until]) => Number.isFinite(until) && until > Date.now())));
  }

  async fetch(path: string, init: RequestInit): Promise<Response> {
    const route = routeKey(path);
    const blockedUntil = Math.max(this.deadlines[GLOBAL] ?? 0, this.deadlines[route] ?? 0);
    if (blockedUntil > Date.now()) throw new DiscordRateLimitError(blockedUntil, false);

    const response = await fetchBuffered(`https://discord.com/api/v10${path}`, init);
    if (response.status !== 429) return response;
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
    // Persist before returning to callers, even if the later session save fails.
    await this.storage?.put(KEY, this.deadlines);
    throw new DiscordRateLimitError(this.deadlines[key], true);
  }
}
