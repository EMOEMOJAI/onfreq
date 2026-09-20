import { hasFrequency } from './ivao';
import type { DiffResult, OfflineEvent, OnlineAtc, StateMap, TrackedAtc } from './types';

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
    if (tracked.pending || (tracked.pendingChannelIds && !tracked.messages?.length)) return;
    const durationSeconds = Math.max(0, Math.round(
      (Date.parse(endedAt) - Date.parse(tracked.since)) / 1000,
    ));
    wentOffline.push({ ...tracked, missed, missingSince: endedAt, endedAt, durationSeconds });
  }

  for (const atc of current) {
    seen.add(atc.callsign);
    const existing = prev[atc.callsign];
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
