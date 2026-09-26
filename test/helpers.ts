/** Bearer header matching the synthetic POLL_SECRET binding in vitest.config.ts (/poll, /health). */
export const AUTH_HEADERS = { authorization: 'Bearer synthetic-poll-secret-for-vitest-only' } as const;

/** Bearer header matching the distinct synthetic HISTORY_SECRET binding (/gca-history routes). */
export const HISTORY_AUTH_HEADERS = { authorization: 'Bearer synthetic-history-secret-for-vitest-only' } as const;
