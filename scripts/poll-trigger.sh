#!/bin/zsh
# Drives the bot's poll endpoint. Intended to be run once a minute by
# the launchd agent in com.onfreq.poll.plist, standing in for Cloudflare's
# cron trigger.
#
# The secret lives in a separate 0600 file rather than in this script or in
# the plist, so it never shows up in `ps` output or in a world-readable file.
#
# Save your deployment's /poll URL in ~/.onfreq/poll-endpoint. An exported
# POLL_ENDPOINT overrides that file for manual runs. `wrangler deploy` prints
# the deployment URL; launchd does not inherit your terminal's environment.

set -u

BASE_DIR="${HOME}/.onfreq"
SECRET_FILE="${BASE_DIR}/poll-secret"
LOG_FILE="${HOME}/Library/Logs/onfreq-poll.log"
ENDPOINT="${POLL_ENDPOINT:-}"
MAX_LOG_LINES=1000

log() {
  print -r -- "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $1" >> "${LOG_FILE}"
}

if [[ -z "${ENDPOINT}" && -r "${BASE_DIR}/poll-endpoint" ]]; then
  ENDPOINT="$(< "${BASE_DIR}/poll-endpoint")"
fi

# Refuse unset/template URLs and plaintext endpoints before reading the secret.
if [[ ! "${ENDPOINT}" =~ '^https://[^/[:space:]<>]+(/[^[:space:]<>]*)?$' ]]; then
  log "FATAL set an HTTPS /poll URL in ~/.onfreq/poll-endpoint or POLL_ENDPOINT"
  exit 1
fi

if [[ ! -r "${SECRET_FILE}" ]]; then
  log "FATAL missing or unreadable secret file: ${SECRET_FILE}"
  exit 1
fi

SECRET="$(< "${SECRET_FILE}")"
SECRET="${SECRET//[$'\t\r\n ']/}"

if [[ -z "${SECRET}" ]]; then
  log "FATAL secret file is empty: ${SECRET_FILE}"
  exit 1
fi

# --max-time bounds the whole call; the poll itself takes ~2s. The secret is
# passed on stdin via @- so it never appears in the process list.
RESPONSE="$(printf 'authorization: Bearer %s' "${SECRET}" \
  | curl -sS --proto '=https' --max-time 30 -X POST "${ENDPOINT}" -H @- -w '\n%{http_code}' 2>&1)"
STATUS="${RESPONSE##*$'\n'}"
BODY="${RESPONSE%$'\n'*}"

if [[ "${STATUS}" == "200" ]]; then
  log "ok   ${BODY}"
else
  # Non-200 covers an unreachable network, a rejected secret (401) and a
  # failed poll (500) alike — the body says which.
  log "FAIL http=${STATUS} ${BODY}"
fi

# Keep the log from growing without bound.
if [[ -f "${LOG_FILE}" ]]; then
  LINES=$(wc -l < "${LOG_FILE}")
  if (( LINES > MAX_LOG_LINES )); then
    tail -n $(( MAX_LOG_LINES / 2 )) "${LOG_FILE}" > "${LOG_FILE}.tmp" \
      && mv "${LOG_FILE}.tmp" "${LOG_FILE}"
  fi
fi
