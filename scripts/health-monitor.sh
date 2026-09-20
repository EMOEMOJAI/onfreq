#!/bin/sh
# Independent, read-only monitor. Never triggers /poll or logs response bodies.
set -eu
umask 077

monitor_dir=${ONFREQ_MONITOR_DIR:-"$HOME/.onfreq"}
monitor_log=${ONFREQ_MONITOR_LOG:-"$HOME/Library/Logs/onfreq-health.log"}
mkdir -p "$monitor_dir" "$(dirname "$monitor_log")"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$monitor_log"
  if [ "$(wc -l < "$monitor_log")" -gt 1000 ]; then
    tail -n 500 "$monitor_log" > "$monitor_log.tmp"
    mv "$monitor_log.tmp" "$monitor_log"
  fi
}

health_state=failed
reason=configuration
endpoint=$(cat "$monitor_dir/poll-endpoint" 2>/dev/null || true)
secret=$(cat "$monitor_dir/poll-secret" 2>/dev/null || true)

# Require a literal HTTPS URL ending in /poll; reject userinfo, query strings,
# whitespace and curl URL globbing characters. Secrets travel only over stdin.
valid=true
case "$endpoint" in https://*/poll) ;; *) valid=false ;; esac
authority=${endpoint#https://}
authority=${authority%/poll}
case "$authority" in ''|*[!A-Za-z0-9.:-]*) valid=false ;; esac
case "$secret" in ''|*[!A-Za-z0-9._~-]*) valid=false ;; esac
if [ "$valid" = true ]; then
  code=$(printf 'authorization: Bearer %s\n' "$secret" |
    curl -q --silent --globoff --proto '=https' --connect-timeout 10 --max-time 20 \
      --output /dev/null --write-out '%{http_code}' --header @- "${endpoint%/poll}/health" 2>/dev/null) || code=000
  if [ "$code" = 200 ]; then
    health_state=healthy
    reason=fresh
  else
    # The response body and URL may contain private data; neither is logged.
    reason=unavailable-or-stale
  fi
fi
unset secret

previous=unknown
last_notice=0
if [ -r "$monitor_dir/health-monitor-state" ]; then
  read -r previous last_notice < "$monitor_dir/health-monitor-state" || true
fi
case "$last_notice" in ''|*[!0-9]*) last_notice=0 ;; esac
now=$(date +%s)
notify=false
if [ "$health_state" = failed ]; then
  if [ "$previous" != failed ] || [ "$last_notice" -eq 0 ] || [ "$((now - last_notice))" -ge 3600 ]; then
    notify=true
  fi
elif [ "$previous" = failed ]; then
  notify=true
fi

saved_state=$health_state
if [ "$notify" = true ]; then
  if [ "$health_state" = healthy ]; then
    notice='display notification "Polling is healthy again." with title "onfreq recovered"'
  else
    notice='display notification "No recent successful poll could be verified. Check onfreq and your network." with title "onfreq needs attention"'
  fi
  if osascript -e "$notice" >/dev/null 2>&1; then
    last_notice=$now
  else
    log 'notification-failed: check macOS notification permissions'
    last_notice=0
    # Retry an undelivered recovery notice on the next healthy check too.
    if [ "$health_state" = healthy ] && [ "$previous" = failed ]; then saved_state=failed; fi
  fi
fi
printf '%s %s\n' "$saved_state" "$last_notice" > "$monitor_dir/health-monitor-state.tmp"
mv "$monitor_dir/health-monitor-state.tmp" "$monitor_dir/health-monitor-state"
log "$health_state $reason"
[ "$health_state" = healthy ]
