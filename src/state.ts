import { hasFrequency } from './ivao';
import type {
  DiffResult, OfflineEvent, OnlineAtc, PendingOffline, PostedMessage, PostWindow, RosterMessage, RosterPostAttempt,
  StateMap, TrackedAtc,
} from './types';

type Guard<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString: Guard<string> = (value): value is string => typeof value === 'string';
const isNumber: Guard<number> = (value): value is number => typeof value === 'number';
/** Whole numbers: a fractional or NaN epoch-ms window would make building a snowflake from it throw. */
const isSafeInteger: Guard<number> = (value): value is number => Number.isSafeInteger(value);
const arrayOf = <T>(guard: Guard<T>): Guard<T[]> => (value): value is T[] => Array.isArray(value) && value.every(guard);
const recordOf = <T>(guard: Guard<T>): Guard<Record<string, T>> => (value): value is Record<string, T> =>
  isRecord(value) && Object.values(value).every(guard);
const optional = <T>(guard: Guard<T>): Guard<T | undefined> => (value): value is T | undefined =>
  value === undefined || guard(value);

const isPostedMessage: Guard<PostedMessage> = (value): value is PostedMessage =>
  isRecord(value) && isString(value.channelId) && isString(value.messageId);
const isPostWindow: Guard<PostWindow> = (value): value is PostWindow =>
  isRecord(value) && isSafeInteger(value.from) && isSafeInteger(value.to);
const isRosterMessage: Guard<RosterMessage> = (value): value is RosterMessage =>
  isPostedMessage(value) && isString((value as Partial<RosterMessage>).parentMessageId) &&
  isSafeInteger((value as Partial<RosterMessage>).page);
const isRosterPostAttempt: Guard<RosterPostAttempt> = (value): value is RosterPostAttempt =>
  isRecord(value) && isString(value.channelId) && isString(value.parentMessageId) && isSafeInteger(value.page) &&
  optional(isSafeInteger)(value.maybePostedFrom) && optional(isSafeInteger)(value.maybePostedTo);

/** Whether a stored session has every field a poll reads, in the shape it reads it. */
function isTrackedAtc(value: unknown): value is TrackedAtc {
  return isRecord(value) && isString(value.callsign) && isString(value.position) && isNumber(value.frequency) &&
    isNumber(value.userId) && isString(value.since) && isNumber(value.missed) &&
    (value.station == null || isString(value.station)) && (value.location == null || isString(value.location)) &&
    optional(arrayOf(isPostedMessage))(value.messages) && optional(arrayOf(isString))(value.pendingChannelIds) &&
    optional(recordOf(isPostWindow))(value.uncertainPosts);
}

function isPendingOffline(value: unknown): value is PendingOffline {
  if (!isRecord(value)) return false;
  const event = value.event;
  return isTrackedAtc(event) && isString((event as Partial<OfflineEvent>).endedAt) &&
    isNumber((event as Partial<OfflineEvent>).durationSeconds) &&
    arrayOf(isPostedMessage)(value.messages) && arrayOf(isString)(value.channelIds) &&
    optional(recordOf(isPostWindow))(value.recoverPosts) && optional(isRecord)(value.attemptsByChannel);
}

/**
 * `roster` is a legacy field removed from `TrackedAtc`; strip it from any
 * session or offline event loaded from storage before an older deploy wrote
 * it, so it never survives on a resumed, still-missing, closed or excluded
 * session, or on an imported `PendingOffline` job.
 */
function stripLegacyRoster<T extends TrackedAtc>(session: T): T {
  const { roster: _legacyRoster, ...kept } = session as T & { roster?: boolean };
  return kept as T;
}

/**
 * Stored sessions and closeout jobs, normalized once where a poll loads them.
 * An entry missing a field every poll reads (a corrupt or hand-edited
 * snapshot) is dropped, logged by count only, instead of throwing on every
 * poll and halting delivery for everything else.
 */
export function loadSessions(stored: StateMap): StateMap {
  const entries = Object.entries(stored);
  const valid = entries.filter(([, session]) => isTrackedAtc(session));
  if (valid.length < entries.length) {
    console.error(JSON.stringify({ event: 'sessions_dropped', reason: 'invalid', count: entries.length - valid.length }));
  }
  return Object.fromEntries(valid.map(([callsign, session]) => [callsign, stripLegacyRoster(session)]));
}

/**
 * The entries of a stored list that pass `guard`, logging how many were
 * dropped (count only: entries hold private IDs). A stored value that is
 * not a list at all counts as one invalid entry.
 */
function loadList<T>(stored: unknown, guard: Guard<T>, event: string): T[] {
  const list: unknown[] = Array.isArray(stored) ? stored : [stored];
  const valid = list.filter(guard);
  if (valid.length < list.length) {
    console.error(JSON.stringify({ event, reason: 'invalid', count: list.length - valid.length }));
  }
  return valid;
}

/** See `loadSessions`. */
export function loadPendingOffline(stored: unknown[]): PendingOffline[] {
  return loadList(stored, isPendingOffline, 'offline_jobs_dropped')
    .map((job) => ({ ...job, event: stripLegacyRoster(job.event) }));
}

/** Stored roster continuation pages; see `loadSessions`. */
export function loadRosterMessages(stored: unknown): RosterMessage[] {
  return loadList(stored, isRosterMessage, 'roster_messages_dropped');
}

/**
 * Stored continuation post attempts; see `loadSessions`. A sweep window that
 * is not whole epoch ms is dropped with its entry: it would otherwise throw
 * while building the channel scan, failing every poll.
 */
export function loadRosterPostAttempts(stored: unknown): RosterPostAttempt[] {
  return loadList(stored, isRosterPostAttempt, 'roster_post_attempts_dropped');
}

/** Stored role ping times per channel, keeping only numeric times; see `loadSessions`. */
export function loadRolePings(stored: unknown): Record<string, number> {
  const entries = isRecord(stored) ? Object.entries(stored) : [];
  const valid = entries.filter(([, at]) => Number.isFinite(at));
  const dropped = isRecord(stored) ? entries.length - valid.length : 1;
  if (dropped > 0) console.error(JSON.stringify({ event: 'role_pings_dropped', reason: 'invalid', count: dropped }));
  return Object.fromEntries(valid) as Record<string, number>;
}

/**
 * The closeout for a session that ended at `endedAt`, or undefined when it
 * never earned a real ONLINE card. `pendingChannelIds` set (even to an empty
 * array) alongside no successful `messages` means that — every caller that
 * persists a session without messages (a failed announcement, or silently
 * seeding first-run state) must set `pendingChannelIds` for this to hold; a
 * legacy session predating both fields has neither, and is treated as
 * already announced. A channel where a first card may have landed unseen
 * still gets closed.
 */
export function offlineEventFor(tracked: TrackedAtc, missed: number, endedAt: string): OfflineEvent | undefined {
  if (tracked.pending || (tracked.pendingChannelIds && !tracked.messages?.length &&
    !Object.keys(tracked.uncertainPosts ?? {}).length)) return undefined;
  const durationSeconds = Math.max(0, Math.round(
    (Date.parse(endedAt) - Date.parse(tracked.since)) / 1000,
  ));
  return { ...tracked, missed, missingSince: endedAt, endedAt, durationSeconds };
}

/**
 * Compare the previous tracked state with the current poll result.
 *
 * - A callsign not seen before goes into `wentOnline`.
 * - A tracked callsign missing from the feed is kept for `gracePolls - 1`
 *   polls (to ride out brief disconnects and API hiccups); once it has been
 *   missing `gracePolls` consecutive times it goes into `wentOffline`.
 * - The same VID at a callsign reappearing within the grace window resumes silently —
 *   no duplicate "online" notification, original start time preserved.
 *
 * `prev` comes from `loadSessions`.
 *
 * The session end time is the *first* poll the callsign went missing
 * (`missingSince`), not the poll the grace window expired, so the reported
 * duration doesn't silently include the grace window.
 *
 * A controller the feed reports at 0.000 MHz has connected but not tuned
 * yet. It is held back — tracked, so its start time is the moment it
 * appeared, but not announced until a real frequency shows up (`pending`).
 * A held-back session that disappears again is dropped silently: nothing was
 * announced, so there is nothing to close out.
 */
export function diffState(
  prev: StateMap,
  current: OnlineAtc[],
  nowIso: string,
  gracePolls: number,
): DiffResult {
  const next: StateMap = {};
  const wentOnline: TrackedAtc[] = [];
  const wentOffline: OfflineEvent[] = [];
  const pending: string[] = [];
  const seen = new Set<string>();
  let changed = false;

  function close(tracked: TrackedAtc, missed: number, endedAt: string): void {
    const event = offlineEventFor(tracked, missed, endedAt);
    if (event) wentOffline.push(event);
  }

  for (const atc of current) {
    seen.add(atc.callsign);
    // Own properties only: a callsign such as `valueOf` must never resolve
    // to an inherited Object.prototype member.
    const existing = Object.hasOwn(prev, atc.callsign) ? prev[atc.callsign] : undefined;
    const tuned = hasFrequency(atc);

    if (existing && existing.userId === atc.userId && existing.missed < gracePolls) {
      if (existing.missed !== 0 || existing.missingSince !== undefined) changed = true;
      // `missingSince` is dropped rather than overwritten so a resumed
      // session doesn't carry a stale end time. `messages` is preserved.
      const { missingSince: _resumed, pending: _held, ...kept } = existing;
      const entry: TrackedAtc = {
        ...kept,
        ...atc,
        // An established session that blips to 0.000 MHz keeps its last
        // known good frequency rather than inheriting the glitch.
        frequency: tuned ? atc.frequency : existing.frequency,
        since: existing.since,
        missed: 0,
      };
      if (existing.pending) {
        if (tuned) {
          // The frequency finally landed — announce it now, dated from
          // when the controller actually connected.
          wentOnline.push(entry);
          changed = true;
        } else {
          entry.pending = true;
          pending.push(atc.callsign);
        }
      }
      next[atc.callsign] = entry;
    } else {
      if (existing) close(existing, gracePolls, existing.missingSince ?? nowIso);
      const tracked: TrackedAtc = { ...atc, since: nowIso, missed: 0 };
      changed = true;
      if (tuned) {
        wentOnline.push(tracked);
      } else {
        tracked.pending = true;
        pending.push(atc.callsign);
      }
      next[atc.callsign] = tracked;
    }
  }

  for (const [callsign, tracked] of Object.entries(prev)) {
    if (seen.has(callsign)) continue;
    changed = true;
    const missed = tracked.missed + 1;
    const missingSince = tracked.missingSince ?? nowIso;
    if (missed >= gracePolls) {
      close(tracked, missed, missingSince);
    } else {
      next[callsign] = { ...tracked, missed, missingSince };
    }
  }

  return { next, wentOnline, wentOffline, pending, changed };
}

/**
 * The most recently carded session that is still online — where the "also
 * online now" roster belongs.
 *
 * Missing sessions, sessions awaiting a frequency, and sessions without a
 * card cannot host it. Ties select the later insertion (last card posted in
 * that poll). ISO timestamps compare chronologically as plain strings.
 */
export function newestCardedSession(state: StateMap, channelId?: string): string | undefined {
  let newest: string | undefined;
  let newestAt = '';
  for (const [callsign, session] of Object.entries(state)) {
    if (session.pending || session.missed > 0 || !session.messages?.length) continue;
    if (channelId !== undefined && !session.messages.some((ref) => ref.channelId === channelId)) continue;
    const at = (channelId === undefined ? undefined :
      session.messages.find((ref) => ref.channelId === channelId)?.postedAt) ?? session.cardAt ?? session.since;
    if (at >= newestAt) {
      newestAt = at;
      newest = callsign;
    }
  }
  return newest;
}
