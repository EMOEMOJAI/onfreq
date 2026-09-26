import { parseFirLabels, type FirLabel } from './config';
import {
  buildOfflineEmbed,
  buildOnlineEmbed,
  buildOnlineEmbeds,
  buildSessionEndedEmbed,
  DiscordApiError,
  DiscordUnconfirmedPostError,
  editMessage,
  messageNonce,
  parseChannelIds,
  postMessage,
} from './discord';
import {
  fetchDivisionAtc,
  isExcludedCallsign,
  ivaoAuthFromEnv,
  parseExcludedCallsigns,
  parsePrefixes,
} from './ivao';
import { diffState, newestCardedSession, stripLegacyRoster } from './state';
import { countryCode, enrichMemberCountries } from './member-country';
import { gcaMismatch, parseGcaPolicy, sendGcaReminders, type GcaPolicy } from './gca';
import { syncRosterMessages, type RosterTarget } from './roster';
import { DiscordRateLimits } from './discord-rate-limit';
import { countsAgainstBudget } from './types';
import type {
  OfflineEvent, PendingOffline, OnlineAtc, PostedMessage, RosterMessage, RosterPostAttempt, StateMap, TrackedAtc,
} from './types';

function parseGracePolls(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(Math.max(n, 1), 10);
}

/** Extra polls an undeliverable offline update is retried for before it is dropped. */
const OFFLINE_RETRY_POLLS = 10;

function highlightMismatch(atc: OnlineAtc, policy: GcaPolicy | null): boolean {
  if (!policy) return false;
  const onlineCountry = countryCode(atc.airport?.countryId);
  const memberCountry = countryCode(atc.memberCountry?.countryId);
  return Boolean(onlineCountry && memberCountry && onlineCountry !== memberCountry && gcaMismatch(atc, policy));
}

function logFailure(event: string, callsign: string, channelId: string, err: unknown): void {
  console.error(JSON.stringify({ event, callsign, channelId, error: String(err) }));
}

/** Values constant across every card posted/edited within one poll. */
interface PollContext {
  env: Env;
  labels: FirLabel[];
  gcaPolicy: GcaPolicy | null;
  limits: DiscordRateLimits;
  nowIso: string;
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
  const { env, labels, gcaPolicy, limits, nowIso } = ctx;
  const mismatch = highlightMismatch(atc, gcaPolicy);
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
    // connected at once.
    const content =
      env.MENTION_ROLE_ID && !mentionedChannels.has(channelId)
        ? `<@&${env.MENTION_ROLE_ID}>`
        : undefined;
    const embed = holderChannels.has(channelId) ? holder : plain;
    try {
      // A POST whose 5xx hid a success is re-sent next poll; a nonce keyed to
      // this tracked session (callsign and `since`, not the IVAO-issued
      // `sessionId`, which changes across a grace-window resume) lets Discord
      // return the original message instead of a duplicate card.
      const messageId = await postMessage(env.DISCORD_BOT_TOKEN, channelId, embed, content, undefined, limits,
        messageNonce(`online:${atc.userId}:${atc.callsign}:${atc.since}`, channelId));
      // On a retry the nonce may have returned the earlier, possibly older
      // message: leave its content unknown so the next reconcile edits it.
      posted.push({ channelId, messageId, postedAt: nowIso, ...(retry ? {} : { onlineEmbed: JSON.stringify(embed) }) });
      if (content) mentionedChannels.add(channelId);
    } catch (err) {
      // A 2xx without a usable message id: retrying would either accept a
      // literal duplicate or spin forever with nothing to dedupe against on
      // our side, so this destination is
      // abandoned outright instead of joining the bounded 4xx retry budget
      // below. `entry.messages` stays empty for this channel either way, so
      // the existing "no card ever sent" invariant still suppresses a
      // spurious fallback OFFLINE if the session ends before a retry would
      // have succeeded — matching a destination that never had a card.
      if (err instanceof DiscordUnconfirmedPostError) {
        console.error(JSON.stringify({ event: 'online_post_unconfirmed', callsign: atc.callsign, channelId }));
        unconfirmed.add(channelId);
        continue;
      }
      logFailure('online_post_failed', atc.callsign, channelId, err);
      failed.set(channelId, err);
    }
  }
  return { posted, failed, unconfirmed };
}

/** Reconcile displayed cards, retrying only messages whose last edit failed. */
async function syncOnlineCards(
  ctx: PollContext, next: StateMap, current: OnlineAtc[],
): Promise<{ targets: RosterTarget[]; failed: boolean }> {
  const { env, labels, gcaPolicy, limits } = ctx;
  const coverage = current.map((atc) => next[atc.callsign] ?? atc);
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
        const isHolder = callsign === holders.get(ref.channelId);
        const others = isHolder ? coverage.filter((atc) => atc.callsign !== callsign) : [];
        const [embed, ...continuations] = buildOnlineEmbeds(
          session, others, coverage, labels, highlightMismatch(session, gcaPolicy),
        );
        const rendered = JSON.stringify(embed);
        let updated = ref.onlineEmbed === rendered;
        if (!updated && !failedRefs.has(ref)) {
          try {
            await editMessage(env.DISCORD_BOT_TOKEN, ref.channelId, ref.messageId, embed, limits);
            ref.onlineEmbed = rendered;
            updated = true;
          } catch (err) {
            logFailure('roster_edit_failed', callsign, ref.channelId, err);
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
  env: Env, job: PendingOffline, labels: FirLabel[], limits: DiscordRateLimits,
): Promise<{ delivered: number; failed: boolean }> {
  const endedEmbed = buildSessionEndedEmbed(job.event, labels);
  const fallbackEmbed = buildOfflineEmbed(job.event, labels);
  const remaining: PostedMessage[] = [];
  let delivered = 0;
  let failed = false;
  const attempts = job.attemptsByChannel ??= {};
  // Only a definite Discord-side rejection (4xx, excluding the 429
  // rate-limit deferral) counts towards this budget, via the same predicate
  // the online first-card and roster page budgets use; a 5xx outage or a
  // timeout/network error is transient and retried indefinitely instead, so
  // a prolonged outage cannot abandon a closeout and leave a stale green card.
  const keepForRetry = (channelId: string, err: unknown): boolean => {
    if (err instanceof DiscordUnconfirmedPostError) {
      // Discord accepted the fallback without returning its id: it was
      // delivered, and posting again could only duplicate it.
      console.error(JSON.stringify({ event: 'offline_post_unconfirmed', callsign: job.event.callsign, channelId }));
      delivered++;
      delete attempts[channelId];
      return false;
    }
    failed = true;
    const counts = countsAgainstBudget(err);
    const used = (attempts[channelId] ?? job.attempts ?? 0) + (counts ? 1 : 0);
    if (!counts || used <= OFFLINE_RETRY_POLLS) {
      attempts[channelId] = used;
      return true;
    }
    delete attempts[channelId];
    console.error(JSON.stringify({ event: 'offline_abandoned', callsign: job.event.callsign, channelId }));
    return false;
  };
  // Keyed on the tracked session (callsign and stable `since`), not the
  // IVAO-issued `sessionId`, so a genuinely new session never collides with
  // this one's nonce.
  const offlineKey = `offline:${job.event.userId}:${job.event.callsign}:${job.event.since}`;
  for (const ref of job.messages) {
    try {
      await editMessage(env.DISCORD_BOT_TOKEN, ref.channelId, ref.messageId, endedEmbed, limits);
      delivered++;
      delete attempts[ref.channelId];
      continue;
    } catch (err) {
      logFailure('offline_edit_failed', job.event.callsign, ref.channelId, err);
      if (!(err instanceof DiscordApiError && err.isGone)) {
        if (keepForRetry(ref.channelId, err)) remaining.push(ref);
        continue;
      }
    }
    try {
      await postMessage(env.DISCORD_BOT_TOKEN, ref.channelId, fallbackEmbed, undefined, undefined, limits,
        messageNonce(offlineKey, ref.channelId));
      delivered++;
      delete attempts[ref.channelId];
    } catch (err) {
      if (!(err instanceof DiscordUnconfirmedPostError)) logFailure('offline_post_failed', job.event.callsign, ref.channelId, err);
      if (keepForRetry(ref.channelId, err)) remaining.push(ref);
    }
  }
  job.messages = remaining;
  const remainingChannels: string[] = [];
  for (const channelId of job.channelIds) {
    try {
      await postMessage(env.DISCORD_BOT_TOKEN, channelId, fallbackEmbed, undefined, undefined, limits,
        messageNonce(offlineKey, channelId));
      delivered++;
      delete attempts[channelId];
    } catch (err) {
      if (!(err instanceof DiscordUnconfirmedPostError)) logFailure('offline_post_failed', job.event.callsign, channelId, err);
      if (keepForRetry(channelId, err)) remainingChannels.push(channelId);
    }
  }
  job.channelIds = remainingChannels;
  // Keep a numeric legacy field so an older Worker can still retry on rollback.
  job.attempts = 0;
  return { delivered, failed };
}

export interface PollOutcome {
  state: StateMap;
  rosterMessages: RosterMessage[];
  /** Budget for continuation pages that have never once posted successfully. */
  rosterPostAttempts: RosterPostAttempt[];
  pendingOffline: PendingOffline[];
  error?: string;
}

export interface RunPollOptions {
  storage?: DurableObjectStorage;
  previousRosterMessages?: RosterMessage[];
  previousRosterPostAttempts?: RosterPostAttempt[];
  previousPendingOffline?: PendingOffline[];
}

/** Called only by the coordinator; all network and notification work is one poll. */
export async function runPoll(
  env: Env, stored: StateMap | null, nowIso: string, options: RunPollOptions = {},
): Promise<PollOutcome> {
  const {
    storage, previousRosterMessages = [], previousRosterPostAttempts = [], previousPendingOffline = [],
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
  const prev: StateMap = { ...(stored ?? {}) };
  // A callsign carded before it was excluded must have its card closed out,
  // not silently abandoned: it disappears from `prev`/`next` below (so
  // `diffState` cannot see it went offline), so queue an edit-only closeout
  // here for any excluded session that had a live card.
  const excludedClosures: OfflineEvent[] = [];
  for (const callsign of Object.keys(prev)) {
    if (isExcludedCallsign(callsign, excluded)) {
      // Strip a legacy `roster` field here too — this session comes
      // straight from storage, not through `diffState`'s own stripping.
      const tracked = stripLegacyRoster(prev[callsign]!);
      if (!tracked.pending && tracked.messages?.length) {
        // A session already missing (grace window) keeps the poll it went
        // missing as its end time, matching `diffState`'s `close()`, instead
        // of stretching the duration to this poll.
        const endedAt = tracked.missingSince ?? nowIso;
        const durationSeconds = Math.max(0, Math.round(
          (Date.parse(endedAt) - Date.parse(tracked.since)) / 1000,
        ));
        excludedClosures.push({ ...tracked, missed: 0, missingSince: endedAt, endedAt, durationSeconds });
      }
      delete prev[callsign];
    }
  }

  await enrichMemberCountries(current, prev, auth);
  const gcaPolicy = parseGcaPolicy(env);

  if (storage) {
    try {
      await sendGcaReminders(env, current, storage, Date.parse(nowIso), gcaPolicy, labels, limits);
    } catch {
      // DM lookup/storage failures must not break the public ATC cards.
      console.error(JSON.stringify({ event: 'gca_poll_failed' }));
    }
  }

  const { next, wentOnline, wentOffline, pending } = diffState(
    prev,
    current,
    nowIso,
    gracePolls,
  );

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
      pendingOffline: previousPendingOffline,
    };
  }

  let attempted = 0;
  let delivered = 0;
  let deliveryFailed = false;
  const coverage = current.map((atc) => next[atc.callsign] ?? atc);
  const mentionedChannels = new Set<string>();

  // Close out sessions that ended before announcing any that just started,
  // so a callsign that goes offline and a replacement taking it over the
  // same poll are never shown online before their predecessor's closeout.
  // A retried job created while a channel was still configured must not keep
  // targeting it after that channel is removed from DISCORD_CHANNEL_IDS.
  const jobs: PendingOffline[] = structuredClone(previousPendingOffline)
    .map((job) => {
      const messages = job.messages.filter((ref) => channelIds.includes(ref.channelId));
      const jobChannelIds = job.channelIds.filter((id) => channelIds.includes(id));
      // A retry counter for a destination no longer in either list (removed
      // channel, or already resolved) is stale bookkeeping.
      const remaining = new Set([...messages.map((ref) => ref.channelId), ...jobChannelIds]);
      const prunedAttempts = job.attemptsByChannel && Object.fromEntries(
        Object.entries(job.attemptsByChannel).filter(([id]) => remaining.has(id)),
      );
      const { attemptsByChannel: _oldAttempts, ...rest } = job;
      return {
        ...rest,
        // This event was loaded from storage across a poll boundary,
        // never through `diffState`'s own stripping — strip it here too.
        event: stripLegacyRoster(rest.event),
        messages,
        channelIds: jobChannelIds,
        ...(prunedAttempts && Object.keys(prunedAttempts).length ? { attemptsByChannel: prunedAttempts } : {}),
      };
    })
    .filter((job) => job.messages.length || job.channelIds.length);
  for (const offline of [...wentOffline, ...excludedClosures]) {
    // Both fields only track retry state for the still-open ONLINE card and
    // are meaningless once a session has ended; strip them so a closed-out
    // session doesn't carry stale online-card bookkeeping.
    const { messages = [], pendingChannelIds: _pending, onlineAttemptsByChannel: _onlineAttempts, ...event } = offline;
    jobs.push({ event, messages, channelIds: messages.length ? [] : [...channelIds] });
  }
  const pendingOffline: PendingOffline[] = [];
  for (const job of jobs) {
    attempted += job.messages.length + job.channelIds.length;
    const result = await announceOffline(env, job, labels, limits);
    delivered += result.delivered;
    deliveryFailed ||= result.failed;
    if (job.messages.length || job.channelIds.length) pendingOffline.push(job);
  }

  const ctx: PollContext = { env, labels, gcaPolicy, limits, nowIso };
  for (const atc of wentOnline) next[atc.callsign]!.pendingChannelIds = channelIds;
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
        !wentOnline.some((atc) => atc.callsign === entry.callsign))
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
    for (const id of targets) {
      if (posted.some((ref) => ref.channelId === id)) continue;
      // A 2xx-but-unconfirmed destination is dropped outright, same as
      // one that just exhausted its budget below — never retried, and never
      // given a counter.
      if (unconfirmed.has(id)) continue;
      const err = failed.get(id);
      const counts = countsAgainstBudget(err);
      const used = (previousAttempts[id] ?? 0) + (counts ? 1 : 0);
      if (!counts || used <= OFFLINE_RETRY_POLLS) {
        attempts[id] = used;
        kept.push(id);
      } else {
        console.error(JSON.stringify({ event: 'online_post_abandoned', callsign: entry.callsign, channelId: id }));
      }
    }
    if (Object.keys(attempts).length) entry.onlineAttemptsByChannel = attempts;
    else delete entry.onlineAttemptsByChannel;
    entry.pendingChannelIds = kept;
    if (entry.pendingChannelIds.length) deliveryFailed = true;
    else if (entry.messages?.length) delete entry.pendingChannelIds;
    // Keep an empty pending marker if no card was ever sent, so disconnect
    // cannot manufacture an offline notice after destinations are removed.
  }

  const cards = await syncOnlineCards(ctx, next, current);
  const roster = await syncRosterMessages(
    env.DISCORD_BOT_TOKEN, previousRosterMessages, cards.targets, limits, previousRosterPostAttempts,
  );
  const rosterMessages = roster.messages;
  const rosterPostAttempts = roster.postAttempts;
  const rosterFailed = cards.failed || roster.failed;

  if (attempted > 0) {
    console.log(
      JSON.stringify({
        event: 'notified',
        channels: channelIds.length,
        delivered,
        attempted,
        online: wentOnline.map((a) => a.callsign),
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
    ...(deliveryFailed && delivered > 0 ? { error: 'some Discord notifications failed' } :
      attempted > 0 && delivered === 0 ? { error: 'all Discord notifications failed' } :
      rosterFailed ? { error: 'some Discord roster updates failed' } : {}),
  };
}
