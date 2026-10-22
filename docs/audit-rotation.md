# Audit rotation

Chunked, risk-tiered re-audits that add to per-change review; they don't replace it. Each session audits one chunk and updates this file.

## Cadence

| Tier | Cadence | Covers |
| --- | --- | --- |
| 1 | Quarterly | Public endpoints, authentication, credentials, secrets, private member data |
| 2 | Semi-annually | Untrusted feed parsing, delivery, scheduling, Discord output, build, CI and supply chain |
| 3 | On trigger only | Docs, templates and tests |

## Cadence overrides

Each of these changes makes the named chunk due at once, whatever its date:

- New or changed HTTP route, auth rule or error body: T1-1. If `src/webhook.ts` changes too, also T1-2.
- Webhook signing, replay or filtering change, or an IVAO webhook format change: T1-2.
- IVAO or Discord credential handling, or token cache changes: T1-3.
- GCA policy format, DM, history or cleanup changes: T1-4.
- A new secret or config name, or a hook or privacy-check change: T1-5.
- Short-session change: T1-6.
- Throttle, alarm, health or snapshot schema changes: T2-1.
- `runPoll`, state or roster changes, or an IVAO feed shape change: T2-2.
- A new or bumped dependency, an override change, or a workflow change: T2-5.
- Rollback to an older Worker build: T2-1 and T2-4, before redeploying.

## How to run one chunk

1. Read this file. Take **Next up** unless a cadence override applies or the user names a chunk.
2. Run `git log --oneline <baseline>..HEAD -- <paths>`. If the chunk is unchanged and not due, record "re-verified unchanged" and take the next row.
3. Audit only the chunk's paths and their tests. Use these passes: correctness, security, resource bounds, error handling and the row's **Focus**.
4. Report findings ranked by severity before fixing anything. Fixes follow AGENTS.md: validate, then push to main.
5. Update the row:
   - **Baseline**: the main short SHA
   - **Last pass**: today's date
   - **Status**: clean or open-findings
6. Append notable findings to the log and advance **Next up** to the next most overdue chunk.

## Next up

**T1-1**: HTTP surface and bearer auth (quarterly, due 2027-01-18)

## Tier 1 (quarterly; due 2027-01-18)

| ID | Chunk | Paths | Focus | Baseline | Last pass | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T1-1 | HTTP surface and bearer auth | `src/index.ts`, `src/auth.ts`, `src/http.ts` | Route auth and secret separation, fixed error bodies, no-store, bounded upstream reads, no redirects | 04af6c6 | 2026-10-18 | clean |
| T1-2 | IVAO webhook | `src/webhook.ts` | HMAC verification order, replay cache, body cap, no Durable Object call before verification, log privacy | 08d76ed | 2026-10-18 | clean |
| T1-3 | IVAO API client and token cache | `src/ivao.ts`, `src/member-country.ts` | OAuth token cache and invalidation, credential exposure, feed size and shape limits | b0bcc2a | 2026-10-19 | clean |
| T1-4 | GCA reminders and member data | `src/gca.ts`, `src/retention.ts` | Policy parsing fails closed, DM reservations and dedup ledgers, history privacy, cleanup vs polling | b0bcc2a | 2026-10-19 | clean |
| T1-5 | Secrets hygiene and privacy gates | `scripts/check-privacy.mjs`, `scripts/secret-scan.sh`, `scripts/hooks/**`, `.github/actions/**`, `.gitignore`, `.gitleaks.toml`, `.dev.vars.example`, `config/**`, `src/env.d.ts` | No real IDs or secrets in history, hook coverage, optional-secret boundaries | 566364a | 2026-10-22 | clean |
| T1-6 | Short-session reminders | `src/short-session.ts`; `src/poll.ts` and `src/coordinator.ts` call sites | Presence invariants, continuity/baseline, at-most-once and daily cap, GCA interaction, retention/purge, log privacy | 566364a | 2026-10-22 | clean |

## Tier 2 (semi-annually; due 2027-04-18)

| ID | Chunk | Paths | Focus | Baseline | Last pass | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T2-1 | Coordinator and scheduling | `src/coordinator.ts`, `src/config.ts` | Single coordinator, inFlight serialization, throttles and alarms, heartbeat and health, persist() field coverage | b0bcc2a | 2026-10-19 | clean |
| T2-2 | Delivery pipeline | `src/poll.ts`, `src/state.ts`, `src/roster.ts`, `src/types.ts` | Untrusted feed data, at-least-once delivery, grace windows, nonce keys, retry budgets | 566364a | 2026-10-22 | clean |
| T2-3 | Discord client and rendering | `src/discord.ts`, `src/discord-rate-limit.ts` | Markdown and mention escaping, rate-limit waits, error handling without leaking IDs | 566364a | 2026-10-22 | clean |
| T2-4 | Build and deploy config | `wrangler.jsonc`, `tsconfig.json`, `vitest.config.ts`, `.node-version`, `scripts/check-deploy.mjs`, `scripts/check-setup.mjs` | Public KV ID stays all-zero, Durable Object identity and migrations, deploy refusal with private config | b0bcc2a | 2026-10-19 | clean |
| T2-5 | CI and supply chain | `.github/workflows/**`, `package.json`, `package-lock.json`, `.markdownlint-cli2.jsonc`, `scripts/lint-docs.mjs`, `scripts/check-links.mjs`, `scripts/repo-files.mjs` | Pinned actions and minimal permissions, audit gate intact, overrides justified, lint script path safety | 566364a | 2026-10-22 | clean |

## Tier 3 (on trigger)

| ID | Chunk | Paths | Focus | Baseline | Last pass | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T3-1 | Docs and agent instructions | `README.md`, `docs/**`, `llms.txt`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SECURITY.md`, `LICENSE`, `.github/copilot-instructions.md`, `.github/ISSUE_TEMPLATE/**`, `assets/**` | Trigger: before each release, or when setup or security guidance changes. Docs match code; no unsafe advice; no private data | 566364a | 2026-10-22 | clean |
| T3-2 | Tests and repo-check tests | `test/**`, `scripts/test-hooks.mjs`, `scripts/test-repo-checks.mjs` | Trigger: when fixtures or helpers change, or when a chunk audit flags untested paths. Fixtures stay synthetic; tests can fail | 566364a | 2026-10-22 | clean |

Baseline `932364b` is `main` after the full pre-ship audit (code quality, security, dependencies and build) finished on 2026-09-27. Changes since then were reviewed per change rather than per chunk, so the first pass of any touched chunk should review its whole delta.

## Findings log

| Date | Chunk | Severity | Summary | Commit |
| --- | --- | --- | --- | --- |
| 2026-10-18 | T1-2, T2-1 | P2 | Per-change audit of the webhook: early polls suppressed cron; fixed with separate throttles | cc05123 |
| 2026-10-18 | T2-5 | P2 | CI audit red on braces (GHSA-vfj7-8cjw-p6xm, no patch); replaced markdownlint-cli2 | 2c7fc1b |
| 2026-10-18 | T1-2 | P3 | Debounce could outlast an already-pending early-poll alarm (latency only); fixed. Empty event ids keep one shared replay key (deliberate) | 08d76ed |
| 2026-10-18 | T1-1 | P4 | A bearer secret equal to `IVAO_WEBHOOK_SECRET` was still accepted; now 503 | 04af6c6 |
| 2026-10-18 | T1-5 | P3 | Optional-secrets template not checked for values; webhook-secret detection relied on a generic Gitleaks rule; added checks and `.gitleaks.toml` | 04af6c6 |
| 2026-10-18 | T2-4 | P3 | Local `.dev.vars` values leaked into unset test bindings; deploy guard failed open in linked worktrees | 04af6c6 |
| 2026-10-18 | T2-5 | P3 | Exact-version overrides tree-wide; now caret minimums, reasons recorded below | 04af6c6 |
| 2026-10-18 | T2-1 | P3 | Health passed with webhook-only polling; stale pending alarm blocked new hints; early poll at +30 s randomly displaced cron | 4b2c8a9 |
| 2026-10-18 | T3-1 | P3 | Rotation records stale and `.gitleaks.toml` in no chunk; setup upgrade and secret-reuse wording | b003a5c |
| 2026-10-18 | T3-2 | P3 | Secret-scan history assertions scanned an empty commit; NaN budget case could not fail | b003a5c |
| 2026-10-19 | T1-5 | P3 | Hooks did not warn when local Gitleaks differs from CI's 8.30.1; now warn without blocking | fd1b363 |
| 2026-10-19 | T1-5 | P3 | A push could relax its own scan via Gitleaks settings or `gitleaks:allow` unnoticed; pre-push now names those commits | fd1b363 |
| 2026-10-19 | T1-5 | P3 | Trailer-email check flagged URL handle paths (`/@person`); now ignored, other addresses in URLs still flagged | fd1b363 |
| 2026-10-19 | T1-5 | P3 | `.gitignore` re-included `config/.example` and files under `config/*.example/`, unlike `privatePath`; now aligned | fd1b363 |
| 2026-10-19 | T1-5 | P4 | Trailer-email check ignored `/@` anywhere, so `person/@domain` passed; now ignored only inside a scheme:// URL | d912d3a |
| 2026-10-19 | T1-5 | P4 | Pre-push note missed `gitleaks:allow` lines that only a merge resolution adds; merge diffs now included, as in the scan | d912d3a |
| 2026-10-19 | T2-1 | P2 | A trigger or webhook hint arriving during a saved poll's DM step was dropped; it now runs once, or schedules an early poll, as the throttle allows | b0bcc2a |
| 2026-10-19 | T1-6 | P3 | Short-session DM requests could start with too little budget left; each now needs 10 s (the request timeout) | b0bcc2a |
| 2026-10-19 | T1-3 | P2 | A tracker that rejected fresh tokens was retried with a new token every poll; it now falls back to anonymous reads for 30 minutes | b0bcc2a |
| 2026-10-19 | T1-5 | P3 | Pre-push did not name commits whose message carries gitleaks:allow; now named, whatever the message encoding | b0bcc2a |
| 2026-10-19 | T1-5 | P2 | No Gitleaks rule for operator Discord IDs or private JSON settings; added, with synthetic-fixture allowlists (constants and other names remain uncovered) | b0bcc2a |
| 2026-10-19 | T1-5 | P3 | Any `config/*.example` was public; now only `config/optional-secrets.example` | b0bcc2a |
| 2026-10-19 | T1-5 | P3 | The Gitleaks configuration could drop default rules (extend, path, disabledRules, top-level allowlists, CRLF); check:setup now rejects them | b0bcc2a |
| 2026-10-19 | T1-5 | P3 | `.envrc` files were neither private nor ignored | b0bcc2a |
| 2026-10-19 | T2-4 | P4 | The wrangler.jsonc secret-name comment was unchecked; check:setup now compares it with the settings | b0bcc2a |
| 2026-10-19 | T2-2 | P4 | GCA send detection assumed every request had options | b0bcc2a |
| 2026-10-19 | T1-4, T1-6 | P3 | A definitely undelivered GCA reminder suppressed short-session DMs; GCA budget comment outdated; member-list failure log now says whether a short-session failure counted | b0bcc2a |
| 2026-10-19 | T1-6 | P3 | Due and expiry used the clock rather than the recorded poll; disabling kept the member-list pause key; coverage added for limits and retries | b0bcc2a |
| 2026-10-19 | T1-6 | P4 | Deferred: the DM channel id is kept in the shared rate-limit map | b0bcc2a |
| 2026-10-19 | T1-5 | P4 | Deferred: whole-message email check; gitleaks:allow in author names or paths; a COORDINATOR_NAME or FIR_PREFIXES rule | b0bcc2a |
| 2026-10-19 | T3-1 | P2 | Rollback advice said "let one poll run" though purge needs a successful poll; docs now say to wait for `short_session_purged`. Short-session wording, AGENTS.md and llms.txt updated | 8cd89c7 |
| 2026-10-19 | T3-2 | P3 | A budget test could not fail, "sends nothing" tests passed on a swallowed error, a stray alarm could run; real-Gitleaks tests now fail in CI if Gitleaks is missing. Deferred: a direct test of the poll.ts send-detection wrapper | 8cd89c7 |
| 2026-10-21 | T1-6 | P3 | Fixed deferred mass-reappearance edges: a member back on the same IVAO session after a feed gap keeps their presence; the mass guard is unchanged | 613e0d8 |
| 2026-10-21 | T1-6 | P4 | Fixed deferred: expired rate-limit entries, including DM channel ids, are removed on the next load | 613e0d8 |
| 2026-10-21 | T1-5 | P4 | Fixed deferred: pre-push names gitleaks:allow in author names and paths; rules for multi-line JSON settings and dotenv FIR_PREFIXES/COORDINATOR_NAME. Still deferred: whole-message email check | 1643863 |
| 2026-10-22 | T1-5 | P4 | Fixed deferred: commit messages are checked for real email addresses anywhere, not only in trailers; published history passes without a rewrite. Deferred: Markdown-underscore-wrapped addresses, dotless trailer hosts after a record separator, crafted stateful encodings | 642a729 |
| 2026-10-22 | T3-2 | P4 | Fixed deferred: the GCA send-detection wrapper is now `trackPosts` with direct tests | 0aa808a |
| 2026-10-22 | T1-5 | P4 | Fixed known limit: a Gitleaks rule for the pretty-printed first line of a private JSON setting | 6b676cd |
| 2026-10-22 | T1-5 | P3 | Gitleaks stdin skipped the whole scan when file-type signature bytes (e.g. `ustar` at byte 257) landed in the stream, and missed a secret cut at its read boundary; scans now start with a plain preamble and end every line at a blank line. Also: blanks after the opening quote, separate FIR_PREFIXES and COORDINATOR_NAME rules, linear message-address scan, fixed error on a failed history read, `.gitignore` covers `*.local.json(c)` and `*.local.md` | 07251c3 |
| 2026-10-22 | T2-2 | P3 | An online-card edit that Discord rejects for good (400/413 outside the 30xxx limit codes) was retried every poll and kept the poll in error; now kept until the card changes. Stored-state guards tightened (`missed`, counters) | 192d1db |
| 2026-10-22 | T2-3 | P3 | A short soft cooldown deferred the rest of a channel's requests to the next poll; waits of up to 5 s (10 s per poll) are now waited out. Oversized 2xx edits and deletes count as success | 192d1db |
| 2026-10-22 | T1-6 | P4 | Deferred: a lower surviving connection returning after a long gap starts a new presence (keeping only the latest ids would split a connection the feed dropped once; tried and reverted). Tests no longer swallow poll failures | 566364a |
| 2026-10-22 | T2-5 | P3 | `@cloudflare/vitest-pool-workers` was deprecated; moved to `@cloudflare/vitest-plugin` 1.4.6 with wrangler 4.151.3, so tests run on the deploy runtime; `undici`, `sharp` and `source-map-js` overrides removed | 5d24fab |
| 2026-10-22 | T3-1, T3-2 | P3 | Hook tests used a real ICAO prefix literally (now unassigned J prefixes); SECURITY.md names the stored IVAO session id; AGENTS.md and setup wording; a redaction check that could not fail | 07251c3 |
| 2026-10-22 | T1-5 | P4 | Deferred: rules for other identifying settings (`IVAO_CLIENT_ID`, `EXCLUDED_CALLSIGNS`, `GCA_POLICY_URL`); deployment lines not at a line start; case-sensitive `.gitignore` for upper-case `.LOCAL.*`; lines over ~25 KB or multi-line keys across a scan chunk | 07251c3 |
| 2026-10-22 | T2-2 | P4 | Deferred: no per-poll time budget for public delivery (T2-1 scope); continuation pages may follow a permanently rejected parent edit | 192d1db |

Accepted: pushed changes to `scripts/` or `.github/` are not separately noted (reviewed as code). Rejected: CI warning or re-scan with the previous Gitleaks settings (cancelled runs skip pushes and the same push can edit the workflow).

## Dependency overrides

All are development-only; the Worker bundle does not include them. Remove one once every dependent requires at least that version and `npm audit --audit-level=high` stays clean.

| Package | Minimum | Reason |
| --- | --- | --- |
| `katex` | 0.18.2 | GHSA-238p-pmpm-9mq7 (low), via markdownlint math support |
