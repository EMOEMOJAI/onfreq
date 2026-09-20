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
  /**
   * This session is the intended host of the "also online now" roster.
   * Per-message onlineEmbed records successful edits, so failed changes retry.
   */
  roster?: boolean;
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
