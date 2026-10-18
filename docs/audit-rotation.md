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
| T1-3 | IVAO API client and token cache | `src/ivao.ts`, `src/member-country.ts` | OAuth token cache and invalidation, credential exposure, feed size and shape limits | 4b2c8a9 | 2026-10-18 | clean (unchanged) |
| T1-4 | GCA reminders and member data | `src/gca.ts`, `src/retention.ts` | Policy parsing fails closed, DM reservations and dedup ledgers, history privacy, cleanup vs polling | 4b2c8a9 | 2026-10-18 | clean (unchanged) |
| T1-5 | Secrets hygiene and privacy gates | `scripts/check-privacy.mjs`, `scripts/secret-scan.sh`, `scripts/hooks/**`, `.github/actions/**`, `.gitignore`, `.gitleaks.toml`, `.dev.vars.example`, `config/**`, `src/env.d.ts` | No real IDs or secrets in history, hook coverage, optional-secret boundaries | 04af6c6 | 2026-10-18 | clean |

## Tier 2 (semi-annually; due 2027-04-18)

| ID | Chunk | Paths | Focus | Baseline | Last pass | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T2-1 | Coordinator and scheduling | `src/coordinator.ts`, `src/config.ts` | Single coordinator, inFlight serialization, throttles and alarms, heartbeat and health, persist() field coverage | 4b2c8a9 | 2026-10-18 | clean |
| T2-2 | Delivery pipeline | `src/poll.ts`, `src/state.ts`, `src/roster.ts`, `src/types.ts` | Untrusted feed data, at-least-once delivery, grace windows, nonce keys, retry budgets | 4b2c8a9 | 2026-10-18 | clean (unchanged) |
| T2-3 | Discord client and rendering | `src/discord.ts`, `src/discord-rate-limit.ts` | Markdown and mention escaping, rate-limit waits, error handling without leaking IDs | 4b2c8a9 | 2026-10-18 | clean (unchanged) |
| T2-4 | Build and deploy config | `wrangler.jsonc`, `tsconfig.json`, `vitest.config.ts`, `.node-version`, `scripts/check-deploy.mjs`, `scripts/check-setup.mjs` | Public KV ID stays all-zero, Durable Object identity and migrations, deploy refusal with private config | 04af6c6 | 2026-10-18 | clean |
| T2-5 | CI and supply chain | `.github/workflows/**`, `package.json`, `package-lock.json`, `.markdownlint-cli2.jsonc`, `scripts/lint-docs.mjs`, `scripts/check-links.mjs`, `scripts/repo-files.mjs` | Pinned actions and minimal permissions, audit gate intact, overrides justified, lint script path safety | 04af6c6 | 2026-10-18 | clean |

## Tier 3 (on trigger)

| ID | Chunk | Paths | Focus | Baseline | Last pass | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T3-1 | Docs and agent instructions | `README.md`, `docs/**`, `llms.txt`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SECURITY.md`, `LICENSE`, `.github/copilot-instructions.md`, `.github/ISSUE_TEMPLATE/**`, `assets/**` | Trigger: before each release, or when setup or security guidance changes. Docs match code; no unsafe advice; no private data | b003a5c | 2026-10-18 | clean |
| T3-2 | Tests and repo-check tests | `test/**`, `scripts/test-hooks.mjs`, `scripts/test-repo-checks.mjs` | Trigger: when fixtures or helpers change, or when a chunk audit flags untested paths. Fixtures stay synthetic; tests can fail | b003a5c | 2026-10-18 | clean |

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

Deferred: hook warning for a non-8.30.1 local Gitleaks; a commit can add a Gitleaks ignore within its own push (by design); test pool runtime older than deploy runtime (no fallback warning; bump when a matching release exists); trailer-email check flags any `@` in a trailer (false positives only).

## Dependency overrides

All are development-only; the Worker bundle does not include them. Remove one once every dependent requires at least that version and `npm audit --audit-level=high` stays clean.

| Package | Minimum | Reason |
| --- | --- | --- |
| `undici` | 7.29.1 | miniflare pins 7.29.0 (GHSA-w293-vg96-wgc3 and other advisories) |
| `source-map-js` | 1.2.2 | CVE-2026-93749 (up to 1.2.1), via postcss |
| `katex` | 0.18.2 | GHSA-238p-pmpm-9mq7 (low), via markdownlint math support |
| `sharp` | 0.35.5 | Closed a Dependabot alert at the time; now deduplicates miniflare's copies |
