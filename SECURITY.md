# Security & privacy

Report vulnerabilities through [GitHub private reporting](https://github.com/EMOEMOJAI/onfreq/security/advisories/new). Never include credentials or unredacted member records in public issues.

Keep deployment values in Wrangler secrets and ignored `.dev.vars`, `wrangler.local.jsonc` or `*.local.sh` files. Do not publish working-directory ZIPs; use a reviewed Git archive. Rotate any exposed credential at its provider.

## Data retention

The bot processes IVAO and Discord IDs. Optional GCA delivery and occurrence ledgers retain member/connection identifiers indefinitely for deduplication. Other inactive reminder records expire after seven days; staff-copy payloads clear after delivery or handled terminal failure, but pending/reserved copies may retain them.

Staff-copy cleanup is **not complete member erasure**. It leaves delivery and occurrence records, Discord messages, logs and backups intact. There is no supported selective-erasure operation preserving the same deduplication guarantees. Disable reminders before planning broader deletion; do not manually reset their ledgers while active.

## Development

Use synthetic test data, your GitHub noreply email, and Gitleaks before committing. Preserve configured Git hooks. CI uses GitHub-hosted runners with pinned actions and minimal permissions; never supply deployment secrets or attach a private runner.

Secret scans supplement manual review. Removing a file does not erase old commits, cached pages, forks or clones.
