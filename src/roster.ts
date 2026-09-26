import {
  deleteMessage, DiscordApiError, DiscordUnconfirmedPostError, editMessage, messageNonce, postMessage, type DiscordEmbed,
} from './discord';
import { countsAgainstBudget, type RosterMessage, type RosterPostAttempt } from './types';
import type { DiscordRateLimits } from './discord-rate-limit';

export interface RosterTarget {
  channelId: string;
  parentMessageId: string;
  /** Absent while the parent edit is failing: preserve its existing continuations. */
  embeds?: DiscordEmbed[];
}

/** Extra polls an undeletable or permanently failing roster page is retried for before it is given up on. */
const DELETE_RETRY_POLLS = 10;

function attemptKey(channelId: string, parentMessageId: string, page: number): string {
  return `${channelId}:${parentMessageId}:${page}`;
}

/** Reconcile separately sent pages, retaining failed edits/deletions for later polls. */
export async function syncRosterMessages(
  botToken: string, previous: RosterMessage[], targets: RosterTarget[],
  limits: DiscordRateLimits, previousPostAttempts: RosterPostAttempt[] = [],
): Promise<{ messages: RosterMessage[]; postAttempts: RosterPostAttempt[]; failed: boolean }> {
  const messages: RosterMessage[] = [];
  let failed = false;
  const logFailure = (operation: string, channelId: string, parentMessageId: string, error: unknown) => {
    failed = true;
    console.error(JSON.stringify({ event: 'roster_continuation_failed', operation, channelId, parentMessageId, error: String(error) }));
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
      logFailure('delete', ref.channelId, ref.parentMessageId, err);
      if (!counts || used <= DELETE_RETRY_POLLS) {
        messages.push({ ...ref, deleteAttempts: used });
      } else {
        console.error(JSON.stringify({
          event: 'roster_delete_abandoned', channelId: ref.channelId, parentMessageId: ref.parentMessageId,
        }));
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
          console.error(JSON.stringify({
            event: 'roster_page_abandoned', channelId: target.channelId, parentMessageId: target.parentMessageId, page,
          }));
          // Keep a frozen marker instead of splicing the entry away: an
          // absent entry reads as "never posted" and would otherwise be
          // re-created as a duplicate next poll.
          const { pageAttempts: _spent, ...rest } = messages[index]!;
          messages[index] = { ...rest, abandoned: true };
          return;
        }
        // This page has never once posted successfully: give it the
        // same budget via the sibling attempt map instead.
        const used = (postAttemptsByKey.get(key)?.attempts ?? 0) + (counts ? 1 : 0);
        const entry = { channelId: target.channelId, parentMessageId: target.parentMessageId, page, attempts: used };
        if (!counts || used <= DELETE_RETRY_POLLS) {
          postAttemptsByKey.set(key, { ...entry, nonceKey });
          return;
        }
        console.error(JSON.stringify({
          event: 'roster_page_abandoned', channelId: target.channelId, parentMessageId: target.parentMessageId, page,
        }));
        postAttemptsByKey.set(key, { ...entry, abandoned: true });
      };
      // Every fresh post gets its own nonce key, kept across its retries: a
      // re-post after a gone copy, or after the roster shrank and grew again,
      // must never reuse an earlier post's key, or Discord could hand back
      // the deleted message instead of creating a new one.
      const nonceKey = postAttemptsByKey.get(key)?.nonceKey ??
        `roster:${target.parentMessageId}:${page}:${Date.now().toString(36)}`;
      if (ref) {
        try {
          await editMessage(botToken, ref.channelId, ref.messageId, embed, limits);
          ref.onlineEmbed = rendered;
          delete ref.pageAttempts;
          continue;
        } catch (err) {
          if (!(err instanceof DiscordApiError && err.isGone)) {
            logFailure('edit', ref.channelId, ref.parentMessageId, err);
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
        messages.push({ channelId: target.channelId, parentMessageId: target.parentMessageId,
          page, messageId, onlineEmbed: rendered });
        postAttemptsByKey.delete(key);
      } catch (err) {
        if (err instanceof DiscordUnconfirmedPostError) {
          // Discord accepted the page but returned no id to track it by:
          // posting again could only duplicate it, so freeze this page.
          console.error(JSON.stringify({
            event: 'roster_post_unconfirmed', channelId: target.channelId, parentMessageId: target.parentMessageId, page,
          }));
          postAttemptsByKey.set(key, {
            channelId: target.channelId, parentMessageId: target.parentMessageId, page, attempts: 0, abandoned: true,
          });
          continue;
        }
        logFailure('post', target.channelId, target.parentMessageId, err);
        giveUp(err);
      }
    }
  }

  // Only keep counters/markers for pages still targeted this poll; if the
  // roster shrank or the host moved/ended, there is nothing left to freeze
  // or retry against.
  // A target whose parent edit failed this poll has unknown pages: keep all
  // of its entries, as its existing continuations are kept above.
  const postAttempts = [...postAttemptsByKey.values()].filter((entry) => targets.some((target) =>
    target.channelId === entry.channelId && target.parentMessageId === entry.parentMessageId &&
    (target.embeds === undefined || entry.page < target.embeds.length)));
  return { messages, postAttempts, failed };
}
