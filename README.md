<p align="center">
  <img src="assets/banner.png" alt="onfreq — on frequency" width="760">
</p>

<h1 align="center">onfreq — IVAO ATC, live in Discord.</h1>

<p align="center">
  An open-source Discord bot for IVAO air traffic control notifications.<br>
  Your airspace. Your server. Built with TypeScript and Cloudflare Workers.
</p>

<p align="center">
  <a href="https://github.com/EMOEMOJAI/onfreq/actions/workflows/checks.yml"><img src="https://github.com/EMOEMOJAI/onfreq/actions/workflows/checks.yml/badge.svg" alt="Checks"></a>
  <a href="https://github.com/EMOEMOJAI/onfreq/actions/workflows/codeql.yml"><img src="https://github.com/EMOEMOJAI/onfreq/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-65d993" alt="License: MIT"></a>
</p>

- Choose your flight information regions (FIRs) and Discord channels.
- Cards appear when controllers tune in and turn grey when they disconnect.
- Coverage rosters, reconnect grace and durable retries keep updates useful.
- Optional approval reminders follow your privately configured policy.

![Illustrative online and offline session cards; no real member data.](assets/session-preview.svg)

## Get started

**Bring your airspace into Discord.** Use the guided setup in your browser — no local Node.js installation needed.

1. **Create your bot.** [Create a Discord application](https://discord.com/developers/applications) and invite its bot with the [required permissions](docs/setup.md#guided-deployment).
2. **Deploy to Cloudflare.** Use the button below to copy the project into your own account and create its storage.
3. **Choose your airspace.** Enter your bot token, channel IDs, callsign prefixes and a polling secret, then deploy.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/EMOEMOJAI/onfreq)

The first poll quietly records existing connections; new connections then appear as cards. You host and control your own installation.

**[Follow the setup guide →](docs/setup.md#guided-deployment)** · [CLI setup](docs/setup.md#manual-deployment-and-upgrades) · [Optional features](docs/setup.md#optional-settings)

Public delivery is at least once; retries can occasionally produce duplicate cards.

## Contribute

**Help make the next session better.** Bug reports, feature ideas and feedback on setup are welcome.

**[Report a bug](https://github.com/EMOEMOJAI/onfreq/issues/new?template=bug.yml)** · **[Suggest an idea](https://github.com/EMOEMOJAI/onfreq/issues/new?template=feature.yml)** · [Report a security issue privately](SECURITY.md)

Share a small, anonymized example so others can reproduce the problem. Maintainer changes go directly to main after checks; please do not open pull requests.

Working on the code? Start with [AGENTS.md](AGENTS.md) for the source map and checks. AI tools can use the [documentation index](llms.txt); shared instructions also have entry points for Claude, Gemini and GitHub Copilot.

[Security & privacy](SECURITY.md) · [MIT license](LICENSE)

Community-built; not an official IVAO or Discord product.
