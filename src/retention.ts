import { isSnowflake } from './discord';

const COPY_RETENTION_MS = 30 * 86_400_000;
const BATCH_SIZE = 500;

/**
 * Remove old staff-copy payloads/recipients, plus unsent copies addressed to
 * anyone but the current valid `GCA_COPY_USER_ID` (they are never sent);
 * never remove the deduplication or occurrence ledgers.
 */
export function cleanupGcaCopies(storage: DurableObjectStorage, apply: boolean, now: number, copyUserId?: string) {
  const cutoff = now - COPY_RETENTION_MS;
  // Without a valid current recipient (unset or a typo) nothing counts as
  // stale by recipient: only the age rule applies.
  const currentRecipient = isSnowflake(copyUserId) ? copyUserId : null;
  const sql = storage.sql;
  const tables = sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('gca_copies', 'gca_reminders')",
  ).toArray();
  if (tables.length !== 2) return { applied: apply, cutoff, eligible: 0, deleted: 0, more: false };

  return storage.transactionSync(() => {
    // Age rule: only copies whose member reminder is terminal qualify, since
    // those cannot create a new copy; under this rule a copy without a parent
    // row is retained because its age cannot be established. In practice only
    // 'sent' is currently reachable here; 'reserved' and 'failed' are included
    // defensively in case a future status transition ever leaves a reminder
    // row in one of those states past its cutoff.
    // Recipient rule: a copy for a previous staff account is only ever sent to
    // that account, so an unsent one is removed regardless of age, parent
    // status or a missing parent row.
    const candidates = sql.exec<{ session_key: string }>(`SELECT c.session_key FROM gca_copies c
      LEFT JOIN gca_reminders r ON r.session_key = c.session_key
      WHERE (r.last_seen < ? AND r.status IN ('sent', 'reserved', 'failed'))
        OR (? IS NOT NULL AND c.status <> 'sent' AND c.recipient_id <> ?)
      ORDER BY c.session_key LIMIT ?`, cutoff, currentRecipient, currentRecipient, BATCH_SIZE + 1).toArray();
    const batch = candidates.slice(0, BATCH_SIZE);
    if (apply) {
      for (const row of batch) sql.exec('DELETE FROM gca_copies WHERE session_key = ?', row.session_key);
    }
    return { applied: apply, cutoff, eligible: batch.length, deleted: apply ? batch.length : 0,
      more: candidates.length > BATCH_SIZE };
  });
}
