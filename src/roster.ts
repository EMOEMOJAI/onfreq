import {
  deleteMessage, DiscordApiError, DiscordUnconfirmedPostError, editMessage, findBotReplies, messageNonce, postMessage,
  type DiscordEmbed,
} from './discord';
import { countsAgainstBudget, type RosterMessage, type RosterPostAttempt } from './types';
import { DiscordRateLimitError, type DiscordRateLimits } from './discord-rate-limit';

export interface RosterTarget {
  channelId: string;
  parentMessageId: string;
  /** Absent while the parent edit is failing: preserve its existing continuations. */
  embeds?: DiscordEmbed[];
}

/** Extra polls an undeletable or permanently failing roster page is retried for before it is given up on. */
const DELETE_RETRY_POLLS = 10;

/** A failed POST that may still have created its message (a 5xx, a timeout, or a 2xx without an id). */
function mayHavePosted(err: unknown): boolean {
  return err instanceof DiscordUnconfirmedPostError ||
    (!(err instanceof DiscordRateLimitError) && !countsAgainstBudget(err));
}

function markMaybePosted(entry: RosterPostAttempt, previous: RosterPostAttempt | undefined, err: unknown): RosterPostAttempt {
  const window = previous?.maybePostedFrom === undefined ? {} :
    { maybePostedFrom: previous.maybePostedFrom, maybePostedTo: previous.maybePostedTo };
  if (!mayHavePosted(err)) return { ...entry, ...window };
  const now = Date.now();
  return { ...entry, maybePostedFrom: previous?.maybePostedFrom ?? now, maybePostedTo: now };
}

/**
 * Channel and message IDs are private configuration: logs identify a channel
 * only by its position in the configured list (null when not configured).
 */
export function channelIndex(channelIds: string[], channelId: string): number | null {
  const index = channelIds.indexOf(channelId);
  return index < 0 ? null : index;
}

function attemptKey(channelId: string, parentMessageId: string, page: number): string {
  return `${channelId}:${parentMessageId}:${page}`;
}

/** Reconcile separately sent pages, retaining failed edits/deletions for later polls. */
export async function syncRosterMessages(
  botToken: string, previous: RosterMessage[], targets: RosterTarget[],
  limits: DiscordRateLimits, previousPostAttempts: RosterPostAttempt[] = [], channelIds: string[] = [],
): Promise<{ messages: RosterMessage[]; postAttempts: RosterPostAttempt[]; failed: boolean }> {
  const messages: RosterMessage[] = [];
  let failed = false;
  const logIndex = (channelId: string) => channelIndex(channelIds, channelId);
  const logFailure = (operation: string, channelId: string, error: unknown) => {
    failed = true;
    console.error(JSON.stringify({ event: 'roster_continuation_failed', operation, channelIndex: logIndex(channelId), error: String(error) }));
  };
  // A page that has never once posted successfully has no RosterMessage of
  // its own to hold a retry counter on; track those separately,
  // keyed by destination + page.
  const postAttemptsByKey = new Map(
    previousPostAttempts.map((entry) => [attemptKey(entry.channelId, entry.parentMessageId, entry.page), entry]),
  );

  // Keep cleanup independent of session state: the host may have ended, been
  // excluded, or lost its main message. A failed deletion must remain tracked.
  for (const ref of previous) {
    const target = targets.find((item) => item.channelId === ref.channelId && item.parentMessageId === ref.parentMessageId);
    if (target && (target.embeds === undefined || ref.page < target.embeds.length)) {
      // The target still exists, so a stale delete-failure counter from an
      // earlier poll (before the host reappeared, say) no longer applies.
      const { deleteAttempts: _staleDeleteAttempts, ...kept } = ref;
      messages.push(kept);
      continue;
    }
    try {
      await deleteMessage(botToken, ref.channelId, ref.messageId, limits);
    } catch (err) {
      // A permanently forbidden channel (403) must not be retried every poll
      // forever: cap it the same way every other roster/offline budget is,
      // via the shared 4xx-only predicate.
      const counts = countsAgainstBudget(err);
      const used = (ref.deleteAttempts ?? 0) + (counts ? 1 : 0);
      logFailure('delete', ref.channelId, err);
      if (!counts || used <= DELETE_RETRY_POLLS) {
        messages.push({ ...ref, deleteAttempts: used });
      } else {
        console.error(JSON.stringify({ event: 'roster_delete_abandoned', channelIndex: logIndex(ref.channelId) }));
      }
    }
  }

  for (const target of targets) {
    for (const [page, embed] of (target.embeds ?? []).entries()) {
      const key = attemptKey(target.channelId, target.parentMessageId, page);
      const rendered = JSON.stringify(embed);
      let index = messages.findIndex((ref) => ref.channelId === target.channelId &&
        ref.parentMessageId === target.parentMessageId && ref.page === page);
      const ref = messages[index];
      // A page already given up on (whether it once posted or never
      // did) stays frozen — no further edit or post attempt — while this
      // parent target lives. An absent entry reads as "never posted", which
      // would otherwise re-create it as a duplicate this same poll.
      if (ref?.abandoned || postAttemptsByKey.get(key)?.abandoned) continue;
      if (ref?.onlineEmbed === rendered) continue;
      // A permanently failing edit or post (e.g. a permanently forbidden
      // channel) must not be retried every poll forever: cap it the same
      // way an undeletable continuation is, excluding rate-limit deferrals
      // and 5xx/timeouts via the shared predicate.
      const giveUp = (err: unknown): void => {
        const counts = countsAgainstBudget(err);
        if (index >= 0) {
          const used = (messages[index]!.pageAttempts ?? 0) + (counts ? 1 : 0);
          if (!counts || used <= DELETE_RETRY_POLLS) {
            messages[index] = { ...messages[index]!, pageAttempts: used };
            return;
          }
          console.error(JSON.stringify({ event: 'roster_page_abandoned', channelIndex: logIndex(target.channelId), page }));
          // Keep a frozen marker instead of splicing the entry away: an
          // absent entry reads as "never posted" and would otherwise be
          // re-created as a duplicate next poll.
          const { pageAttempts: _spent, ...rest } = messages[index]!;
          messages[index] = { ...rest, abandoned: true };
          return;
        }
        // This page has never once posted successfully: give it the
        // same budget via the sibling attempt map instead.
        const previousAttempt = postAttemptsByKey.get(key);
        const used = (previousAttempt?.attempts ?? 0) + (counts ? 1 : 0);
        const entry = markMaybePosted(
          { channelId: target.channelId, parentMessageId: target.parentMessageId, page, attempts: used, nonceKey },
          previousAttempt, err,
        );
        if (!counts || used <= DELETE_RETRY_POLLS) {
          postAttemptsByKey.set(key, entry);
          return;
        }
        console.error(JSON.stringify({ event: 'roster_page_abandoned', channelIndex: logIndex(target.channelId), page }));
        postAttemptsByKey.set(key, { ...entry, abandoned: true });
      };
      // Every fresh post gets its own nonce key, kept across its retries: a
      // re-post after a gone copy, or after the roster shrank and grew again,
      // must never reuse an earlier post's key, or Discord could hand back
      // the deleted message instead of creating a new one.
      const retryKey = postAttemptsByKey.get(key)?.nonceKey;
      const nonceKey = retryKey ?? `roster:${target.parentMessageId}:${page}:${Date.now().toString(36)}`;
      if (ref) {
        try {
          await editMessage(botToken, ref.channelId, ref.messageId, embed, limits);
          ref.onlineEmbed = rendered;
          delete ref.pageAttempts;
          continue;
        } catch (err) {
          if (!(err instanceof DiscordApiError && err.isGone)) {
            logFailure('edit', ref.channelId, err);
            giveUp(err);
            continue;
          }
          messages.splice(index, 1);
          index = -1;
        }
      }
      try {
        const nonce = messageNonce(nonceKey, target.channelId);
        const messageId = await postMessage(botToken, target.channelId, embed, undefined, target.parentMessageId, limits, nonce);
        // A retry may have been handed the earlier, possibly older copy by
        // its nonce: leave its content unknown so the next poll edits it.
        messages.push({ channelId: target.channelId, parentMessageId: target.parentMessageId,
          page, messageId, ...(retryKey ? {} : { onlineEmbed: rendered }) });
        // An earlier attempt may have left a copy outside Discord's nonce
        // window: keep only its time window, so it is swept once the parent goes.
        const previous = postAttemptsByKey.get(key);
        if (previous?.maybePostedFrom === undefined) postAttemptsByKey.delete(key);
        else {
          postAttemptsByKey.set(key, {
            channelId: target.channelId, parentMessageId: target.parentMessageId, page, attempts: 0,
            maybePostedFrom: previous.maybePostedFrom, maybePostedTo: previous.maybePostedTo,
          });
        }
      } catch (err) {
        if (err instanceof DiscordUnconfirmedPostError) {
          // Discord accepted the page but returned no id to track it by:
          // posting again could only duplicate it, so freeze this page.
          console.error(JSON.stringify({ event: 'roster_post_unconfirmed', channelIndex: logIndex(target.channelId), page }));
          postAttemptsByKey.set(key, markMaybePosted({
            channelId: target.channelId, parentMessageId: target.parentMessageId, page, attempts: 0, nonceKey, abandoned: true,
          }, postAttemptsByKey.get(key), err));
          continue;
        }
        logFailure('post', target.channelId, err);
        giveUp(err);
      }
    }
  }

  // Keep counters and markers while their parent is still shown. A page
  // beyond a shrunk roster is dropped unless it may exist unseen: that one
  // waits for its parent to go, because a sweep cannot tell which page an
  // untracked reply belongs to while the parent's other pages are live.
  const postAttempts: RosterPostAttempt[] = [];
  const orphans = new Map<string, RosterPostAttempt[]>();
  for (const entry of postAttemptsByKey.values()) {
    const target = targets.find((item) =>
      item.channelId === entry.channelId && item.parentMessageId === entry.parentMessageId);
    if (target) {
      if (target.embeds === undefined || entry.page < target.embeds.length || entry.maybePostedFrom !== undefined) {
        postAttempts.push(entry);
      }
    } else if (entry.maybePostedFrom !== undefined) {
      const group = `${entry.channelId}:${entry.parentMessageId}`;
      orphans.set(group, [...(orphans.get(group) ?? []), entry]);
    }
  }
  // Remove this bot's untracked replies to parents no longer shown. A
  // transient failure keeps the markers for the next poll; a 4xx (such as a
  // missing Read Message History permission) gives up.
  const tracked = new Set(messages.map((ref) => ref.messageId));
  for (const entries of orphans.values()) {
    const { channelId, parentMessageId } = entries[0]!;
    const window = {
      from: Math.min(...entries.map((entry) => entry.maybePostedFrom!)),
      to: Math.max(...entries.map((entry) => entry.maybePostedTo ?? entry.maybePostedFrom!)),
    };
    try {
      for (const id of await findBotReplies(botToken, channelId, parentMessageId, window, limits)) {
        if (!tracked.has(id)) await deleteMessage(botToken, channelId, id, limits);
      }
    } catch (err) {
      console.error(JSON.stringify({ event: 'roster_orphan_sweep_failed', channelIndex: logIndex(channelId), error: String(err) }));
      // Keep only the time windows: should the parent be shown again, its
      // pages post fresh rather than stay frozen with stale content.
      if (!countsAgainstBudget(err)) {
        postAttempts.push(...entries.map(({ abandoned: _abandoned, nonceKey: _nonceKey, ...rest }) => rest));
      }
    }
  }
  return { messages, postAttempts, failed };
}
