# Security & privacy

Report vulnerabilities through [GitHub private reporting](https://github.com/EMOEMOJAI/onfreq/security/advisories/new). Never include credentials or unredacted member records in public issues.

Keep deployment values in Wrangler secrets and ignored `.dev.vars`, `.envrc`, `wrangler.local.jsonc`, `*.local.sh` or `config/` files; only `config/optional-secrets.example` is public. Do not publish working-directory ZIPs; use a reviewed Git archive. Rotate any exposed credential at its provider.

The optional `POST /ivao/webhook` is authenticated by the IVAO (Hook0) HMAC signature keyed by `IVAO_WEBHOOK_SECRET`, is disabled while that secret is unset, shorter than 32 characters or reused, and never stores or logs payloads.

## Data retention

The bot processes IVAO and Discord IDs. Optional GCA delivery and occurrence ledgers retain member/connection identifiers indefinitely for deduplication. Other inactive reminder records expire after seven days; staff-copy payloads clear after delivery or handled terminal failure, but pending/reserved copies may retain them, including copies for a previous `GCA_COPY_USER_ID`, which are never sent. Only the manual [cleanup](docs/setup.md#private-history-maintenance) removes them: copies older than 30 days, and unsent copies for any account but the current one. Optional short-session reminders store the VID and online times of every ATC member in the monitored division while they are online and for up to one hour after; their reminder records keep the member ID for seven days and the callsign until the reminder is finished or expires. Online records are cleared while the feature is off, and `SHORT_SESSION_DM_ENABLED="purge"` drops all of it on the next poll.

Staff-copy cleanup is **not complete member erasure**. It leaves delivery and occurrence records, Discord messages, logs and backups intact. There is no supported selective-erasure operation preserving the same deduplication guarantees. Disable reminders before planning broader deletion; do not manually reset their ledgers while active.

## Development

Use synthetic test data, your GitHub noreply email, and Gitleaks before committing. Preserve configured Git hooks. CI uses GitHub-hosted runners with pinned actions and minimal permissions; never supply deployment secrets or attach a private runner.

Secret scans supplement manual review. Removing a file does not erase old commits, cached pages, forks or clones.
