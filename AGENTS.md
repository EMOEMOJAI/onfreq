# Working on onfreq

TypeScript Discord bot on Cloudflare Workers. Read [README.md](README.md) and [setup](docs/setup.md); source and tests are authoritative.

## Source map

[src/index.ts](src/index.ts) routes HTTP and cron events; [src/coordinator.ts](src/coordinator.ts) serializes polling. [src/poll.ts](src/poll.ts), [src/state.ts](src/state.ts) and [src/roster.ts](src/roster.ts) handle notification delivery. [src/gca.ts](src/gca.ts) handles optional reminders. Tests live in [test/](test/); deployment and Mac helpers live in [scripts/](scripts/).

## Checks

Use Node.js 24. Run `npm ci`; copy `.dev.vars.example` to `.dev.vars` only if absent. Run `npm run lint:docs`, `npm run typecheck`, `npm test` and `npx wrangler deploy --dry-run`. Script changes also need ShellCheck (POSIX files), actionlint, zsh syntax checks and macOS plist validation. Maintainer deployment uses `npm run deploy:local` with ignored `wrangler.local.jsonc` and requires task authorization. The public `deploy` script is for new installations and must refuse a checkout containing private deployment config.

## Invariants

- All HTTP and cron polling uses the same coordinator selected by `getCoordinator`; preserve existing deployment/storage identities through private configuration.
- `src/state.ts` handles sessions; `poll.ts` and `roster.ts` handle delivery. Public delivery is at least once.
- `gca.ts` parses private region coverage and approvals, and manages durable DM reservations. Invalid policy disables reminders; cleanup must preserve deduplication and occurrence ledgers.
- Health reads never poll or refresh success time. Cleanup must not race polling.
- Mac monitoring must not log credentials, private URLs or response bodies.

## Workflow and privacy

Use synthetic fixtures. Never read or publish production secrets for routine development. Keep local configuration ignored and the public KV ID all-zero. Keep `.dev.vars.example` limited to the four first-run secrets; optional settings belong in `config/optional-secrets.example` and `src/env.d.ts`. Store scratch work under ignored `.local/`.

Validate changes and push directly to main; no PRs or PR-opening bots. Do not rewrite published history without explicit authorization, merge private historical branches, or disable existing Git hooks. Use GitHub-hosted CI with pinned actions and minimal permissions; CI never deploys.

Keep documentation brief. Update README, setup and llms.txt links when paths change. Avoid unrelated changes.
