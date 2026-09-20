#!/bin/sh
# Optional launchd fallback. Never logs credentials, URLs or response bodies.
set -eu
umask 077

poll_dir=${ONFREQ_POLL_DIR:-"$HOME/.onfreq"}
poll_log=${ONFREQ_POLL_LOG:-"$HOME/Library/Logs/onfreq-poll.log"}
mkdir -p "$(dirname "$poll_log")"
# Restrict an existing log too; umask only protects newly created files.
if [ -f "$poll_log" ]; then chmod 600 "$poll_log"; fi

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$poll_log"
  if [ "$(wc -l < "$poll_log")" -gt 1000 ]; then
    tail -n 500 "$poll_log" > "$poll_log.tmp"
    mv "$poll_log.tmp" "$poll_log"
  fi
}

endpoint=${POLL_ENDPOINT:-$(cat "$poll_dir/poll-endpoint" 2>/dev/null || true)}
secret=$(cat "$poll_dir/poll-secret" 2>/dev/null || true)

# Use the same literal URL and URL-safe token rules as the health monitor.
valid=true
case "$endpoint" in https://*/poll) ;; *) valid=false ;; esac
authority=${endpoint#https://}
authority=${authority%/poll}
case "$authority" in ''|*[!A-Za-z0-9.:-]*) valid=false ;; esac
case "$secret" in ''|*[!A-Za-z0-9._~-]*) valid=false ;; esac
if [ "$valid" != true ]; then
  log 'FAIL configuration'
  exit 1
fi

# -q must be first: ignore .curlrc, including verbose/trace/redirect settings.
# The credential travels on stdin; bodies and diagnostics are discarded.
code=$(printf 'authorization: Bearer %s\n' "$secret" |
  curl -q --silent --globoff --proto '=https' --connect-timeout 10 --max-time 30 \
    --request POST --output /dev/null --write-out '%{http_code}' \
    --header @- "$endpoint" 2>/dev/null) || code=000
unset secret
case "$code" in [0-9][0-9][0-9]) ;; *) code=000 ;; esac
if [ "$code" = 200 ]; then
  log 'ok http=200'
else
  log "FAIL http=$code"
  exit 1
fi
