# Working on onfreq

TypeScript Discord bot on Cloudflare Workers. Read [README.md](README.md) and [setup](docs/setup.md); source and tests are authoritative.

## Source map

[src/index.ts](src/index.ts) routes HTTP and cron events; [src/webhook.ts](src/webhook.ts) handles the optional IVAO webhook that requests early polls; [src/coordinator.ts](src/coordinator.ts) serializes polling. [src/poll.ts](src/poll.ts), [src/state.ts](src/state.ts) and [src/roster.ts](src/roster.ts) handle notification delivery. [src/gca.ts](src/gca.ts) handles optional reminders. [src/short-session.ts](src/short-session.ts) handles optional short-session reminders. [src/gca-records-http.ts](src/gca-records-http.ts) authenticates the signed GCA records routes and [src/gca-records.ts](src/gca-records.ts) stores website-published records in the coordinator; [src/auth.ts](src/auth.ts) holds the shared secret checks. Tests live in [test/](test/); deployment and Git hook scripts live in [scripts/](scripts/).

## Checks

Use Node.js 24. Run `npm ci`; copy `.dev.vars.example` to `.dev.vars` only if absent. Run `npm run lint:docs`, `npm run typecheck`, `npm test` and `npx wrangler deploy --dry-run`. Durable Object "uncaught exception" lines during `npm test` come from deliberately failing polls and are expected. Script changes also need ShellCheck (POSIX files), actionlint and `sh -n` syntax checks. Maintainer deployment uses `npm run deploy:local` with ignored `wrangler.local.jsonc` and requires task authorization. The public `deploy` script is for new installations and must refuse a checkout containing private deployment config.

After staging changes, run `npm run check:repo` for privacy, deployment setup and local documentation links. These checks read the Git index and commit emails and email addresses in commit messages across reachable HEAD history; they exclude ignored files. The pre-push hook also checks every file version and commit email in the pushed commits. External links are checked weekly and on manual CI runs; HTTP 401/403/429 results are reported as unverified. Periodic chunked re-audits follow [docs/audit-rotation.md](docs/audit-rotation.md).

## Invariants

- All HTTP and cron polling uses the same coordinator selected by `getCoordinator`; preserve existing deployment/storage identities through private configuration.
- `src/state.ts` handles sessions; `poll.ts` and `roster.ts` handle delivery. Public delivery is at least once.
- `gca.ts` parses private region coverage and approvals, and manages durable DM reservations. Invalid policy disables reminders; cleanup must preserve deduplication and occurrence ledgers.
- Health reads never poll or refresh success time. Cleanup must not race polling.
- `short-session.ts` keeps online records only while enabled; `purge` must drop all its tables and keys.
- Signed GCA records requests are verified (key configuration, headers, body size, timestamp window, key id, signature) before any Durable Object access; the coordinator then admits each nonce once and enforces the hourly limits. Never log keys, key ids, nonces, signatures, bodies, digests or VIDs.
- A stored GCA record replaces `GCA_APPROVALS` and `GCA_HOME_OVERRIDES`, is checked against `GCA_REGIONS` on every poll, and when invalid turns GCA off with no fallback to the secrets. The version counter is never reset.

## Workflow and privacy

Use synthetic fixtures. Six-digit test VIDs such as `100001` are synthetic and must carry only fake data. Never read or publish production secrets for routine development. Keep local configuration ignored and the public KV ID all-zero. Keep `.dev.vars.example` limited to the four first-run secrets; optional settings belong in `config/optional-secrets.example` and `src/env.d.ts`. Store scratch work under ignored `.local/`.

Validate changes and push directly to main; no PRs or PR-opening bots. Do not rewrite published history without explicit authorization, merge private historical branches, or disable existing Git hooks. Use GitHub-hosted CI with pinned actions and minimal permissions; CI never deploys.

Keep documentation brief. Update README, setup and llms.txt links when paths change. Avoid unrelated changes.
