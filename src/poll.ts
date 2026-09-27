import { parseFirLabels, type FirLabel } from './config';
import {
  buildOfflineEmbed,
  buildOnlineEmbed,
  buildOnlineEmbeds,
  buildSessionEndedEmbed,
  countsAgainstBudget,
  DiscordApiError,
  DiscordUnconfirmedPostError,
  editMessage,
  escapeMarkdown,
  findBotMessages,
  isSnowflake,
  messageNonce,
  parseChannelIds,
  postMessage,
  snowflakeTime,
} from './discord';
import {
  fetchDivisionAtc,
  isExcludedCallsign,
  ivaoAuthFromEnv,
  parseExcludedCallsigns,
  parsePrefixes,
} from './ivao';
import { diffState, loadPendingOffline, loadSessions, newestCardedSession, offlineEventFor } from './state';
import { countryCode, enrichMemberCountries } from './member-country';
import { gcaMismatch, gcaRemindersEnabled, parseGcaPolicy, sendGcaReminders, type GcaPolicy } from './gca';
import { channelIndex, mayHavePosted, nextBudget, syncRosterMessages, type RosterTarget } from './roster';
import { DiscordRateLimitError, DiscordRateLimits } from './discord-rate-limit';
import type {
  OfflineEvent, PendingOffline, OnlineAtc, PostedMessage, PostWindow, RosterMessage, RosterPostAttempt, StateMap,
  TrackedAtc,
} from './types';

function parseGracePolls(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(Math.max(n, 1), 10);
}

/**
 * Pending closeouts older than this are attempted once more, then dropped if
 * still undelivered; beyond MAX_OFFLINE_JOBS (oldest first) they are dropped.
 */
const OFFLINE_JOB_MAX_AGE_MS = 24 * 3_600_000;
const MAX_OFFLINE_JOBS = 200;
/**
 * More brand-new sessions than this in one poll is treated as a feed anomaly:
 * they are tracked silently, like the first-run baseline, instead of carded.
 */
const MAX_NEW_SESSIONS_PER_POLL = 50;

/** Closeout destinations in channels removed from DISCORD_CHANNEL_IDS, kept untouched. */
interface ParkedDestinations {
  messages: PostedMessage[];
  channelIds: string[];
  recoverPosts: Record<string, PostWindow>;
  attemptsByChannel: Record<string, number>;
}

function hasDestinations(job: { messages: unknown[]; channelIds: unknown[]; recoverPosts?: object }): boolean {
  return job.messages.length > 0 || job.channelIds.length > 0 || Object.keys(job.recoverPosts ?? {}).length > 0;
}

const DEFAULT_MENTION_COOLDOWN_MINUTES = 10;

/** The role pinged for new cards, or undefined when unset or not a Discord ID. */
function parseMentionRole(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  if (isSnowflake(text)) return text;
  console.error(JSON.stringify({ event: 'mention_config_invalid', reason: 'role' }));
  return undefined;
}

/** Minimum time between role pings in one channel; 0 limits pings to one per channel per poll. */
function parseMentionCooldownMs(raw: string | undefined): number {
  const text = raw?.trim();
  const valid = !!text && /^\d{1,4}$/.test(text);
  if (text && !valid) console.error(JSON.stringify({ event: 'mention_config_invalid', reason: 'cooldown' }));
  return Math.min(valid ? Number(text) : DEFAULT_MENTION_COOLDOWN_MINUTES, 1440) * 60_000;
}

function highlightMismatch(atc: OnlineAtc, policy: GcaPolicy | null): boolean {
  if (!policy) return false;
  const onlineCountry = countryCode(atc.airport?.countryId);
  const memberCountry = countryCode(atc.memberCountry?.countryId);
  return Boolean(onlineCountry && memberCountry && onlineCountry !== memberCountry && gcaMismatch(atc, policy));
}

function logFailure(event: string, callsign: string, channelIds: string[], channelId: string, err: unknown): void {
  console.error(JSON.stringify({ event, callsign, channelIndex: channelIndex(channelIds, channelId), error: String(err) }));
}

/**
 * Nonce of a session's first ONLINE card in a channel: keyed to the IVAO
 * connection the session was first seen with, not the poll-time `since`, so a
 * re-send after a poll whose state was never saved returns the original card
 * instead of posting a duplicate. Older sessions keep their `since`-based key.
 */
function onlineNonce(atc: TrackedAtc, channelId: string): string {
  const identity = atc.firstSessionId === undefined ? atc.since : `session-${atc.firstSessionId}`;
  return messageNonce(`online:${atc.userId}:${atc.callsign}:${identity}`, channelId);
}

/**
 * Whether a message id returned for a first-card POST was created shortly
 * before this poll, i.e. Discord returned an earlier message for a reused
 * nonce (an unsaved earlier poll, or the same connection re-tracked). Its
 * content is then unknown and gets refreshed. Ids outside the nonce-window
 * range, or not snowflakes, read as new.
 */
function createdBeforePoll(messageId: string, pollStartMs: number): boolean {
  if (!isSnowflake(messageId)) return false;
  const createdMs = snowflakeTime(messageId);
  return createdMs < pollStartMs - 10_000 && createdMs > pollStartMs - 3_600_000;
}

/** Values constant across every card posted/edited within one poll. */
interface PollContext {
  env: Env;
  labels: FirLabel[];
  /** Drives the public mismatch marker: null unless reminders are enabled with a valid policy. */
  highlightPolicy: GcaPolicy | null;
  limits: DiscordRateLimits;
  nowIso: string;
  /** Configured destinations; logs name a channel only by its index here. */
  channelIds: string[];
  mentionRoleId: string | undefined;
  /** Last role ping per channel (epoch ms) still within its cooldown; updated in place. */
  rolePings: Record<string, number>;
  mentionCooldownMs: number;
}

/**
 * Post one "is now ONLINE" message per channel and return the message IDs,
 * so the session can be closed out by editing those exact messages later,
 * plus the error for each channel that failed.
 */
async function announceOnline(
  ctx: PollContext,
  atc: TrackedAtc,
  channelIds: string[],
  mentionedChannels: Set<string>,
  current: OnlineAtc[],
  holderChannels: Set<string>,
  retry: boolean,
): Promise<{ posted: PostedMessage[]; failed: Map<string, unknown>; unconfirmed: Set<string> }> {
  const { env, labels, highlightPolicy, limits, nowIso, channelIds: configured, mentionRoleId, rolePings } = ctx;
  const mismatch = highlightMismatch(atc, highlightPolicy);
  const plain = buildOnlineEmbed(atc, current, labels, mismatch);
  // The expected roster holder posts its first roster page directly, matching
  // what syncOnlineCards renders, so the new card needs no follow-up edit.
  const holder = buildOnlineEmbeds(
    atc, current.filter((other) => other.callsign !== atc.callsign), current, labels, mismatch,
  )[0];
  const posted: PostedMessage[] = [];
  const failed = new Map<string, unknown>();
  // A 2xx POST with no usable id (Discord accepted it, but the
  // response can't be tied to a message) is never retried.
  const unconfirmed = new Set<string>();
  for (const channelId of channelIds) {
    // At most one role ping per channel per poll, however many controllers
    // connected at once, and none again within the channel's cooldown, so
    // reconnecting cannot spam the role.
    const content =
      mentionRoleId && !mentionedChannels.has(channelId) && rolePings[channelId] === undefined
        ? `<@&${mentionRoleId}>`
        : undefined;
    const recordPing = () => {
      if (!content) return;
      mentionedChannels.add(channelId);
      if (ctx.mentionCooldownMs > 0) rolePings[channelId] = Date.parse(nowIso);
    };
    const embed = holderChannels.has(channelId) ? holder : plain;
    try {
      // A POST whose 5xx hid a success is re-sent next poll; its nonce lets
      // Discord return the original message instead of a duplicate card.
      const messageId = await postMessage(env.DISCORD_BOT_TOKEN, channelId, embed, content, undefined, limits,
        onlineNonce(atc, channelId));
      // On a retry the nonce may have returned the earlier, possibly older
      // message: leave its content unknown so the next reconcile edits it.
      const reused = retry || createdBeforePoll(messageId, Date.parse(nowIso));
      posted.push({ channelId, messageId, postedAt: nowIso, ...(reused ? {} : { onlineEmbed: JSON.stringify(embed) }) });
      recordPing();
    } catch (err) {
      // A 2xx without a usable message id: never retried (it could only
      // duplicate the card); recorded as uncertain below so the session's
      // end finds the card and closes it.
      if (err instanceof DiscordUnconfirmedPostError) {
        console.error(JSON.stringify({
          event: 'online_post_unconfirmed', callsign: atc.callsign, channelIndex: channelIndex(configured, channelId),
        }));
        // Discord accepted the message, ping included.
        recordPing();
        unconfirmed.add(channelId);
        continue;
      }
      logFailure('online_post_failed', atc.callsign, configured, channelId, err);
      failed.set(channelId, err);
    }
  }
  return { posted, failed, unconfirmed };
}

/** Reconcile displayed cards, retrying only messages whose last edit failed. */
async function syncOnlineCards(
  ctx: PollContext, next: StateMap, current: OnlineAtc[],
): Promise<{ targets: RosterTarget[]; failed: boolean }> {
  const { env, labels, highlightPolicy, limits, channelIds } = ctx;
  const coverage = current.map((atc) => (Object.hasOwn(next, atc.callsign) ? next[atc.callsign] : undefined) ?? atc);
  let targets: RosterTarget[];
  let failed = false;
  let removedMessage: boolean;
  // A reference whose edit already failed this poll is not retried by a
  // later reconcile pass (triggered by a deleted host elsewhere): the extra
  // attempt would only waste a subrequest on a destination already known bad.
  const failedRefs = new Set<PostedMessage>();
  do {
    targets = [];
    removedMessage = false;
    const channels = new Set(Object.values(next).flatMap((session) =>
      (session.messages ?? []).map((ref) => ref.channelId)));
    const holders = new Map([...channels].map((channel) => [channel, newestCardedSession(next, channel)]));
    for (const [callsign, session] of Object.entries(next)) {
      // Sessions still awaiting a frequency have no card to reconcile.
      if (session.pending) continue;
      for (const ref of [...(session.messages ?? [])]) {
        // A channel removed from DISCORD_CHANNEL_IDS is never written to again.
        if (!channelIds.includes(ref.channelId)) continue;
        const isHolder = callsign === holders.get(ref.channelId);
        const others = isHolder ? coverage.filter((atc) => atc.callsign !== callsign) : [];
        const [embed, ...continuations] = buildOnlineEmbeds(
          session, others, coverage, labels, highlightMismatch(session, highlightPolicy),
        );
        const rendered = JSON.stringify(embed);
        let updated = ref.onlineEmbed === rendered;
        if (!updated && !failedRefs.has(ref)) {
          try {
            await editMessage(env.DISCORD_BOT_TOKEN, ref.channelId, ref.messageId, embed, limits);
            ref.onlineEmbed = rendered;
            updated = true;
          } catch (err) {
            logFailure('online_edit_failed', callsign, channelIds, ref.channelId, err);
            if (err instanceof DiscordApiError && err.isGone && err.status !== 404) {
              // The card cannot be addressed (a corrupt stored id) or reached
              // (a 403, access that may return), but it was posted: record
              // when, so the session's end finds that card among the bot's
              // messages (or re-posts it under its nonce) and closes it.
              const postedMs = [ref.postedAt, session.cardAt, session.since]
                .map((at) => Date.parse(at ?? '')).find(Number.isFinite);
              if (postedMs !== undefined) {
                const known = session.uncertainPosts?.[ref.channelId];
                session.uncertainPosts = { ...session.uncertainPosts, [ref.channelId]: {
                  from: Math.min(known?.from ?? postedMs, postedMs), to: Math.max(known?.to ?? 0, postedMs + 60_000),
                } };
              }
            }
            if (err instanceof DiscordApiError && err.isGone) {
              session.messages = session.messages?.filter((message) => message !== ref);
              // Every card for this session is now gone (deleted channel/message).
              // Without a pending marker, `close()` would treat that as an
              // unannounced session and fire a fallback OFFLINE to every
              // configured channel; mark it as already-resolved instead.
              if (!session.messages?.length) session.pendingChannelIds ??= [];
              removedMessage = true;
              continue;
            }
            failed = true;
            failedRefs.add(ref);
          }
        }
        if (isHolder || !updated) {
          targets.push({ channelId: ref.channelId, parentMessageId: ref.messageId,
            ...(updated ? { embeds: continuations } : {}) });
        }
      }
    }
    // A deleted host cannot carry coverage. Reconcile again to choose a
    // surviving card. Every extra pass removes a reference, so this terminates.
  } while (removedMessage);
  return { targets, failed };
}

/** Close only unresolved destinations; successful deliveries are never repeated. */
async function announceOffline(
  env: Env, job: PendingOffline, labels: FirLabel[], limits: DiscordRateLimits, trackedIds: Set<string>,
  liveIds: Set<string>, channelIds: string[],
): Promise<{ delivered: number; failed: boolean; deferred: boolean }> {
  const index = (channelId: string) => channelIndex(channelIds, channelId);
  const endedEmbed = buildSessionEndedEmbed(job.event, labels);
  const fallbackEmbed = buildOfflineEmbed(job.event, labels);
  const remaining: PostedMessage[] = [];
  let delivered = 0;
  let failed = false;
  // A destination kept after a rate-limit or outage deferral that sent no
  // request this poll: an expired job is then kept for another attempt.
  let deferred = false;
  const attempts = job.attemptsByChannel ??= {};
  // A destination is charged at most one failed poll, however many of its
  // requests fail this poll; once that exhausts its budget, every remaining
  // request there is given up with it.
  const charged = new Set<string>();
  const exhausted = new Set<string>();
  // Only a definite Discord-side rejection counts towards this budget
  // (`nextBudget`, shared with the online first-card and roster page
  // budgets); a 5xx outage or a timeout/network error is transient and
  // retried instead, so a prolonged Discord outage cannot abandon a closeout
  // early. Only the job's overall age bound (OFFLINE_JOB_MAX_AGE_MS) ends
  // those retries, and a job past it still gets one final attempt before it
  // is dropped.
  const keepForRetry = (channelId: string, err: unknown): boolean => {
    if (err instanceof DiscordUnconfirmedPostError) {
      // Discord accepted the fallback without returning its id: it was
      // delivered, and posting again could only duplicate it.
      console.error(JSON.stringify({ event: 'offline_post_unconfirmed', callsign: job.event.callsign, channelIndex: index(channelId) }));
      delivered++;
      delete attempts[channelId];
      return false;
    }
    failed = true;
    if (exhausted.has(channelId)) return false;
    const { used, keep } = nextBudget(attempts[channelId] ?? job.attempts ?? 0, err, !charged.has(channelId));
    if (countsAgainstBudget(err)) charged.add(channelId);
    if (keep) {
      attempts[channelId] = used;
      if (err instanceof DiscordRateLimitError && !err.requestMade) deferred = true;
      return true;
    }
    exhausted.add(channelId);
    delete attempts[channelId];
    console.error(JSON.stringify({ event: 'offline_abandoned', callsign: job.event.callsign, channelIndex: index(channelId) }));
    return false;
  };
  // Keyed on the tracked session (callsign and stable `since`), not the
  // IVAO-issued `sessionId`, so a genuinely new session never collides with
  // this one's nonce.
  const offlineKey = `offline:${job.event.userId}:${job.event.callsign}:${job.event.since}`;
  /** Post the standalone OFFLINE notice; true when the destination is kept for a retry. */
  const postFallback = async (channelId: string): Promise<boolean> => {
    try {
      await postMessage(env.DISCORD_BOT_TOKEN, channelId, fallbackEmbed, undefined, undefined, limits,
        messageNonce(offlineKey, channelId));
      delivered++;
      delete attempts[channelId];
      return false;
    } catch (err) {
      if (!(err instanceof DiscordUnconfirmedPostError)) {
        logFailure('offline_post_failed', job.event.callsign, channelIds, channelId, err);
      }
      return keepForRetry(channelId, err);
    }
  };
  // Recover first cards that may exist unseen, so they are closed below:
  // look for them among the bot's messages from the uncertain attempts, and
  // only when none is found re-post with the original nonce (which returns
  // the hidden card within Discord's nonce window, or else a new one).
  const recovering: Record<string, PostWindow> = {};
  // The exact title ending, so a card for XEGLL_TWR never matches EGLL_TWR;
  // cards tracked for any session (such as a later one of this callsign)
  // are never touched.
  const onlineTitle = ` ${escapeMarkdown(job.event.callsign)} is now ONLINE`;
  for (const [channelId, window] of Object.entries(job.recoverPosts ?? {})) {
    try {
      let found: string[] = [];
      try {
        found = await findBotMessages(env.DISCORD_BOT_TOKEN, channelId, window, limits,
          (message) => !message.message_reference && !trackedIds.has(message.id) &&
            !!message.embeds?.[0]?.title?.endsWith(onlineTitle) &&
            // Every first card carries its session's start time.
            Date.parse(message.embeds[0].timestamp ?? '') === Date.parse(job.event.since));
      } catch (err) {
        // Without message history access (a 4xx), a channel without a tracked
        // card falls back to the re-post below; one with a tracked card has
        // nothing more to try.
        if (!countsAgainstBudget(err)) throw err;
        logFailure('offline_recover_lookup_failed', job.event.callsign, channelIds, channelId, err);
      }
      if (!found.length && window.closeOnly) {
        // No stray copy of a tracked card could be found: nothing is left to
        // close here.
        delivered++;
        continue;
      }
      if (!found.length) {
        found = [await postMessage(env.DISCORD_BOT_TOKEN, channelId,
          buildOnlineEmbed(job.event, undefined, labels), undefined, undefined, limits, onlineNonce(job.event, channelId))];
      }
      // A card a live session tracks (its nonce returned by the re-post) is
      // never this job's to end: nothing is left to close here.
      found = found.filter((messageId) => !liveIds.has(messageId));
      if (!found.length) {
        delivered++;
        continue;
      }
      for (const messageId of found) job.messages.push({ channelId, messageId });
    } catch (err) {
      if (err instanceof DiscordUnconfirmedPostError) {
        // The card exists but still cannot be edited: announce the end instead.
        console.error(JSON.stringify({
          event: 'offline_recover_unconfirmed', callsign: job.event.callsign, channelIndex: index(channelId),
        }));
        if (!job.channelIds.includes(channelId)) job.channelIds.push(channelId);
        continue;
      }
      logFailure('offline_recover_failed', job.event.callsign, channelIds, channelId, err);
      if (keepForRetry(channelId, err)) recovering[channelId] = window;
    }
  }
  if (Object.keys(recovering).length) job.recoverPosts = recovering;
  else delete job.recoverPosts;
  for (const ref of job.messages) {
    try {
      await editMessage(env.DISCORD_BOT_TOKEN, ref.channelId, ref.messageId, endedEmbed, limits);
      delivered++;
      delete attempts[ref.channelId];
      continue;
    } catch (err) {
      logFailure('offline_edit_failed', job.event.callsign, channelIds, ref.channelId, err);
      if (!(err instanceof DiscordApiError && err.isGone)) {
        if (keepForRetry(ref.channelId, err)) remaining.push(ref);
        continue;
      }
    }
    if (await postFallback(ref.channelId)) remaining.push(ref);
  }
  job.messages = remaining;
  const remainingChannels: string[] = [];
  for (const channelId of job.channelIds) {
    if (await postFallback(channelId)) remainingChannels.push(channelId);
  }
  job.channelIds = remainingChannels;
  // Keep a numeric legacy field so an older Worker can still retry on rollback.
  job.attempts = 0;
  return { delivered, failed, deferred };
}

export interface PollOutcome {
  state: StateMap;
  rosterMessages: RosterMessage[];
  /** Budget for continuation pages that have never once posted successfully. */
  rosterPostAttempts: RosterPostAttempt[];
  pendingOffline: PendingOffline[];
  /** Last role ping per channel (epoch ms), kept while its cooldown runs. */
  rolePings: Record<string, number>;
  error?: string;
}

export interface RunPollOptions {
  storage?: DurableObjectStorage;
  previousRosterMessages?: RosterMessage[];
  previousRosterPostAttempts?: RosterPostAttempt[];
  previousPendingOffline?: PendingOffline[];
  previousRolePings?: Record<string, number>;
}

/** Called only by the coordinator; all network and notification work is one poll. */
export async function runPoll(
  env: Env, stored: StateMap | null, nowIso: string, options: RunPollOptions = {},
): Promise<PollOutcome> {
  const {
    storage, previousRosterMessages = [], previousRosterPostAttempts = [], previousPendingOffline = [],
    previousRolePings = {},
  } = options;
  const channelIds = [...new Set(parseChannelIds(env.DISCORD_CHANNEL_IDS))];
  if (!channelIds.length || !env.DISCORD_BOT_TOKEN?.trim()) {
    throw new Error('Discord bot token and notification channels are required');
  }
  const prefixes = parsePrefixes(env.FIR_PREFIXES);
  const labels = parseFirLabels(env.FIR_LABELS);
  const gracePolls = parseGracePolls(env.OFFLINE_GRACE_POLLS);
  const limits = await DiscordRateLimits.load(storage);

  const auth = ivaoAuthFromEnv(env);
  const currentAll = await fetchDivisionAtc(prefixes, auth);

  // Excluded callsigns (the EXCLUDED_CALLSIGNS list plus `xxxx_X_yyy`
  // special positions) never enter the notification pipeline. Prune them
  // from previously tracked state too, so adding an exclusion for a
  // currently-online position doesn't fire a spurious "offline" notice.
  const excluded = parseExcludedCallsigns(env.EXCLUDED_CALLSIGNS);
  // Stable ordering also preserves the host when several cards share cardAt.
  const current = currentAll
    .filter((a) => !isExcludedCallsign(a.callsign, excluded))
    .sort((a, b) => a.callsign.localeCompare(b.callsign));
  // Normalized once here: invalid entries are dropped, legacy fields stripped.
  const prev = loadSessions(stored ?? {});
  const previousJobs = loadPendingOffline(previousPendingOffline);
  // A callsign carded before it was excluded must have its card closed out,
  // not silently abandoned: it disappears from `prev`/`next` below (so
  // `diffState` cannot see it went offline), so queue a closeout here for
  // any excluded session that had a live card or may have one unseen.
  const excludedClosures: OfflineEvent[] = [];
  for (const callsign of Object.keys(prev)) {
    if (isExcludedCallsign(callsign, excluded)) {
      const tracked = prev[callsign]!;
      // A session already missing (grace window) keeps the poll it went
      // missing as its end time, matching `diffState`, instead of stretching
      // the duration to this poll.
      const event = offlineEventFor(tracked, 0, tracked.missingSince ?? nowIso);
      if (event) excludedClosures.push(event);
      delete prev[callsign];
    }
  }

  await enrichMemberCountries(current, prev, auth);
  const gcaPolicy = parseGcaPolicy(env);

  if (storage) {
    try {
      await sendGcaReminders(env, current, storage, Date.parse(nowIso), gcaPolicy, labels, limits);
    } catch (err) {
      // DM lookup/storage failures must not break the public ATC cards. Only
      // the error class is logged: a message could carry private details.
      console.error(JSON.stringify({ event: 'gca_poll_failed', error: err instanceof Error ? err.name : typeof err }));
    }
  }

  const { next, wentOnline, wentOffline, pending } = diffState(
    prev,
    current,
    nowIso,
    gracePolls,
  );
  // Record the IVAO connection a session was first seen with, for its card
  // nonce. Only sessions first tracked this poll: an older session without it
  // keeps the `since` key any earlier attempt already used.
  // A connection re-tracked while an ended session of the same connection
  // still has a closeout pending keeps the `since` key instead: sharing that
  // session's nonce would hand it the card the closeout is about to end.
  // Residual (accepted): if the first card posts but this poll's snapshot is
  // never saved and the controller reconnects under a new IVAO connection id
  // before the next poll, the card is never tracked and so never closed.
  const closingKey = (event: TrackedAtc) =>
    event.firstSessionId === undefined ? undefined : `${event.userId}:${event.callsign}:${event.firstSessionId}`;
  const closing = new Set([
    ...previousJobs.map((job) => job.event), ...wentOffline, ...excludedClosures,
  ].map(closingKey));
  for (const session of Object.values(next)) {
    if (session.since === nowIso && session.firstSessionId === undefined &&
        Number.isSafeInteger(session.sessionId) && session.sessionId > 0 &&
        !closing.has(`${session.userId}:${session.callsign}:${session.sessionId}`)) {
      session.firstSessionId = session.sessionId;
    }
  }

  if (pending.length > 0) {
    // Connected but not tuned yet — announced as soon as IVAO publishes a
    // frequency, usually the next poll.
    console.log(JSON.stringify({ event: 'awaiting_frequency', callsigns: pending }));
  }

  // First run after deployment: seed the state silently so we don't blast
  // a notification for every controller that is already online.
  if (stored === null) {
    console.log(JSON.stringify({ event: 'state_seeded', online: current.length }));
    // Mark every seeded entry as never-carded, the same invariant `close()`
    // relies on for a failed announcement: without it, a seeded session that
    // later disconnects would silently earn a fallback OFFLINE post despite
    // never having had a real ONLINE card.
    for (const session of Object.values(next)) session.pendingChannelIds ??= [];
    return {
      state: next, rosterMessages: previousRosterMessages, rosterPostAttempts: previousRosterPostAttempts,
      pendingOffline: previousJobs, rolePings: previousRolePings,
    };
  }

  // A feed suddenly reporting an implausible number of new sessions (an
  // upstream glitch or replay) must not flood channels with cards and pings:
  // those sessions are tracked silently, like the first-run baseline, and so
  // also never earn an offline card.
  let newlyOnline: TrackedAtc[] = wentOnline;
  if (wentOnline.length > MAX_NEW_SESSIONS_PER_POLL) {
    console.error(JSON.stringify({ event: 'feed_anomaly', count: wentOnline.length }));
    for (const atc of wentOnline) next[atc.callsign]!.pendingChannelIds = [];
    newlyOnline = [];
  }

  let attempted = 0;
  let delivered = 0;
  let deliveryFailed = false;
  const coverage = current.map((atc) => (Object.hasOwn(next, atc.callsign) ? next[atc.callsign] : undefined) ?? atc);
  const mentionedChannels = new Set<string>();

  // Close out sessions that ended before announcing any that just started,
  // so a callsign that goes offline and a replacement taking it over the
  // same poll are never shown online before their predecessor's closeout.
  const nowMs = Date.parse(nowIso);
  // A job whose end time cannot be read is treated as current, never expired.
  const endedMs = (job: PendingOffline) => {
    const ended = Date.parse(job.event.endedAt);
    return Number.isFinite(ended) ? ended : nowMs;
  };
  // A long outage must not grow the snapshot without bound: a closeout older
  // than a day (for example after a long polling outage) still gets this
  // poll's delivery attempt, and is given up on only if it stays undelivered.
  const expired = (job: PendingOffline) => nowMs - endedMs(job) > OFFLINE_JOB_MAX_AGE_MS;
  const isConfigured = (id: string) => channelIds.includes(id);
  // Destinations in a channel removed from DISCORD_CHANNEL_IDS are never
  // written to, but are kept untouched with their job until it expires (like
  // roster pages), so configuring the channel again still closes the card.
  const parked = new Map<PendingOffline, ParkedDestinations>();
  const split = (
    job: PendingOffline, attemptsByChannel: Record<string, number> = {}, legacyAttempts = 0,
  ): PendingOffline => {
    // Card content and post times are never needed to close a card.
    const refs = job.messages.map(({ channelId, messageId }) => ({ channelId, messageId }));
    const recover = Object.entries(job.recoverPosts ?? {});
    const active = {
      messages: refs.filter((ref) => isConfigured(ref.channelId)),
      channelIds: job.channelIds.filter(isConfigured),
      recoverPosts: Object.fromEntries(recover.filter(([id]) => isConfigured(id))),
    };
    const kept = {
      messages: refs.filter((ref) => !isConfigured(ref.channelId)),
      channelIds: job.channelIds.filter((id) => !isConfigured(id)),
      recoverPosts: Object.fromEntries(recover.filter(([id]) => !isConfigured(id))),
    };
    // A retry counter for a destination no longer in any list (already
    // resolved) is stale bookkeeping; a parked one keeps its count, including
    // a legacy shared counter it has not imported yet.
    const attemptsFor = (destinations: typeof active, legacy: number): Record<string, number> => {
      const ids = new Set([
        ...destinations.messages.map((ref) => ref.channelId), ...destinations.channelIds,
        ...Object.keys(destinations.recoverPosts),
      ]);
      return Object.fromEntries([...ids].flatMap((id): [string, number][] =>
        Object.hasOwn(attemptsByChannel, id) ? [[id, attemptsByChannel[id]!]] : legacy ? [[id, legacy]] : []));
    };
    const activeAttempts = attemptsFor(active, 0);
    const { attemptsByChannel: _oldAttempts, recoverPosts: _oldRecover, ...rest } = job;
    const result: PendingOffline = {
      ...rest,
      messages: active.messages,
      channelIds: active.channelIds,
      ...(Object.keys(active.recoverPosts).length ? { recoverPosts: active.recoverPosts } : {}),
      ...(Object.keys(activeAttempts).length ? { attemptsByChannel: activeAttempts } : {}),
    };
    if (hasDestinations(kept)) parked.set(result, { ...kept, attemptsByChannel: attemptsFor(kept, legacyAttempts) });
    return result;
  };
  const jobs: PendingOffline[] = structuredClone(previousJobs)
    .map((job) => split(job, job.attemptsByChannel, job.attempts))
    .filter((job) => hasDestinations(job) || parked.has(job));
  for (const offline of [...wentOffline, ...excludedClosures]) {
    // Both fields only track retry state for the still-open ONLINE card and
    // are meaningless once a session has ended; strip them so a closed-out
    // session doesn't carry stale online-card bookkeeping.
    const {
      messages = [], pendingChannelIds: pendingIds, onlineAttemptsByChannel: _onlineAttempts,
      uncertainPosts = {}, ...event
    } = offline;
    // A session with no card and no pending marker is legacy: announce the
    // end everywhere. Channels whose first card may exist unseen recover it.
    // A channel whose card is tracked only needs stray copies closed; the
    // flag survives retries, after which that card may no longer be listed.
    const recoverPosts = Object.fromEntries(Object.entries(uncertainPosts)
      .map(([id, window]): [string, PostWindow] => messages.some((ref) => ref.channelId === id)
        ? [id, { ...window, closeOnly: true }] : [id, window]));
    const job = split({
      event,
      // Only configured channels are written to (others are parked above);
      // the fallback decision still sees every card the session had.
      messages,
      channelIds: messages.length || pendingIds ? [] : [...channelIds],
      recoverPosts,
    });
    if (hasDestinations(job) || parked.has(job)) jobs.push(job);
  }
  let pendingOffline: PendingOffline[] = [];
  let expiredDropped = 0;
  const liveIds = new Set(Object.values(next).flatMap((session) => (session.messages ?? []).map((ref) => ref.messageId)));
  const trackedIds = new Set([...liveIds, ...jobs.flatMap((job) => job.messages.map((ref) => ref.messageId))]);
  for (const job of jobs) {
    // An expired job is given up only once each remaining destination got a
    // real request this poll; one deferred without a request (a cooldown
    // started earlier this poll, say) is kept, still bounded by MAX_OFFLINE_JOBS.
    let deferred = false;
    if (hasDestinations(job)) {
      attempted += job.messages.length + job.channelIds.length + Object.keys(job.recoverPosts ?? {}).length;
      const result = await announceOffline(env, job, labels, limits, trackedIds, liveIds, channelIds);
      delivered += result.delivered;
      deliveryFailed ||= result.failed;
      deferred = result.deferred;
    }
    const kept = parked.get(job);
    if (kept) {
      job.messages.push(...kept.messages);
      job.channelIds.push(...kept.channelIds);
      if (Object.keys(kept.recoverPosts).length) job.recoverPosts = { ...job.recoverPosts, ...kept.recoverPosts };
      if (Object.keys(kept.attemptsByChannel).length) {
        job.attemptsByChannel = { ...job.attemptsByChannel, ...kept.attemptsByChannel };
      }
    }
    if (!hasDestinations(job)) continue;
    if (expired(job) && !deferred) expiredDropped++;
    else pendingOffline.push(job);
  }
  if (expiredDropped) {
    console.error(JSON.stringify({ event: 'offline_jobs_dropped', reason: 'expired', count: expiredDropped }));
  }
  if (pendingOffline.length > MAX_OFFLINE_JOBS) {
    const dropped = new Set([...pendingOffline].sort((x, y) => endedMs(x) - endedMs(y))
      .slice(0, pendingOffline.length - MAX_OFFLINE_JOBS));
    pendingOffline = pendingOffline.filter((job) => !dropped.has(job));
    console.error(JSON.stringify({ event: 'offline_jobs_dropped', reason: 'limit', count: dropped.size }));
  }

  const mentionCooldownMs = parseMentionCooldownMs(env.MENTION_COOLDOWN_MINUTES);
  // Keep only configured channels still within their cooldown. A ping time
  // in the future (clock skew or corrupt storage) is not trusted.
  const rolePings = Object.fromEntries(Object.entries(previousRolePings).filter(([id, at]) =>
    channelIds.includes(id) && typeof at === 'number' && at <= nowMs && nowMs - at < mentionCooldownMs));
  const ctx: PollContext = {
    env, labels, limits, nowIso, channelIds, rolePings, mentionCooldownMs,
    mentionRoleId: parseMentionRole(env.MENTION_ROLE_ID),
    // The public marker reveals private approval records: shown only while
    // reminders themselves are enabled, with a valid policy and valid
    // guild/member-role IDs (the same checks that gate sending them).
    highlightPolicy: gcaRemindersEnabled(env) ? gcaPolicy : null,
  };
  for (const atc of newlyOnline) next[atc.callsign]!.pendingChannelIds = channelIds;
  const announcements = Object.values(next)
    .filter((entry) => !entry.pending && entry.missed === 0 && entry.pendingChannelIds)
    .map((entry) => ({ entry, targets: entry.pendingChannelIds!.filter((id) => channelIds.includes(id) &&
      !entry.messages?.some((ref) => ref.channelId === id)) }));
  // Cards posted this poll share the newest postedAt, and newestCardedSession
  // breaks that tie in favour of the later entry: the last poster per channel
  // is expected to hold the roster.
  const lastPoster = new Map<string, TrackedAtc>();
  for (const { entry, targets } of announcements) for (const id of targets) lastPoster.set(id, entry);
  for (const { entry, targets } of announcements) {
    attempted += targets.length;
    const holderChannels = new Set(targets.filter((id) => lastPoster.get(id) === entry));
    // No destination left needing a first card: skip building/posting
    // embeds and just run the bookkeeping below.
    const { posted, failed, unconfirmed } = targets.length
      ? await announceOnline(ctx, entry, targets, mentionedChannels, coverage, holderChannels,
        // A session first seen before this poll may have used its nonce in an
        // earlier attempt, even one whose state was never saved.
        entry.since !== nowIso)
      : { posted: [] as PostedMessage[], failed: new Map<string, unknown>(), unconfirmed: new Set<string>() };
    delivered += posted.length + unconfirmed.size;
    if (failed.size) deliveryFailed = true;
    if (posted.length) {
      entry.messages = [...(entry.messages ?? []), ...posted];
      entry.cardAt ??= nowIso;
    }
    // A destination that keeps failing to receive the first card is dropped
    // after the same retry budget as an offline closeout's fallback post
    // (which likewise has no message to discover "gone"). Only a definite
    // Discord-side rejection (4xx, excluding the 429 rate-limit deferral)
    // counts towards that budget; a 5xx outage, a timeout/network error, or
    // a rate-limit deferral is transient and retried indefinitely instead.
    // Rebuilt from `targets` only (not copied wholesale) so a destination
    // that fell out of `targets` (channel removed, or its card finally
    // landed) never leaves a stale counter behind.
    const previousAttempts = entry.onlineAttemptsByChannel ?? {};
    const attempts: Record<string, number> = {};
    const kept: string[] = [];
    const uncertain: Record<string, PostWindow> = { ...entry.uncertainPosts };
    const markUncertain = (id: string) => {
      const now = Date.now();
      uncertain[id] = { from: uncertain[id]?.from ?? now, to: now };
    };
    for (const id of targets) {
      // A card that finally posted keeps any uncertain window: an earlier
      // copy outside Discord's nonce window is still found and closed at the end.
      if (posted.some((ref) => ref.channelId === id)) continue;
      // A 2xx-but-unconfirmed destination is dropped outright, same as
      // one that just exhausted its budget below — never retried, and never
      // given a counter; its card exists, so it is closed out at the end.
      if (unconfirmed.has(id)) { markUncertain(id); continue; }
      const err = failed.get(id);
      // A 5xx or thrown fetch error may hide a card Discord did create.
      if (mayHavePosted(err)) markUncertain(id);
      const { used, keep } = nextBudget(previousAttempts[id] ?? 0, err);
      if (keep) {
        attempts[id] = used;
        kept.push(id);
      } else {
        console.error(JSON.stringify({
          event: 'online_post_abandoned', callsign: entry.callsign, channelIndex: channelIndex(channelIds, id),
        }));
      }
    }
    if (Object.keys(attempts).length) entry.onlineAttemptsByChannel = attempts;
    else delete entry.onlineAttemptsByChannel;
    // A window in a channel removed from DISCORD_CHANNEL_IDS is kept: at close
    // it is parked with the closeout, so configuring the channel again still
    // finds and closes a card that landed unseen there.
    if (Object.keys(uncertain).length) entry.uncertainPosts = uncertain;
    else delete entry.uncertainPosts;
    entry.pendingChannelIds = kept;
    if (entry.pendingChannelIds.length) deliveryFailed = true;
    else if (entry.messages?.length) delete entry.pendingChannelIds;
    // Keep an empty pending marker if no card was ever sent, so disconnect
    // cannot manufacture an offline notice after destinations are removed.
  }

  const cards = await syncOnlineCards(ctx, next, current);
  // Pages and markers in a channel removed from DISCORD_CHANNEL_IDS are kept
  // untouched (never edited, deleted or swept) in case it is configured again.
  const configured = (ref: { channelId: string }) => channelIds.includes(ref.channelId);
  const roster = await syncRosterMessages(
    env.DISCORD_BOT_TOKEN, previousRosterMessages.filter(configured), cards.targets, limits,
    previousRosterPostAttempts.filter(configured), channelIds,
  );
  const rosterMessages = [...roster.messages, ...previousRosterMessages.filter((ref) => !configured(ref))];
  const rosterPostAttempts = [
    ...roster.postAttempts, ...previousRosterPostAttempts.filter((entry) => !configured(entry)),
  ];
  const rosterFailed = cards.failed || roster.failed;

  if (attempted > 0) {
    console.log(
      JSON.stringify({
        event: 'notified',
        channels: channelIds.length,
        delivered,
        attempted,
        online: newlyOnline.map((a) => a.callsign),
        offline: wentOffline.map((a) => a.callsign),
      }),
    );
  }

  // The coordinator atomically saves state and the poll timestamp before
  // surfacing delivery failure, preserving retries and the grace cadence.
  return {
    state: next,
    rosterMessages,
    rosterPostAttempts,
    pendingOffline,
    rolePings,
    ...(deliveryFailed && delivered > 0 ? { error: 'some Discord notifications failed' } :
      attempted > 0 && delivered === 0 ? { error: 'all Discord notifications failed' } :
      rosterFailed ? { error: 'some Discord roster updates failed' } : {}),
  };
}
