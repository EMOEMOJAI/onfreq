export const IVAO_ATC_SUMMARY_URL = 'https://api.ivao.aero/v2/tracker/now/atc/summary';

/** OAuth2 client-credentials endpoint for the IVAO API. */
export const IVAO_TOKEN_URL = 'https://api.ivao.aero/v2/oauth/token';

/** Scope needed for the tracker (Whazzup) endpoints. */
export const IVAO_SCOPE = 'tracker';

/** Key under which the tracked-ATC map is stored in KV. */
export const STATE_KEY = 'atc-state-v1';

/** Key under which the cached IVAO access token is stored in KV. */
export const TOKEN_KEY = 'ivao-token-v1';

export const COLOR_ONLINE = 0x57f287; // Discord green
export const COLOR_OFFLINE = 0xed4245; // Discord red
export const COLOR_ENDED = 0x99aab5; // Discord greyple — finished session

export const EMBED_FOOTER = 'IVAO ATC Monitor';

export interface FirLabel { prefixes: string[]; flag: string; name: string }

/** Optional private display labels; no operator geography is built in. */
export function parseFirLabels(raw: string | undefined): FirLabel[] {
  if (!raw?.trim()) return [];
  const invalid = () => new Error('FIR_LABELS must be a valid, unambiguous label array');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!Array.isArray(value)) throw invalid();
  const labels: FirLabel[] = [];
  const seen: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
    const { prefixes, flag, name } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || name.length > 12 || /[\x00-\x1f\x7f\\`*_~|\[\]<>]/.test(name)) throw invalid();
    if (typeof flag !== 'string' || !/^(?:🌐|[\u{1f1e6}-\u{1f1ff}]{2})$/u.test(flag)) throw invalid();
    if (!Array.isArray(prefixes) || !prefixes.length) throw invalid();
    const clean: string[] = [];
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string' || !/^[A-Z]{1,4}$/.test(prefix) ||
          seen.some((other) => other.startsWith(prefix) || prefix.startsWith(other))) throw invalid();
      seen.push(prefix);
      clean.push(prefix);
    }
    labels.push({ prefixes: clean, flag, name: name.trim() });
  }
  return labels;
}

/** The FIR a callsign belongs to, or a neutral fallback for anything unmapped. */
export function firOf(callsign: string, labels: FirLabel[] = []): { flag: string; name: string } {
  const cs = callsign.toUpperCase();
  for (const fir of labels) {
    if (fir.prefixes.some((prefix) => cs.startsWith(prefix))) {
      return { flag: fir.flag, name: fir.name };
    }
  }
  return { flag: '🌐', name: 'Other' };
}

/** One coordination domain for this bot's session log and all poll triggers. */
export const COORDINATOR_NAME = 'onfreq';

/** Private override lets an existing deployment retain its original state. */
export function getCoordinator(env: Pick<Env, 'POLL_COORDINATOR' | 'COORDINATOR_NAME'>) {
  return env.POLL_COORDINATOR.getByName(env.COORDINATOR_NAME?.trim() || COORDINATOR_NAME);
}
export const POLL_SNAPSHOT_KEY = 'poll-snapshot-v1';
// Five seconds of tolerance avoids skipping minute cron runs due to jitter,
// while still suppressing a second scheduler running at a different offset.
export const MIN_POLL_INTERVAL_MS = 55_000;
