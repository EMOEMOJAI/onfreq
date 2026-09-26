import { DiscordApiError } from './discord';

/**
 * A definite Discord-side rejection (a 4xx `DiscordApiError`; a 429 throws a
 * `DiscordRateLimitError` instead) counts against a bounded retry budget.
 * A 5xx (a `DiscordApiError` with status 500 or above), a timeout/network
 * error, or a rate-limit deferral is transient and retried indefinitely. Shared by the online first-card budget,
 * the offline closeout budget, and the roster page budgets so they agree on
 * what "permanent" means.
 */
export function countsAgainstBudget(err: unknown): boolean {
  return err instanceof DiscordApiError && err.status >= 400 && err.status <= 499;
}

/**
 * Shapes returned by https://api.ivao.aero/v2/tracker/now/atc/summary
 * (only the fields this bot uses).
 */
export interface IvaoAtcSummaryEntry {
  id: number;
  userId: number;
  callsign: string;
  connectionType: string;
  atcSession: {
    frequency: number;
    position: string;
  };
  /** Present for airport positions (TWR/APP/GND/DEL). */
  atcPosition: {
    atcCallsign: string;
    airport?: {
      icao: string;
      name?: string | null;
      city?: string | null;
      countryId?: string | null;
    } | null;
  } | null;
  /** Present for center positions (CTR/FSS). */
  subcenter: {
    atcCallsign: string;
    centerId?: string | null;
  } | null;
}

/** OAuth2 client credentials for the IVAO API, plus the KV token cache. */
export interface IvaoAuth {
  clientId: string;
  clientSecret: string;
  kv: KVNamespace;
}

/** A cached IVAO access token. `expiresAt` already includes a safety margin. */
export interface CachedToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** A currently connected ATC position, normalized for our purposes. */
export interface OnlineAtc {
  sessionId: number;
  userId: number;
  callsign: string;
  frequency: number;
  /** TWR / APP / CTR / GND / DEL / FSS ... */
  position: string;
  /** Human-readable radio callsign, e.g. "Example Control". */
  station: string | null;
  /** Airport name for airport positions. */
  location: string | null;
  /** Airport metadata from IVAO; absent on legacy snapshots and center positions. */
  airport?: {
    icao: string;
    countryId: string | null;
  } | null;
  /** Country declared in this VID's profile, independent of the ATC station. */
  memberCountry?: MemberCountry | null;
}

export interface MemberCountry {
  countryId: string | null;
  /** Next refresh time, including backoff after an unavailable profile. */
  expiresAt: number;
}

/** A Discord message this bot posted for one ATC session. */
export interface PostedMessage {
  channelId: string;
  messageId: string;
  /** Successful initial delivery time in this channel; absent on legacy cards. */
  postedAt?: string;
  /** Last successfully rendered online embed; absent on legacy cards. */
  onlineEmbed?: string;
}

/** Roster overflow is tracked outside sessions so cleanup survives host removal. */
export interface RosterMessage extends PostedMessage {
  parentMessageId: string;
  /** Zero-based index within the continuation messages (excluding the main card). */
  page: number;
  /** Failed delete attempts (4xx only, via `countsAgainstBudget`), e.g. a permanently forbidden channel. */
  deleteAttempts?: number;
  /**
   * Failed edit attempts for this already-posted page since its last success
   * (4xx only, via `countsAgainstBudget`; rate-limit deferrals don't count).
   * Cleared on `abandoned` since there's nothing left to count towards.
   */
  pageAttempts?: number;
  /**
   * Permanently gave up on this page (its budget above was exhausted): frozen
   * in place, never edited or re-posted, while its parent target still lives.
   * An absent entry reads as "never posted" and would otherwise be re-created
   * as a duplicate the next poll.
   */
  abandoned?: true;
}

/**
 * Tracks failed continuation-post attempts for a page that has never once
 * posted successfully, so it has no `RosterMessage` of its own to hold a
 * counter on. Keyed by destination + page since there is no message
 * id yet; dropped once the page is no longer targeted.
 */
export interface RosterPostAttempt {
  channelId: string;
  parentMessageId: string;
  page: number;
  /** Failed post attempts (4xx only, via `countsAgainstBudget`). */
  attempts: number;
  /**
   * Nonce key of the pending post, reused by its retries so Discord can
   * deduplicate a post whose success was hidden by a 5xx or timeout.
   */
  nonceKey?: string;
  /**
   * Epoch ms of the first and latest post attempts that may have landed
   * unseen (a 5xx, a timeout, or a 2xx without an id). Once the parent is no
   * longer shown, its replies from that window are swept for an untracked copy.
   */
  maybePostedFrom?: number;
  maybePostedTo?: number;
  /**
   * Permanently gave up, or Discord accepted the post without returning its
   * id: never posted again while this parent target lives.
   */
  abandoned?: true;
}

/** An ATC position we are tracking across polls. */
export interface TrackedAtc extends OnlineAtc {
  /** ISO timestamp of when we first saw this callsign online. */
  since: string;
  /** Consecutive polls this callsign has been missing from the feed. */
  missed: number;
  /**
   * ISO timestamp of the first poll in which this callsign was missing.
   * Cleared as soon as it reappears; used as the session end time so the
   * reported duration doesn't include the grace window.
   */
  missingSince?: string;
  /**
   * The "is now ONLINE" messages posted for this session. They are edited
   * in place into a grey "was online for …" card when the session ends.
   */
  messages?: PostedMessage[];
  /** Online destinations still awaiting their first successful card. */
  pendingChannelIds?: string[];
  /** Failed initial-card attempts per pending destination (4xx only, via `countsAgainstBudget`). */
  onlineAttemptsByChannel?: Record<string, number>;
  /**
   * Channels whose first-card POST may have landed without the bot learning
   * its id (a 5xx, a timeout, or a 2xx without an id) and that have no
   * tracked card yet. At close the card is recovered and closed out.
   */
  uncertainChannelIds?: string[];
  /**
   * Connected, but the feed has not published a frequency yet (0.000 MHz).
   * Tracked so the start time is right, but not announced and never given
   * an offline card.
   */
  pending?: boolean;
  /**
   * When this session's card was posted. Ordering by this rather than by
   * `since` keeps "newest card" correct for a session that was held back
   * waiting for a frequency and so was carded later than it connected.
   */
  cardAt?: string;
}

/** Persisted session state, keyed by callsign. */
export type StateMap = Record<string, TrackedAtc>;

export interface OfflineEvent extends TrackedAtc {
  /** ISO timestamp the session is considered to have ended at. */
  endedAt: string;
  durationSeconds: number;
}

/** Ended sessions retry independently of any replacement at the same callsign. */
export interface PendingOffline {
  event: OfflineEvent;
  messages: PostedMessage[];
  channelIds: string[];
  /**
   * Channels whose first ONLINE card may exist unseen. The card is re-posted
   * with its original nonce, so Discord returns the hidden one, and then
   * closed like any other card.
   */
  recoverChannelIds?: string[];
  /** Legacy shared counter, imported when a destination next needs retrying. */
  attempts?: number;
  /** Failed delivery polls per destination; cooldown waits do not count. */
  attemptsByChannel?: Record<string, number>;
}

export interface DiffResult {
  next: StateMap;
  wentOnline: TrackedAtc[];
  wentOffline: OfflineEvent[];
  /** Callsigns held back this poll because the feed reported no frequency. */
  pending: string[];
  /** True when `next` differs from `prev` and must be persisted. */
  changed: boolean;
}
