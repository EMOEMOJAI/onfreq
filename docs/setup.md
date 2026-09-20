# Setup

[Overview](../README.md) · [Security](../SECURITY.md)

## Deploy

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Invite it with **View Channel**, **Send Messages**, **Embed Links** and **Read Message History** in every destination channel. Channel overrides must allow these permissions; roster continuations are replies.
3. Install Node.js 24 and clone this repository. Run:

```sh
npm ci
cp .dev.vars.example .dev.vars
cp wrangler.jsonc wrangler.local.jsonc
npx wrangler login
npx wrangler kv namespace create ATC_STATE --config wrangler.local.jsonc
```

Set your Worker name and the new KV namespace ID in **`wrangler.local.jsonc`**. Keep the public template unchanged. Configure secrets interactively:

```sh
npx wrangler secret put DISCORD_BOT_TOKEN --config wrangler.local.jsonc
npx wrangler secret put DISCORD_CHANNEL_IDS --config wrangler.local.jsonc
npx wrangler secret put FIR_PREFIXES --config wrangler.local.jsonc
npx wrangler secret put POLL_SECRET --config wrangler.local.jsonc
npm run deploy
```

Channel IDs and FIR prefixes are required, comma-separated settings; there is no default airspace. Generate a strong random `POLL_SECRET`; never commit it. The first poll quietly records existing connections. Cron then polls once per minute. Usage follows your [Cloudflare plan](https://developers.cloudflare.com/durable-objects/platform/pricing/).

**Upgrading:** set `FIR_PREFIXES`, and migrate any custom labels to private `FIR_LABELS` before deploying. Preserve the existing Worker, KV namespace, Durable Object class and migration tag in your private config. If its coordinator object name differs from `onfreq`, set the `COORDINATOR_NAME` secret to the exact existing name **before deploying**. Changing identity disconnects stored state. Do not restart an old KV-only deployment against stale state.

## Optional settings

[`.dev.vars.example`](../.dev.vars.example) lists every setting and the approval JSON formats. Use `wrangler secret put <NAME> --config wrangler.local.jsonc` for production; `.dev.vars` is local only.

| Setting | Purpose |
| --- | --- |
| `FIR_LABELS`, `EXCLUDED_CALLSIGNS` | Optional private roster labels and excluded positions |
| `MENTION_ROLE_ID` | Optional online-notification ping |
| `IVAO_CLIENT_ID`, `IVAO_CLIENT_SECRET` | IVAO API authentication and member-country lookups |
| `GCA_DM_ENABLED` | Enables optional reminders when set to `true` |
| `GCA_DISCORD_GUILD_ID`, `GCA_MEMBER_ROLE_ID` | Limits reminders to eligible members; enable Discord **Server Members Intent** |
| `GCA_REGIONS` | Private region names, callsign prefixes and home-country groups |
| `GCA_APPROVALS`, `GCA_HOME_OVERRIDES` | Operator-maintained approvals and home-region corrections |
| `GCA_COPY_USER_ID`, `GCA_POLICY_URL` | Optional staff copies and policy link |

GCA coverage is private configuration, with no built-in region list. Set `GCA_REGIONS` before upgrading an existing reminder deployment. Malformed or absent coverage or approval records disable reminders; `{}` explicitly means no approvals. These records are not an authoritative registry. A first enabled poll baselines existing connections. Possible DM deliveries are not repeated, so ambiguous failures can mean a missed reminder. See [data retention](../SECURITY.md#data-retention) before enabling this feature.

`OFFLINE_GRACE_POLLS` is the only plain Wrangler variable; the default is two missed polls. Public cards retry failed destinations without resetting connection times; crashes between Discord acceptance and storage can still cause duplicates.

## Health and optional Mac fallback

`GET /` checks HTTP reachability. Authenticated `GET /health` returns 200 when a successful poll was saved within five minutes, otherwise 503. It does not prove optional GCA delivery. `POST /poll` runs an eligible poll; concurrent triggers are coordinated. Use `Authorization: Bearer <POLL_SECRET>` and keep tokens out of shell history, process arguments and logs.

The Mac helpers read private files under `~/.onfreq`. Create that directory with mode 0700; store your HTTPS `/poll` URL in `poll-endpoint` and the URL-safe token in `poll-secret`, both mode 0600, using a local editor. Then:

```sh
mkdir -p ~/Library/Logs ~/Library/LaunchAgents
cp scripts/poll-trigger.sh scripts/health-monitor.sh ~/.onfreq/
chmod 700 ~/.onfreq/*.sh
for agent in com.onfreq.poll com.onfreq.health; do
  sed "s|__HOME__|$HOME|g" "scripts/$agent.plist" > "$HOME/Library/LaunchAgents/$agent.plist"
  chmod 600 "$HOME/Library/LaunchAgents/$agent.plist"
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$agent.plist"
done
```

Both agents run every minute while the Mac is awake and logged in. Allow macOS notifications for alerts. Before reinstalling or moving files, unload existing agents with `launchctl bootout`; preserve the endpoint and secret and avoid loading duplicate pollers.

For failures, check `npm run tail` and `~/Library/Logs/onfreq-health.log`. A 401 means the token is wrong; a 403 from Discord usually means channel permissions are missing. Never post unredacted logs publicly.

## Private history maintenance

`POLL_SECRET` also grants access to `GET /gca-history`. This is private member data; do not give the token to third-party uptime monitors.

Preview old staff-copy cleanup with `GET /gca-history/cleanup`. Applying it requires `POST` plus `X-Onfreq-Confirm: delete-old-copies`; it removes at most 500 eligible copies older than 30 days and may cancel pending copies. A 409 means a poll is running. It preserves reminder/occurrence ledgers and does not erase Discord messages or all member data.
