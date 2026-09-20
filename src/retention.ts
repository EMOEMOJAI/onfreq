const COPY_RETENTION_MS = 30 * 86_400_000;
const BATCH_SIZE = 500;

/** Remove old staff-copy payloads/recipients; never remove the deduplication ledger. */
export function cleanupGcaCopies(storage: DurableObjectStorage, apply: boolean, now: number) {
  const cutoff = now - COPY_RETENTION_MS;
  const sql = storage.sql;
  const tables = sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('gca_copies', 'gca_reminders')",
  ).toArray();
  if (tables.length !== 2) return { applied: apply, cutoff, eligible: 0, deleted: 0, more: false };

  return storage.transactionSync(() => {
    // Only terminal member reminders qualify: these cannot create a new copy.
    // Missing parent rows are retained because their age cannot be established.
    const candidates = sql.exec<{ session_key: string }>(`SELECT c.session_key FROM gca_copies c
      JOIN gca_reminders r ON r.session_key = c.session_key
      WHERE r.last_seen < ? AND r.status IN ('sent', 'reserved', 'failed')
      ORDER BY c.session_key LIMIT ?`, cutoff, BATCH_SIZE + 1).toArray();
    const batch = candidates.slice(0, BATCH_SIZE);
    if (apply) {
      for (const row of batch) sql.exec('DELETE FROM gca_copies WHERE session_key = ?', row.session_key);
    }
    return { applied: apply, cutoff, eligible: batch.length, deleted: apply ? batch.length : 0,
      more: candidates.length > BATCH_SIZE };
  });
}
