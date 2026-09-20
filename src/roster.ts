import { deleteMessage, DiscordApiError, editMessage, postMessage, type DiscordEmbed } from './discord';
import type { RosterMessage } from './types';

export interface RosterTarget {
  channelId: string;
  parentMessageId: string;
  /** Absent while the parent edit is failing: preserve its existing continuations. */
  embeds?: DiscordEmbed[];
}

/** Reconcile separately sent pages, retaining failed edits/deletions for later polls. */
export async function syncRosterMessages(
  botToken: string, previous: RosterMessage[], targets: RosterTarget[],
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
      messages.push({ ...ref });
      continue;
    }
    try {
      await deleteMessage(botToken, ref.channelId, ref.messageId);
    } catch (err) {
      messages.push({ ...ref });
      logFailure('delete', ref.channelId, ref.parentMessageId, err);
    }
  }

  for (const target of targets) {
    for (const [page, embed] of (target.embeds ?? []).entries()) {
      const rendered = JSON.stringify(embed);
      const index = messages.findIndex((ref) => ref.channelId === target.channelId &&
        ref.parentMessageId === target.parentMessageId && ref.page === page);
      const ref = messages[index];
      if (ref?.onlineEmbed === rendered) continue;
      if (ref) {
        try {
          await editMessage(botToken, ref.channelId, ref.messageId, embed);
          ref.onlineEmbed = rendered;
          continue;
        } catch (err) {
          if (!(err instanceof DiscordApiError && err.status === 404)) {
            logFailure('edit', ref.channelId, ref.parentMessageId, err);
            continue;
          }
          messages.splice(index, 1);
        }
      }
      try {
        const messageId = await postMessage(botToken, target.channelId, embed, undefined, target.parentMessageId);
        messages.push({ channelId: target.channelId, parentMessageId: target.parentMessageId,
          page, messageId, onlineEmbed: rendered });
      } catch (err) {
        logFailure('post', target.channelId, target.parentMessageId, err);
      }
    }
  }
  return { messages, failed };
}
