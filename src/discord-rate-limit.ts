import { fetchBuffered, REQUEST_TIMEOUT_MS, ResponseTooLargeError } from './http';

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

/**
 * A request blocked only by a soft (2xx-header) cooldown waits it out when it
 * is this short, and this instance has waited no more than the total below,
 * instead of deferring to the next poll. Callers with their own deadlines (GCA
 * 25 s, short-session 15 s) may therefore overrun them by at most 5 s.
 */
const MAX_SOFT_WAIT_MS = 5_000;
const MAX_SOFT_WAIT_TOTAL_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cooldown for a 429 whose body exceeded the cap, so its retry_after was never read. */
const UNREADABLE_RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * `rate_limit`: a real Discord 429. `soft`: an in-memory cooldown inferred
 * from a 2xx response's rate-limit headers. `outage`: this route/instance
 * recently exhausted its 5xx retry budget and is failing fast instead.
 * `deadline`: the poll's delivery time budget (`setDeadline`) has run out.
 */
export type DiscordRateLimitReason = 'rate_limit' | 'soft' | 'outage' | 'deadline';

function messageFor(reason: DiscordRateLimitReason): string {
  switch (reason) {
    case 'deadline': return 'Discord request deferred (poll time budget)';
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

/**
 * Conservatively share message-route cooldowns within a channel, never across
 * channels. With a public channel set, non-public channels keep the same
 * per-channel cooldowns under a keyed hash instead (see `publicChannels`).
 */
function routeKey(path: string): string {
  const channel = /^\/channels\/([^/]+)\/messages(?:\/|$)/.exec(path);
  return channel ? `/channels/${channel[1]}/messages` : path.split('?')[0]!;
}

/** The channel id of any `/channels/<id>…` path, query paths included. */
const CHANNEL_PATH = /^\/channels\/([^/?]+)(?=[/?]|$)/;
/** A channel id already replaced by its keyed hash (as stored): never hashed again. */
const HASHED_CHANNEL = /^@h:[0-9a-f]{32}$/;
const HASH_LABEL = 'onfreq-rate-limit:v1:';

/** One instance per serialized poll, shared by public cards and private reminders. */
export class DiscordRateLimits {
  /** In-memory only: never persisted, and reset every poll along with the instance. */
  private outageUntil = 0;
  /** In-memory only per-route soft cooldowns inferred from 2xx rate headers. */
  private readonly softDeadlines: Record<string, number> = {};
  /** Time this instance has spent waiting out soft cooldowns. */
  private softWaitedMs = 0;
  /** Consecutive POST 5xx/timeout failures since Discord last returned a non-5xx, non-429 response. */
  private postFailureStreak = 0;
  /** In-memory only: epoch ms after which no request is sent, or undefined for no bound. */
  private deliveryDeadline: number | undefined;
  /**
   * Configured public channels. With a set (and a hash key), every
   * `/channels/<id>…` route for another id (a DM channel, say) is keyed, in
   * memory and in storage, by `/channels/@h:<hex>/messages`: the first 32 hex
   * characters of HMAC-SHA-256(hash key, HASH_LABEL + id). Cooldowns stay per
   * channel exactly as with plain keys; only the stored name changes, so the
   * persisted map never holds a non-public channel id. All sub-routes of such a
   * channel share that one key (only its /messages routes are used). Without
   * a set, or with an empty hash key, routes are keyed by plain ids as before.
   * The hash key is the bot token, so only a holder of the token (which can
   * reach the channel anyway) can link a candidate id to its stored key; a new
   * token only orphans keys, which leave storage when they expire (<= 1 h).
   */
  private readonly publicChannels: ReadonlySet<string> | undefined;
  /** The HMAC key material until the key is first imported (lazily, on the first non-public route). */
  #hashSecret: string | undefined;
  #hashKey: Promise<CryptoKey> | undefined;
  readonly #hashed = new Map<string, string>();

  /**
   * Only `load` normalises stored keys: deadlines passed here are used as
   * given, so a plain non-public channel key in them is kept as is.
   */
  constructor(
    private readonly storage?: DurableObjectStorage,
    private readonly deadlines: Record<string, number> = {},
    publicChannels?: ReadonlySet<string>,
    hashKey?: string,
  ) {
    this.publicChannels = publicChannels && hashKey ? publicChannels : undefined;
    this.#hashSecret = this.publicChannels ? hashKey : undefined;
  }

  static async load(
    storage?: DurableObjectStorage, publicChannels?: ReadonlySet<string>, hashKey?: string,
  ): Promise<DiscordRateLimits> {
    const stored = await storage?.get<Record<string, number>>(KEY) ?? {};
    // A deadline beyond the cap can only come from an older, unclamped write
    // or corrupt storage; dropping it lets delivery resume.
    const now = Date.now();
    const kept = Object.entries(stored)
      .filter(([, until]) => Number.isFinite(until) && until > now && until <= now + MAX_RATE_LIMIT_COOLDOWN_MS);
    const deadlines: Record<string, number> = {};
    const limits = new DiscordRateLimits(storage, deadlines, publicChannels, hashKey);
    // Only after that filter, so an expired or over-cap plain key never
    // overrides a valid hashed one: a plain non-public channel key (written
    // before keys were hashed) is renamed to its hashed key (the later
    // deadline wins). Already hashed keys are kept as they are.
    let renamed = false;
    for (const [route, until] of kept) {
      const id = limits.privateChannel(route);
      const key = id === undefined ? route : await limits.hashedRoute(id);
      if (key !== route) renamed = true;
      deadlines[key] = Math.max(deadlines[key] ?? 0, until);
    }
    if (storage && (renamed || kept.length < Object.keys(stored).length)) {
      // Expired cooldowns and plain non-public channel ids (DM channels) are
      // not left in storage. Best effort, as in `record`.
      try {
        await (kept.length ? storage.put(KEY, deadlines) : storage.delete(KEY));
      } catch (err) {
        console.warn(JSON.stringify({ event: 'discord_rate_limit_persist_failed', error: String(err) }));
      }
    }
    return limits;
  }

  /** The non-public channel id a path addresses, or undefined when its route keeps a plain key. */
  private privateChannel(path: string): string | undefined {
    if (!this.publicChannels) return undefined;
    const id = CHANNEL_PATH.exec(path)?.[1];
    if (id === undefined || this.publicChannels.has(id) || HASHED_CHANNEL.test(id)) return undefined;
    return id;
  }

  /** The one route key, in memory and in storage, for every path of a non-public channel. */
  private async hashedRoute(id: string): Promise<string> {
    return `/channels/@h:${await this.channelHash(id)}/messages`;
  }

  private async channelHash(id: string): Promise<string> {
    const cached = this.#hashed.get(id);
    if (cached !== undefined) return cached;
    if (!this.#hashKey) {
      this.#hashKey = crypto.subtle.importKey('raw', new TextEncoder().encode(this.#hashSecret ?? ''),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      this.#hashSecret = undefined;
    }
    const mac = await crypto.subtle.sign('HMAC', await this.#hashKey, new TextEncoder().encode(HASH_LABEL + id));
    const hex = [...new Uint8Array(mac, 0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    this.#hashed.set(id, hex);
    return hex;
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

  /**
   * Bound the time this instance may spend on requests: `fetch` starts a
   * request only if it can finish (REQUEST_TIMEOUT_MS) by `deadline`, and no
   * soft wait or 5xx backoff sleeps past the last moment a request may start.
   * Undefined removes the bound.
   */
  setDeadline(deadline: number | undefined): void {
    this.deliveryDeadline = deadline;
  }

  /**
   * True when a request begun `delayMs` from now could still finish within the
   * delivery deadline, assuming the worst case of REQUEST_TIMEOUT_MS. Always
   * true while no deadline is set. Exactly REQUEST_TIMEOUT_MS of budget fits.
   */
  canStartBy(delayMs: number): boolean {
    return this.deliveryDeadline === undefined ||
      Date.now() + delayMs + REQUEST_TIMEOUT_MS <= this.deliveryDeadline;
  }

  /** The deferral for a request that `canStartBy` rejected: no request was made. */
  deadlineDeferral(): DiscordRateLimitError {
    return new DiscordRateLimitError(this.deliveryDeadline ?? Date.now(), false, false, 'deadline');
  }

  async fetch(path: string, init: RequestInit): Promise<Response> {
    if (!this.canStartBy(0)) throw this.deadlineDeferral();
    // Public, global and guild routes are keyed synchronously; only a
    // non-public channel waits for its hash, computed once for every use below.
    const hidden = this.privateChannel(path);
    const route = hidden === undefined ? routeKey(path) : await this.hashedRoute(hidden);
    const globalDeadline = this.deadlines[GLOBAL] ?? 0;
    const routeDeadline = this.deadlines[route] ?? 0;
    const softDeadline = this.softDeadlines[route] ?? 0;
    const hardUntil = Math.max(globalDeadline, routeDeadline, this.outageUntil);
    const blockedUntil = Math.max(hardUntil, softDeadline);
    if (blockedUntil > Date.now()) {
      const wait = blockedUntil - Date.now();
      // Only the soft deadline blocks, and briefly: wait it out rather than defer.
      const withinBudget = this.canStartBy(wait);
      if (hardUntil <= Date.now() && wait <= MAX_SOFT_WAIT_MS && this.softWaitedMs + wait <= MAX_SOFT_WAIT_TOTAL_MS &&
          withinBudget) {
        this.softWaitedMs += wait;
        await sleep(wait);
      } else {
        const reason: DiscordRateLimitReason =
          hardUntil <= Date.now() && !withinBudget && wait <= MAX_SOFT_WAIT_MS ? 'deadline' :
          blockedUntil === globalDeadline || blockedUntil === routeDeadline ? 'rate_limit' :
          blockedUntil === this.outageUntil ? 'outage' : 'soft';
        throw new DiscordRateLimitError(blockedUntil, false, blockedUntil === globalDeadline, reason);
      }
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
    const effective = Math.max(this.deadlines[key] ?? 0, retryAt);
    this.deadlines[key] = effective;
    // Expired entries are not persisted again (nor, without a public channel
    // set, the plain DM channel ids they may hold).
    const now = Date.now();
    for (const [route, until] of Object.entries(this.deadlines)) if (until <= now) delete this.deadlines[route];
    // Persist before returning to callers. A storage failure here must not
    // mask the rate-limit error itself — the in-memory deadline still applies
    // to the rest of this poll either way.
    try {
      await this.storage?.put(KEY, this.deadlines);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'discord_rate_limit_persist_failed', error: String(err) }));
    }
    return effective;
  }
}

/**
 * The same limits, noting each POST (a DM or a staff copy) before it is sent,
 * so a POST that then fails or is rate-limited still counts. Every other
 * property acts on `limits` itself; a call without `init` forwards `{}`.
 */
export function trackPosts(limits: DiscordRateLimits, onPost: () => void): DiscordRateLimits {
  return new Proxy(limits, {
    get(target, property) {
      if (property === 'fetch') {
        return (path: string, init?: RequestInit) => {
          if (init?.method === 'POST') onPost();
          return target.fetch(path, init ?? {});
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
