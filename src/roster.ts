import { deleteMessage, DiscordApiError, editMessage, postMessage, type DiscordEmbed } from './discord';
import type { RosterMessage } from './types';
import { DiscordRateLimitError, type DiscordRateLimits } from './discord-rate-limit';

export interface RosterTarget {
  channelId: string;
  parentMessageId: string;
  /** Absent while the parent edit is failing: preserve its existing continuations. */
  embeds?: DiscordEmbed[];
}

/** Extra polls an undeletable roster continuation is retried for before it is dropped. */
const DELETE_RETRY_POLLS = 10;

/** Reconcile separately sent pages, retaining failed edits/deletions for later polls. */
export async function syncRosterMessages(
  botToken: string, previous: RosterMessage[], targets: RosterTarget[],
  limits: DiscordRateLimits,
): Promise<{ messages: RosterMessage[]; failed: boolean }> {
  const messages: RosterMessage[] = [];
  let failed = false;
  const logFailure = (operation: string, channelId: string, parentMessageId: string, error: unknown) => {
    failed = true;
    console.error(JSON.stringify({ event: 'roster_continuation_failed', operation, channelId, parentMessageId, error: String(error) }));
  };

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
      // forever: cap it the same way an undeliverable offline closeout is,
      // excluding rate-limit deferrals from the count.
      const rateLimited = err instanceof DiscordRateLimitError;
      const used = (ref.deleteAttempts ?? 0) + (rateLimited ? 0 : 1);
      logFailure('delete', ref.channelId, ref.parentMessageId, err);
      if (rateLimited || used <= DELETE_RETRY_POLLS) {
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
      const rendered = JSON.stringify(embed);
      let index = messages.findIndex((ref) => ref.channelId === target.channelId &&
        ref.parentMessageId === target.parentMessageId && ref.page === page);
      const ref = messages[index];
      if (ref?.onlineEmbed === rendered) continue;
      // A permanently failing edit or post (e.g. a permanently forbidden
      // channel) must not be retried every poll forever: cap it the same
      // way an undeletable continuation is, excluding rate-limit deferrals.
      // Tracked on the surviving `messages` entry, if any; a post that has
      // never once succeeded has nowhere to persist a counter, so it keeps
      // retrying (matching the previous, unbudgeted behaviour for that case).
      const giveUp = (err: unknown): void => {
        if (index < 0) return;
        const rateLimited = err instanceof DiscordRateLimitError;
        const used = (messages[index]!.pageAttempts ?? 0) + (rateLimited ? 0 : 1);
        if (rateLimited || used <= DELETE_RETRY_POLLS) {
          messages[index] = { ...messages[index]!, pageAttempts: used };
          return;
        }
        console.error(JSON.stringify({
          event: 'roster_page_abandoned', channelId: target.channelId, parentMessageId: target.parentMessageId, page,
        }));
        messages.splice(index, 1);
        index = -1;
      };
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
        const messageId = await postMessage(botToken, target.channelId, embed, undefined, target.parentMessageId, limits);
        messages.push({ channelId: target.channelId, parentMessageId: target.parentMessageId,
          page, messageId, onlineEmbed: rendered });
      } catch (err) {
        logFailure('post', target.channelId, target.parentMessageId, err);
        giveUp(err);
      }
    }
  }
  return { messages, failed };
}
