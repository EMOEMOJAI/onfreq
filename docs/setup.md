# Setup

[Overview](../README.md) · [Security](../SECURITY.md)

## Guided deployment

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). On its **Bot** page, generate and privately save the bot token. Invite it to your server with **View Channel**, **Send Messages**, **Embed Links** and **Read Message History** in every destination channel.
2. Click the button below. Sign in to Cloudflare, connect GitHub or GitLab and choose your own account, repository and Worker name. Cloudflare creates the KV namespace and Durable Object for you.
3. Fill in these four **Worker secrets**, then deploy. Keep the detected deploy command, `npm run deploy`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/EMOEMOJAI/onfreq)

| Setting | What to enter |
| --- | --- |
| `DISCORD_BOT_TOKEN` | The token from your application's **Bot** page |
| `DISCORD_CHANNEL_IDS` | Enable Discord **Developer Mode**, right-click each text channel → **Copy Channel ID**; separate multiple IDs with commas |
| `FIR_PREFIXES` | Your chosen ICAO callsign prefixes, separated by commas; each is 1–4 letters, with no default region |
| `POLL_SECRET` | Generate a random secret of at least 32 characters with your password manager or `openssl rand -hex 32`; save it privately for health checks |

Channel overrides must allow all four permissions; roster continuations are replies. Store values as encrypted **Worker secrets**, never in repository files, build variables or GitHub Actions. GCA reminders stay off until configured. Usage follows your [Cloudflare plan](https://developers.cloudflare.com/durable-objects/platform/pricing/).

After deployment, cron polls once per minute. **The first poll quietly records existing connections**; cards appear for subsequent connections. Use authenticated `GET /health` to check polling. For optional features, open your Worker → **Settings → Variables and Secrets**, add the required secrets, and deploy those settings. Your copied repository is connected to Workers Builds for future deployments.

## Manual deployment and upgrades

For a new CLI deployment, install Node.js 24, clone the repository and create/invite your bot as above. When upgrading, skip this block and keep your existing `.dev.vars` and `wrangler.local.jsonc`. Run:

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
npm run deploy:local
```

The public `npm run deploy` command runs `wrangler deploy --config wrangler.jsonc`. It stops, even with npm scripts ignored, if a private `wrangler.local.jsonc`, `.json` or `.toml` exists in the checkout or, for a Git worktree, in its main checkout; use `deploy:local` for that installation. It also refuses a root `wrangler.json`, `wrangler.toml` or `.wrangler/deploy/config.json`. Keep an existing button installation's generated resource IDs when managing its copied repository.

**Upgrading:** set `FIR_PREFIXES`, and migrate any custom labels to private `FIR_LABELS` before deploying. Preserve the existing Worker, KV namespace, Durable Object class and migration tag in your private config. If its coordinator object name differs from `onfreq`, set the `COORDINATOR_NAME` secret to the exact existing name **before deploying**. Changing identity disconnects stored state. Do not restart an old KV-only deployment against stale state. Rolling back to an older Worker after upgrading is lossy: some cards may be left open or posted twice. If short-session reminders were ever enabled, purge their data first (see [Optional settings](#optional-settings)). Copy `"code_update_strategy": { "mode": "immediate" }` from the public template's `durable_objects` block into your private config, so deployments keep updating the Durable Object immediately.

## Optional settings

[Optional settings and JSON formats](../config/optional-secrets.example) are separate from the four first-run prompts. Add them as Worker secrets in Cloudflare, or use `wrangler secret put <NAME> --config wrangler.local.jsonc` for a CLI-managed installation. For local development, add only the settings you need to `.dev.vars`.

| Setting | Purpose |
| --- | --- |
| `FIR_LABELS`, `EXCLUDED_CALLSIGNS` | Optional private roster labels and excluded positions |
| `MENTION_ROLE_ID`, `MENTION_COOLDOWN_MINUTES` | Optional role ID pinged for new cards, at most once per channel per cooldown (default 10 minutes; `0` means once per poll) |
| `IVAO_CLIENT_ID`, `IVAO_CLIENT_SECRET` | IVAO API authentication and member-country lookups; if the tracker rejects the bot's token, the feed is read anonymously for up to 30 minutes (`ivao_tracker_auth_rejected`) |
| `GCA_DM_ENABLED` | Enables optional reminders when set to `true` |
| `GCA_DISCORD_GUILD_ID`, `GCA_MEMBER_ROLE_ID` | Limits reminders to eligible members; enable Discord **Server Members Intent** |
| `GCA_VERIFIED_ROLE_ID` | Optional but strongly recommended staff-only role a member must also hold before their nickname VID is trusted, for GCA and short-session reminders |
| `GCA_REGIONS` | Private region names, callsign prefixes and home-country groups |
| `GCA_APPROVALS`, `GCA_HOME_OVERRIDES` | Operator-maintained approvals and home-region corrections; ignored once a [website-managed record](#website-managed-gca-records) is stored |
| `GCA_COPY_USER_ID`, `GCA_POLICY_URL` | Optional staff copies and policy link |
| `SHORT_SESSION_DM_ENABLED` | Enables optional short-session reminders with `true`; `purge` deletes their data |
| `HISTORY_SECRET` | Separate bearer secret for private history endpoints |
| `GCA_ADMIN_HMAC_KEY`, `GCA_ADMIN_HMAC_KEY_NEXT` | Signing key shared with a staff website that publishes [GCA records](#website-managed-gca-records); the second key only during a rotation |
| `IVAO_WEBHOOK_SECRET` | Signing Secret for the optional IVAO webhook, which brings polls forward |

GCA coverage is private configuration, with no built-in region list. Set `GCA_REGIONS` before upgrading an existing reminder deployment. Malformed or absent coverage or approval records, or a set but invalid `GCA_POLICY_URL` or `GCA_VERIFIED_ROLE_ID`, disable reminders; `{}` explicitly means no approvals. These records are not an authoritative registry. Public cards show the red country-mismatch marker, which reveals these private records, only while `GCA_DM_ENABLED` is `true` and this policy and the guild and member-role IDs are valid. A first enabled poll baselines existing connections; so does the first poll after more than 15 minutes without a reminder poll (an outage, invalid configuration or disabled reminders), for connections it sees for the first time. Possible DM deliveries are not repeated, so ambiguous failures can mean a missed reminder. A DM that Discord accepted but whose recording then failed logs `gca_dm_record_failed`: it is never resent, and its staff copy is lost. See [data retention](../SECURITY.md#data-retention) before enabling this feature.

**Recipient setup:** staff must verify each member's VID and assign the member role. The only number in the server nickname must be the member's VID (5–10 digits, no leading zero), for example `Example (9999999999)`: no postcodes, years or other numbers. Servers with more than 10,000 members are not supported: the member lookup fails with `gca_member_list_failed` reason `page_limit`. Duplicate VIDs are skipped: anywhere in the server, or only among members holding both the member and verified roles when `GCA_VERIFIED_ROLE_ID` is set. Members can edit their own nicknames, so set `GCA_VERIFIED_ROLE_ID` to a role only staff assign after checking the nickname number is the member's VID, and restrict nickname changes. Supply a known home country through IVAO API credentials or `GCA_HOME_OVERRIDES`; unknown codes such as `ZZ` are invalid. Test a new connection after setup: existing connections are baselined, and fixing an unmapped nickname does not retry that same connection.

**Reminder limit:** a member gets at most 3 GCA reminder DMs in any rolling 24 hours. Reserved and sent DMs count, and so do possibly delivered failures; definite rejections and DMs recorded by an earlier version do not. A further qualifying connection is still recorded and numbered, and gets a staff copy (when `GCA_COPY_USER_ID` is set) of the embed the member would have received, with the text `No member DM sent to <@member-id> · VID <vid> · 24-hour cap of 3 GCA reminders reached; this occurrence is recorded only`, but no member DM (logged as `gca_dm_capped`). A capped connection counts as delivered for numbering, is never resent and does not count towards the limit. `GET /gca-history` reports it with `status` `"capped"` and `capped` `true`; every record carries the `capped` boolean. After a [rollback](#rollback) to an older version, its history shows capped connections as `sent`.

**Short-session reminders:** with `SHORT_SESSION_DM_ENABLED` set to `true`, a controller whose carded session in the monitored division ends after time online that provably lasted under 30 minutes (with a one-minute margin for poll timing) gets one DM, 10 minutes after leaving, reminding them of the IVAO 30-minute minimum. Time online counts any position, including excluded ones, and runs from the last poll before they appeared to the first poll that missed them; absences of under 10 minutes between polls, returning on the same IVAO connection (while its online record lasts, up to an hour after the first poll that missed them), and time without successful polls do not split it. A member already online when the feature starts, or after it was off, misconfigured or purged, or after a poll's data failed to save, has an unknown start and gets no reminder for that time online; so do members appearing in large numbers at once. Nothing is sent if they are back online, if a GCA reminder was possibly sent to them, or capped, during that time, in a poll that attempted a GCA reminder or copy, or more than once per 24 hours (a possibly delivered failed attempt counts, a definite rejection does not), and there is no staff copy. It works without GCA reminders but uses the same recipient setup: it requires valid `GCA_DISCORD_GUILD_ID` and `GCA_MEMBER_ROLE_ID`, and honours `GCA_VERIFIED_ROLE_ID` exactly as GCA reminders do (optional but strongly recommended). Invalid IDs, including a set but invalid verified role, make it log `short_session_config_invalid` and stay off. Retention is in [Security](../SECURITY.md#data-retention). Set it to `purge` to send nothing and drop all of its data on the next successful poll; to roll back to an older version, set `purge`, wait for the `short_session_purged` log, then revert.

**IVAO webhook:** on the [IVAO Developers website](https://developers.ivao.aero), open your application's **Edit** page → **Webhooks**. Set the URL to `https://<your-worker>/ivao/webhook`, subscribe only to the `tracker.session.started` event and store the **Signing Secret** as `IVAO_WEBHOOK_SECRET` (at least 32 characters, distinct from both bearer secrets, `IVAO_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `GCA_ADMIN_HMAC_KEY` and `GCA_ADMIN_HMAC_KEY_NEXT`; otherwise the webhook returns 503 and logs `config_invalid`, while cron polling continues). IVAO sends this event for every connection on the whole network, pilots included, and each one is a Worker request that counts toward your Cloudflare plan's request allowance. A verified ATC connection on a monitored prefix schedules an early poll; the event itself is never stored. Early polls run at least 30 seconds after any other poll and a cron poll may follow an early poll after 25 seconds, with at most 20 early polls per clock hour. An early poll more than 35 seconds after a regular poll replaces the next regular poll, so the longest gap between polls is about 85 seconds. Counters measured in polls (offline grace, retries, reminder limits) can then advance faster: polls can be as little as 25 seconds apart, so the offline grace can be as short as about 25 seconds per grace poll. A controller first seen at 0.000 MHz still waits for a later poll. The next-cron prediction assumes a single scheduler: with cron plus an external `POST /poll`, an early poll may gain little but still uses the hourly budget.

`OFFLINE_GRACE_POLLS` is the only plain Wrangler variable; the default is two missed polls. Public cards retry failed destinations without resetting connection times. Offline updates retry for up to a day after the session ended; an older one, such as after a long polling outage, is dropped after one final attempt that reaches Discord; a rate-limit wait does not count. Updates for a channel removed from `DISCORD_CHANNEL_IDS` wait untouched within that day in case it is added back. More than 50 new connections in one poll are treated as a feed glitch (logged as `feed_anomaly`) and tracked silently: those sessions never get an online or offline card. Card posts carry a Discord nonce keyed to the IVAO connection being announced, so a re-send after a crash between Discord acceptance and storage is deduped by Discord within its own nonce window (a few minutes); crashes outside that window can still cause duplicates. If a first card posts but that poll's save is lost and the controller reconnects under a new IVAO connection before the next poll, that card is never tracked or closed.

## Health

`GET /` checks HTTP reachability. Authenticated `GET /health` returns 200 when a successful poll was saved within five minutes and cron or `POST /poll` last called the bot within five minutes, otherwise 503. It does not prove optional GCA or short-session delivery. `POST /poll` runs an eligible poll; concurrent triggers are coordinated. Use `Authorization: Bearer <POLL_SECRET>` and keep tokens out of shell history, process arguments and logs. Secrets shorter than 32 characters, or equal to `IVAO_WEBHOOK_SECRET`, `IVAO_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` or a [GCA records signing key](#signing-key-and-rotation), count as unset: their endpoints return 503. Authenticated routes send `Cache-Control: no-store`, and their error bodies carry a fixed `error` message. When upgrading, rotate a shorter `POLL_SECRET` and set a distinct `HISTORY_SECRET` before deploying.

For failures, check `npm run tail` (CLI installations; otherwise Worker Logs in the Cloudflare dashboard). A 401 means the token is wrong; a 403 from Discord usually means channel permissions are missing. Never post unredacted logs publicly.

## Private history maintenance

`GET /gca-history`, `/gca-history/cleanup` and the [GCA records operator routes](#operator-routes-and-a-compromised-key) require `Authorization: Bearer <HISTORY_SECRET>`, a separate secret of at least 32 characters; `POLL_SECRET` does not grant access. Without it, or when it equals `POLL_SECRET`, `IVAO_WEBHOOK_SECRET`, `IVAO_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` or a GCA records signing key, these endpoints return 503. History is private member data; keep this token off monitors.

Preview old staff-copy cleanup with `GET /gca-history/cleanup`. Applying it requires `POST` plus `X-Onfreq-Confirm: delete-old-copies`; it removes at most 500 eligible copies older than 30 days, plus unsent copies addressed to an account other than the current valid `GCA_COPY_USER_ID`, and may cancel pending copies. Nothing runs it automatically: run it periodically and after changing `GCA_COPY_USER_ID`. A 409 means a poll is running. It preserves reminder/occurrence ledgers and does not erase Discord messages or all member data.

## Website-managed GCA records

A staff website can publish GCA approvals and home overrides to the bot instead of the `GCA_APPROVALS` and `GCA_HOME_OVERRIDES` secrets. The bot verifies, validates and stores each published record in its Durable Object and uses it from the next poll; a poll already running keeps the policy it loaded. `GCA_REGIONS` stays a secret, and every stored record is checked against it again on each poll. Reminders and the public marker still need `GCA_DM_ENABLED` and the other settings above.

**Source precedence:** once a stored record exists it wins and both secrets are ignored, even when they change. Without one, the secrets apply exactly as before. A stored record that no longer validates, for example after a region it uses was removed from `GCA_REGIONS`, turns reminders and the public marker off (logged as `gca_config_invalid` with reason `records`, every poll while reminders are enabled, otherwise once per isolate), with no fallback to the secrets; public cards continue, and publishing a valid record restores them. Both meta routes report the `source`:

| `source` | Meaning |
| --- | --- |
| `durable-object` | A valid stored record drives the policy |
| `secrets` | No stored record; `version`, `digest` and `updatedAt` are null and the counts are those of the secrets |
| `invalid` | A stored record exists but fails validation or cannot be read; GCA is off and the counts are 0 |

### Signing key and rotation

Generate a random key of at least 32 characters with your password manager or `openssl rand -hex 32`, store it as the `GCA_ADMIN_HMAC_KEY` Worker secret, and hand it to the website only through a secure channel; never print it, paste it into chats or commit it. Surrounding whitespace is trimmed. Use one key per deployment: the signature does not cover the host name, so a key shared by two deployments lets a request for one be replayed against the other.

The signed routes return 503 `endpoint disabled` while `GCA_ADMIN_HMAC_KEY` is unset, a set key is shorter than 32 characters, `GCA_ADMIN_HMAC_KEY_NEXT` equals it, or either key equals `POLL_SECRET`, `HISTORY_SECRET`, `IVAO_WEBHOOK_SECRET`, `IVAO_CLIENT_SECRET` or `DISCORD_BOT_TOKEN`. A `POLL_SECRET` or `HISTORY_SECRET` equal to either key also disables that secret's routes, and an `IVAO_WEBHOOK_SECRET` equal to either key disables the webhook. If a GCA key ever matched another secret, treat that GCA key as compromised and replace it (see [the compromised-key steps](#operator-routes-and-a-compromised-key)); changing only the other secret would re-enable the signed routes with a key that monitors, IVAO or other holders of that secret already have. Each reason is logged once per isolate as `config_invalid`, naming settings only; on a deployment without the key, any request to a signed route logs `config_invalid` with reason `GCA_ADMIN_HMAC_KEY_unset`, which is expected there.

To rotate:

1. Store a new key as `GCA_ADMIN_HMAC_KEY_NEXT`. Both keys now verify; each request names its key by key id.
2. Switch the website to the new key and confirm a signed `GET /gca/records/meta` returns 200.
3. Pause publishing, set `GCA_ADMIN_HMAC_KEY` to the new key and delete `GCA_ADMIN_HMAC_KEY_NEXT`, in one dashboard save if you can: while both hold the same key, the routes return 503 `endpoint disabled`. Confirm signed meta again.

### Signed requests

Routes match the exact path, with no trailing slash and no `?` anywhere in the raw URL. There is no CORS; every response is `Cache-Control: no-store` and errors carry a fixed `{"error": "<category>"}` body.

| Route | Body | 200 response |
| --- | --- | --- |
| `PUT /gca/records` | `{"approvals":{...},"homeOverrides":{...},"baseVersion":<version or null>}`, plus `"confirmEmpty":true` to publish empty approvals | `{version, digest, updatedAt}` |
| `GET /gca/records/meta` | Empty | `{version, digest, updatedAt, counts: {approvals, homeOverrides}, source}` |
| `POST /gca/records/history/purge` | Empty | `{ok: true, kept}`: `kept` is 1, or 0 with no stored record |

`version` and `baseVersion` are decimal strings (`"1"`, never `1`); `digest` is 64 lowercase hex; `updatedAt` is ISO 8601 UTC with milliseconds. In `approvals`, each VID (5–10 digits, no leading zero) maps to at most 8 items of exactly `{"level": 1–3, "region": "<region code from GCA_REGIONS>"}`; in `homeOverrides`, each VID maps to an uppercase two-letter country code (unknown codes such as `ZZ` are refused). Each list holds at most 2000 VIDs and the body at most 64 KiB. In practice the body limit is usually reached first, at about 1,700 VIDs with one approval each (fewer with longer VIDs or more approvals); an oversized publish gets 413 and the stored record is unchanged. The digest is the SHA-256 hex of the canonical JSON `{"approvals":{...},"homeOverrides":{...}}`: no whitespace, object keys sorted by UTF-16 code units (so `"100001"` sorts before `"99999"`), items as `{"level":n,"region":"XX"}` in the given order.

Each request carries four headers:

| Header | Value |
| --- | --- |
| `X-XE-GCA-Key-Id` | The first 16 lowercase hex characters of SHA-256 over `onfreq-gca-key-id-v1`, a line feed and the trimmed key |
| `X-XE-GCA-Timestamp` | Unix time in milliseconds, 13 digits; accepted within 300,000 ms (five minutes) of the Worker's clock, either way |
| `X-XE-GCA-Nonce` | A lowercase UUID v4, new for every request including retries |
| `X-XE-GCA-Signature` | Lowercase hex HMAC-SHA256, keyed by the UTF-8 bytes of the trimmed key, of `METHOD`, `PATH`, key id, timestamp, nonce and the lowercase hex SHA-256 of the raw body bytes, joined by line feeds with no trailing line feed |

A nonce is single use: it is stored until 601 seconds after receipt or 360 seconds after its timestamp, whichever is later, and a replay is refused. At most 2000 unexpired nonces are kept. At most 30 write attempts (PUT and purge, including ones then refused with 400, 409 or 503) and, separately, at most 120 signed meta requests are accepted per sliding hour; beyond either limit the request gets 429 `rate_limited`. The operator's bearer meta route, `GET /gca-history/records`, has no such limit. Synthetic vectors for the key id, digest and signatures are in [the HTTP tests](../test/gca-records-http.test.ts).

Requests are checked in this order; the first failure decides:

1. 404 for an unknown path; 405 for another method, including `OPTIONS`.
2. 400 `query_not_allowed` for any `?` in the URL.
3. 503 `endpoint disabled` for the key configuration above.
4. 401 `unauthorized` for a missing or malformed header, then 413 for a body over 64 KiB, then 401 for a timestamp outside the window, an unknown key id or a wrong signature. Every authentication failure has the same 401 body. Nothing up to here touches Durable Object storage.
5. In the coordinator: 401 for a replayed nonce or a non-empty meta or purge body; 429 `rate_limited` for a full nonce table or a spent hourly limit (writes, or signed meta).
6. PUT only: 503 `gca regions invalid` when `GCA_REGIONS` is unusable, then the body's 400 categories in this order: `invalid_json` (invalid UTF-8, a byte order mark, invalid JSON, duplicate keys, nesting deeper than 32 or not an object); `unknown_field` (a top-level key other than the four above); `invalid_base_version` (`baseVersion` missing, or neither null nor a decimal string); `invalid_records` (`confirmEmpty` other than `true`, or either list not an object); then each list, approvals first, with `too_many_vids`, `too_many_approvals`, `unknown_field` (an item key other than `level` and `region`) and `invalid_records` for anything else; finally `empty_requires_confirm` for `{}` approvals without `confirmEmpty`.
7. PUT only: 409 `{currentVersion, currentDigest}` when `baseVersion` is not the current version: the first publish needs `null`, and `currentVersion` is null while nothing is stored.
8. 503 `coordinator unavailable` if the coordinator fails.

A 503 or a timeout on PUT or purge means the outcome is unknown. Reconcile with signed meta: if its `digest` equals the digest you sent, the PUT applied. Otherwise retry with a new nonce, timestamp and signature; a 409 whose `currentDigest` equals the digest you sent also means the earlier attempt applied. The bot logs `gca_records_updated` with only the version and the counts, and never logs digests, VIDs, bodies, nonces, key ids or signatures.

### Cutover

1. Deploy with `GCA_ADMIN_HMAC_KEY` set. `GET /gca-history/records` should report `source` `secrets`.
2. Publish the first record from the website with `baseVersion` `null`, normally matching the current secrets. Confirm meta reports `source` `durable-object` and the published digest, and that the next poll logs no `gca_config_invalid`.
3. From now on `GCA_APPROVALS` and `GCA_HOME_OVERRIDES` are ignored. You may delete them from Cloudflare, but only while the owner keeps a private local copy current with every publish: the [rollback](#rollback) needs it.

Stored records belong to the coordinator object named by `COORDINATOR_NAME` (default `onfreq`). Renaming it returns the bot to the secrets, and the old object keeps its records, which the operator routes can no longer reach; run the operator delete before renaming.

### Operator routes and a compromised key

With `Authorization: Bearer <HISTORY_SECRET>`, `GET /gca-history/records` returns the same meta as the signed route, and `POST /gca-history/records/delete` with `X-Onfreq-Confirm: delete-gca-records` deletes the stored record and all its history, returning `{ok: true, deleted, history}`; without the header it returns 400. The bot then uses the secrets again. The version counter is never reset, so a later publish, which needs `baseVersion` `null`, gets a higher version than any earlier one. An `invalid` record whose `version` is null cannot be replaced by a publish; delete it.

If the signing key may be compromised:

1. Delete `GCA_ADMIN_HMAC_KEY_NEXT` and replace or delete `GCA_ADMIN_HMAC_KEY` first, so nothing more can be signed with it.
2. Then check `GET /gca-history/records`. Unless you can confirm the stored record, set `GCA_DM_ENABLED` to `false` (or first restore current `GCA_APPROVALS` and `GCA_HOME_OVERRIDES` from the owner's copy), and only then run the operator delete, so no poll runs on stale secrets.
3. Restore the secrets from the owner's copy, or give the website a new key and publish a known good record with `baseVersion` `null`.
4. If step 2 set `GCA_DM_ENABLED` to `false`, set it back to `true` only once the secrets or the published record are current.

### Rollback

Every step is mandatory, in this order. Steps 1 and 5 keep polls from running on stale secrets between the delete and the restore.

1. Set `GCA_DM_ENABLED` to `false`, or first restore `GCA_APPROVALS` and `GCA_HOME_OVERRIDES` from the owner's current copy. While `GCA_DM_ENABLED` is not `true`, neither a stored record nor the secrets drive reminders or the public marker.
2. `POST /gca-history/records/delete` (`HISTORY_SECRET` bearer, `X-Onfreq-Confirm: delete-gca-records`), then `GET /gca-history/records` must report `source` `secrets` and `version` `null`. If it does not, stop this sequence and follow [If the delete fails](#if-the-delete-fails) below; no other path is documented.
3. Restore `GCA_APPROVALS` and `GCA_HOME_OVERRIDES` from the owner's current copy, unless step 1 already did. Version 2.2.12 reads only the secrets; without them reminders and the public marker are off.
4. Redeploy 2.2.12.
5. With the secrets current, set `GCA_DM_ENABLED` back to `true` if step 1 set it to `false`. Check `npm run tail` or Worker Logs: polls succeed, with no exceptions and no `gca_config_invalid`.

A later upgrade then starts with no stored record (`source` `secrets`) and needs a fresh first publish with `baseVersion` `null`, so an old record can never override newer secrets. Version 2.2.12 shows [capped](#optional-settings) connections as `sent` in history and never resends them.

#### If the delete fails

If the operator delete or its check fails, for example because the new version is broken at the coordinator, the rollback is not stuck: continue with steps 3 to 5, and record that a stale stored record remains. A rollback without step 2 is unsupported unless this re-upgrade procedure is followed before any later version with GCA records is deployed:

1. Set `GCA_DM_ENABLED` to `false`. While it is not `true`, a stored record cannot drive reminders or the public marker.
2. Deploy the new version.
3. Run the operator delete.
4. Confirm `GET /gca-history/records` reports `source` `secrets` and `version` `null`.
5. Confirm `GCA_APPROVALS` and `GCA_HOME_OVERRIDES` match the owner's current copy; only then set `GCA_DM_ENABLED` back to `true`.
