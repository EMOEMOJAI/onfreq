import { parseFirLabels, type FirLabel } from './config';
import {
  buildOfflineEmbed,
  buildOnlineEmbed,
  buildOnlineEmbeds,
  buildSessionEndedEmbed,
  DiscordApiError,
  editMessage,
  formatRoster,
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
import { enrichMemberCountries } from './member-country';
import { sendGcaReminders } from './gca';
import { syncRosterMessages, type RosterTarget } from './roster';
import { DiscordRateLimitError, DiscordRateLimits } from './discord-rate-limit';
import type { PendingOffline, OnlineAtc, PostedMessage, RosterMessage, StateMap, TrackedAtc } from './types';

function parseGracePolls(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(Math.max(n, 1), 10);
}

/** Extra polls an undeliverable offline update is retried for before it is dropped. */
const OFFLINE_RETRY_POLLS = 10;

function logFailure(event: string, callsign: string, channelId: string, err: unknown): void {
  console.error(JSON.stringify({ event, callsign, channelId, error: String(err) }));
}

/**
 * Post one "is now ONLINE" message per channel and return the message IDs,
 * so the session can be closed out by editing those exact messages later.
 * An empty result means every channel failed.
 */
async function announceOnline(
  env: Env,
  atc: TrackedAtc,
  channelIds: string[],
  mentionedChannels: Set<string>,
  current: OnlineAtc[],
  labels: FirLabel[],
  limits: DiscordRateLimits,
  nowIso: string,
): Promise<PostedMessage[]> {
  const embed = buildOnlineEmbed(atc, current, labels);
  const posted: PostedMessage[] = [];
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
    }
  }
  return posted;
}

/** Reconcile displayed cards, retrying only messages whose last edit failed. */
async function syncOnlineCards(
  env: Env, next: StateMap, current: OnlineAtc[], gracePolls: number, labels: FirLabel[],
  limits: DiscordRateLimits,
): Promise<{ targets: RosterTarget[]; failed: boolean }> {
  const coverage = current.map((atc) => next[atc.callsign] ?? atc);
  let targets: RosterTarget[];
  let failed = false;
  let removedMessage: boolean;
  do {
    targets = [];
    removedMessage = false;
    const channels = new Set(Object.values(next).flatMap((session) =>
      (session.messages ?? []).map((ref) => ref.channelId)));
    const holders = new Map([...channels].map((channel) => [channel, newestCardedSession(next, channel)]));
    for (const [callsign, session] of Object.entries(next)) {
      // An ended session retained solely for offline retries must never turn green again.
      if (session.pending || session.missed >= gracePolls) continue;
      let hostsRoster = false;
      for (const ref of [...(session.messages ?? [])]) {
        const isHolder = callsign === holders.get(ref.channelId);
        const others = isHolder ? coverage.filter((atc) => atc.callsign !== callsign) : [];
        const [embed, ...continuations] = buildOnlineEmbeds(session, others, coverage, labels);
        const rendered = JSON.stringify(embed);
        let updated = ref.onlineEmbed === rendered;
        if (!updated) {
          try {
            await editMessage(env.DISCORD_BOT_TOKEN, ref.channelId, ref.messageId, embed, limits);
            ref.onlineEmbed = rendered;
            updated = true;
          } catch (err) {
            logFailure('roster_edit_failed', callsign, ref.channelId, err);
            if (err instanceof DiscordApiError && err.status === 404) {
              session.messages = session.messages?.filter((message) => message !== ref);
              removedMessage = true;
              continue;
            }
            failed = true;
          }
        }
        if (isHolder && formatRoster(others, labels)) hostsRoster = true;
        if (isHolder || !updated) {
          targets.push({ channelId: ref.channelId, parentMessageId: ref.messageId,
            ...(updated ? { embeds: continuations } : {}) });
        }
      }
      if (hostsRoster) session.roster = true;
      else delete session.roster;
    }
    // A deleted host cannot carry coverage. Reconcile again to choose a
    // surviving card. Every extra pass removes a reference, so this terminates.
  } while (removedMessage);
  return { targets, failed };
}

/** Close only unresolved destinations; successful deliveries are never repeated. */
async function announceOffline(env: Env, job: PendingOffline, labels: FirLabel[], limits: DiscordRateLimits): Promise<number> {
  const endedEmbed = buildSessionEndedEmbed(job.event, labels);
  const fallbackEmbed = buildOfflineEmbed(job.event, labels);
  const remaining: PostedMessage[] = [];
  let delivered = 0;
  let deliveryFailure = false;
  for (const ref of job.messages) {
    try {
      await editMessage(env.DISCORD_BOT_TOKEN, ref.channelId, ref.messageId, endedEmbed, limits);
      delivered++;
      continue;
    } catch (err) {
      logFailure('offline_edit_failed', job.event.callsign, ref.channelId, err);
      if (!(err instanceof DiscordApiError && err.isGone)) {
        if (!(err instanceof DiscordRateLimitError)) deliveryFailure = true;
        remaining.push(ref);
        continue;
      }
    }
    try {
      await postMessage(env.DISCORD_BOT_TOKEN, ref.channelId, fallbackEmbed, undefined, undefined, limits);
      delivered++;
    } catch (err) {
      logFailure('offline_post_failed', job.event.callsign, ref.channelId, err);
      if (!(err instanceof DiscordRateLimitError)) deliveryFailure = true;
      remaining.push(ref);
    }
  }
  job.messages = remaining;
  const remainingChannels: string[] = [];
  for (const channelId of job.channelIds) {
    try {
      await postMessage(env.DISCORD_BOT_TOKEN, channelId, fallbackEmbed, undefined, undefined, limits);
      delivered++;
    } catch (err) {
      logFailure('offline_post_failed', job.event.callsign, channelId, err);
      if (!(err instanceof DiscordRateLimitError)) deliveryFailure = true;
      remainingChannels.push(channelId);
    }
  }
  job.channelIds = remainingChannels;
  // Waiting for Discord's cooldown must never exhaust the closeout retry budget.
  if (deliveryFailure) job.attempts++;
  return delivered;
}

export interface PollOutcome {
  state: StateMap;
  rosterMessages: RosterMessage[];
  pendingOffline: PendingOffline[];
  error?: string;
}

/** Called only by the coordinator; all network and notification work is one poll. */
export async function runPoll(
  env: Env, stored: StateMap | null, nowIso: string, storage?: DurableObjectStorage,
  previousRosterMessages: RosterMessage[] = [],
  previousPendingOffline: PendingOffline[] = [],
): Promise<PollOutcome> {
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
  for (const callsign of Object.keys(prev)) {
    if (isExcludedCallsign(callsign, excluded)) {
      delete prev[callsign];
    }
  }

  await enrichMemberCountries(current, prev, auth);

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
    return { state: next, rosterMessages: previousRosterMessages, pendingOffline: previousPendingOffline };
  }

  let attempted = 0;
  let delivered = 0;
  let deliveryFailed = false;
  const coverage = current.map((atc) => next[atc.callsign] ?? atc);
  const mentionedChannels = new Set<string>();
  for (const atc of wentOnline) next[atc.callsign]!.pendingChannelIds = channelIds;
  for (const entry of Object.values(next)) {
    if (entry.pending || entry.missed > 0 || !entry.pendingChannelIds) continue;
    const targets = entry.pendingChannelIds.filter((id) => channelIds.includes(id) &&
      !entry.messages?.some((ref) => ref.channelId === id));
    attempted += targets.length;
    const posted = await announceOnline(env, entry, targets, mentionedChannels, coverage, labels, limits, nowIso);
    delivered += posted.length;
    if (posted.length) {
      entry.messages = [...(entry.messages ?? []), ...posted];
      entry.cardAt ??= nowIso;
    }
    entry.pendingChannelIds = targets.filter((id) => !posted.some((ref) => ref.channelId === id));
    if (entry.pendingChannelIds.length) deliveryFailed = true;
    else if (entry.messages?.length) delete entry.pendingChannelIds;
    // Keep an empty pending marker if no card was ever sent, so disconnect
    // cannot manufacture an offline notice after destinations are removed.
  }

  const jobs: PendingOffline[] = structuredClone(previousPendingOffline);
  for (const offline of wentOffline) {
    const { messages = [], pendingChannelIds: _pending, ...event } = offline;
    jobs.push({ event, messages, channelIds: messages.length ? [] : [...channelIds], attempts: 0 });
  }
  const pendingOffline: PendingOffline[] = [];
  for (const job of jobs) {
    attempted += job.messages.length + job.channelIds.length;
    delivered += await announceOffline(env, job, labels, limits);
    if (job.messages.length || job.channelIds.length) {
      deliveryFailed = true;
      if (job.attempts <= OFFLINE_RETRY_POLLS) pendingOffline.push(job);
      else console.error(JSON.stringify({ event: 'offline_abandoned', callsign: job.event.callsign }));
    }
  }

  const cards = await syncOnlineCards(env, next, current, gracePolls, labels, limits);
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
