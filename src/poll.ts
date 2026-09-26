import { parseFirLabels, type FirLabel } from './config';
import {
  buildOfflineEmbed,
  buildOnlineEmbed,
  buildOnlineEmbeds,
  buildSessionEndedEmbed,
  DiscordApiError,
  editMessage,
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
import { diffState, newestCardedSession } from './state';
import { countryCode, enrichMemberCountries } from './member-country';
import { gcaMismatch, parseGcaPolicy, sendGcaReminders, type GcaPolicy } from './gca';
import { syncRosterMessages, type RosterTarget } from './roster';
import { DiscordRateLimitError, DiscordRateLimits } from './discord-rate-limit';
import type { OfflineEvent, PendingOffline, OnlineAtc, PostedMessage, RosterMessage, StateMap, TrackedAtc } from './types';

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
): Promise<{ posted: PostedMessage[]; failed: Map<string, unknown> }> {
  const { env, labels, gcaPolicy, limits, nowIso } = ctx;
  const embed = buildOnlineEmbed(atc, current, labels, highlightMismatch(atc, gcaPolicy));
  const posted: PostedMessage[] = [];
  const failed = new Map<string, unknown>();
  for (const channelId of channelIds) {
    // At most one role ping per channel per poll, however many controllers
    // connected at once.
    const content =
      env.MENTION_ROLE_ID && !mentionedChannels.has(channelId)
        ? `<@&${env.MENTION_ROLE_ID}>`
        : undefined;
    try {
      const messageId = await postMessage(env.DISCORD_BOT_TOKEN, channelId, embed, content, undefined, limits);
      posted.push({ channelId, messageId, postedAt: nowIso, onlineEmbed: JSON.stringify(embed) });
      if (content) mentionedChannels.add(channelId);
    } catch (err) {
      logFailure('online_post_failed', atc.callsign, channelId, err);
      failed.set(channelId, err);
    }
  }
  return { posted, failed };
}

/** Reconcile displayed cards, retrying only messages whose last edit failed. */
async function syncOnlineCards(
  env: Env, next: StateMap, current: OnlineAtc[], gracePolls: number, labels: FirLabel[],
  gcaPolicy: GcaPolicy | null,
  limits: DiscordRateLimits,
): Promise<{ targets: RosterTarget[]; failed: boolean }> {
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
      // An ended session retained solely for offline retries must never turn green again.
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
  const keepForRetry = (channelId: string, err: unknown): boolean => {
    failed = true;
    const rateLimited = err instanceof DiscordRateLimitError;
    const used = (attempts[channelId] ?? job.attempts ?? 0) + (rateLimited ? 0 : 1);
    if (rateLimited || used <= OFFLINE_RETRY_POLLS) {
      attempts[channelId] = used;
      return true;
    }
    delete attempts[channelId];
    console.error(JSON.stringify({ event: 'offline_abandoned', callsign: job.event.callsign, channelId }));
    return false;
  };
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
      await postMessage(env.DISCORD_BOT_TOKEN, ref.channelId, fallbackEmbed, undefined, undefined, limits);
      delivered++;
      delete attempts[ref.channelId];
    } catch (err) {
      logFailure('offline_post_failed', job.event.callsign, ref.channelId, err);
      if (keepForRetry(ref.channelId, err)) remaining.push(ref);
    }
  }
  job.messages = remaining;
  const remainingChannels: string[] = [];
  for (const channelId of job.channelIds) {
    try {
      await postMessage(env.DISCORD_BOT_TOKEN, channelId, fallbackEmbed, undefined, undefined, limits);
      delivered++;
      delete attempts[channelId];
    } catch (err) {
      logFailure('offline_post_failed', job.event.callsign, channelId, err);
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
  pendingOffline: PendingOffline[];
  error?: string;
}

export interface RunPollOptions {
  storage?: DurableObjectStorage;
  previousRosterMessages?: RosterMessage[];
  previousPendingOffline?: PendingOffline[];
}

/** Called only by the coordinator; all network and notification work is one poll. */
export async function runPoll(
  env: Env, stored: StateMap | null, nowIso: string, options: RunPollOptions = {},
): Promise<PollOutcome> {
  const { storage, previousRosterMessages = [], previousPendingOffline = [] } = options;
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
      const tracked = prev[callsign]!;
      if (!tracked.pending && tracked.messages?.length) {
        const durationSeconds = Math.max(0, Math.round(
          (Date.parse(nowIso) - Date.parse(tracked.since)) / 1000,
        ));
        excludedClosures.push({ ...tracked, missed: 0, missingSince: nowIso, endedAt: nowIso, durationSeconds });
      }
      delete prev[callsign];
    }
  }

  await enrichMemberCountries(current, prev, auth);
  const gcaPolicy = parseGcaPolicy(env);

  if (storage) {
    try {
      await sendGcaReminders(env, current, storage, Date.parse(nowIso), limits);
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
    return { state: next, rosterMessages: previousRosterMessages, pendingOffline: previousPendingOffline };
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
    .map((job) => ({
      ...job,
      messages: job.messages.filter((ref) => channelIds.includes(ref.channelId)),
      channelIds: job.channelIds.filter((id) => channelIds.includes(id)),
    }))
    .filter((job) => job.messages.length || job.channelIds.length);
  for (const offline of [...wentOffline, ...excludedClosures]) {
    const { messages = [], pendingChannelIds: _pending, ...event } = offline;
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
  for (const entry of Object.values(next)) {
    if (entry.pending || entry.missed > 0 || !entry.pendingChannelIds) continue;
    const targets = entry.pendingChannelIds.filter((id) => channelIds.includes(id) &&
      !entry.messages?.some((ref) => ref.channelId === id));
    attempted += targets.length;
    const { posted, failed } = await announceOnline(ctx, entry, targets, mentionedChannels, coverage);
    delivered += posted.length;
    if (failed.size) deliveryFailed = true;
    if (posted.length) {
      entry.messages = [...(entry.messages ?? []), ...posted];
      entry.cardAt ??= nowIso;
    }
    // A destination that keeps failing to receive the first card is dropped
    // after the same retry budget as an offline closeout's fallback post
    // (which likewise has no message to discover "gone"): a rate-limit
    // deferral doesn't count towards it.
    const attempts = entry.onlineAttemptsByChannel ?? {};
    const kept: string[] = [];
    for (const id of targets) {
      if (posted.some((ref) => ref.channelId === id)) { delete attempts[id]; continue; }
      const rateLimited = failed.get(id) instanceof DiscordRateLimitError;
      const used = (attempts[id] ?? 0) + (rateLimited ? 0 : 1);
      if (rateLimited || used <= OFFLINE_RETRY_POLLS) {
        attempts[id] = used;
        kept.push(id);
      } else {
        delete attempts[id];
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

  const cards = await syncOnlineCards(env, next, current, gracePolls, labels, gcaPolicy, limits);
  const roster = await syncRosterMessages(env.DISCORD_BOT_TOKEN, previousRosterMessages, cards.targets, limits);
  const rosterMessages = roster.messages;
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
    pendingOffline,
    ...(deliveryFailed && delivered > 0 ? { error: 'some Discord notifications failed' } :
      attempted > 0 && delivered === 0 ? { error: 'all Discord notifications failed' } :
      rosterFailed ? { error: 'some Discord roster updates failed' } : {}),
  };
}
