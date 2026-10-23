#!/bin/sh
# Scans the literal bytes that commits add with Gitleaks; used by the pre-push
# hook and CI. Arguments are `git log` revision arguments: HEAD in CI, or the
# pushed range from `node scripts/check-privacy.mjs --range-args` in the hook.
#
# Merges are diffed against each parent, so content only a merge resolution
# adds is scanned; --diff-merges=separate, unlike -m, ignores the log.diffMerges
# setting, which could turn merge diffs off. External diff drivers, textconv
# filters and binary or -diff attributes cannot hide content. Removed lines, and
# the existing line Git appends to each hunk header (@@ -2 +2 @@ <line>), are
# dropped, so removing content or editing below it does not re-flag what is
# already published; --inter-hunk-context=0 keeps diff.interHunkContext from
# merging nearby hunks, which would add existing lines back as context. Added
# lines start with "+", and --pretty=medium, which overrides format.pretty,
# prints every commit message line indented, so the filters never drop them.
# --encoding=none overrides i18n.logOutputEncoding and the commit's own encoding
# header, so commit messages are emitted as their stored bytes; re-encoding, for
# example from a UTF-16 header, could turn an ASCII key into other characters.
# Git refuses NUL in messages, so the stored bytes are ASCII-compatible for the
# scanner. Gitleaks redacts findings.
#
# Gitleaks reads its input in chunks of up to 100 KB, extending each by at most
# 25 KB to a blank line, and skips the whole input when the first chunk looks
# like a binary or archive file. A fixed plain preamble of 36 000 bytes that
# matches no rule comes first, so no file-type signature (the furthest, ISO
# 9660's, ends at byte 32 773) can fall on commit content. NUL bytes become
# spaces, and the shared filter scripts/hooks/lib/scan-stream.awk adds a blank
# line after every line except inside a multi-line private key or a curl
# command continued with backslashes, so each chunk ends at the end of a line
# and such runs stay in one chunk. A line over 20 000 bytes could still be cut
# between chunks, so the filter exits 3 for one and the scan fails.
# scripts/hooks/pre-commit runs the same stages; the filter lists the known
# limits.
#
# Exit status: 0 clean; 1 Gitleaks found a secret or failed; 2 the commits
# could not be read, or add a line over 20 000 bytes. POSIX sh has no pipefail,
# so each failed Git or filter stage leaves a marker file instead, and the
# filter's exit 3 a separate one. A Gitleaks that exits before reading all its
# input, for example on a bad configuration, can make those stages fail on the
# closed pipe, so when both fail the message names both causes, as it does for
# a long line and a failed scan; the status is still 2.
set -eu
# The GITLEAKS_CONFIG* variables would replace the repository's Gitleaks rules,
# for example with an empty rule set; the scan uses only the reviewed
# configuration. GIT_DIFF_OPTS would override -U0 and add existing lines back as
# context.
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML GIT_DIFF_OPTS

if [ "$#" = 0 ]; then
  printf 'Usage: secret-scan.sh <git log revision>...\n' >&2
  exit 2
fi
if ! tmp=$(mktemp -d); then
  printf 'secret-scan: could not create a temporary directory.\n' >&2
  exit 2
fi
trap 'rm -rf "$tmp"' EXIT
trap 'exit 2' HUP INT TERM
filter=$(dirname -- "$0")/hooks/lib/scan-stream.awk
if [ ! -r "$filter" ]; then
  printf 'secret-scan: missing the stream filter %s.\n' "$filter" >&2
  exit 2
fi

preamble() { LC_ALL=C awk 'BEGIN { for (i = 0; i < 1200; i++) print "# onfreq secret-scan preamble" }' </dev/null; }
status=0
{ { preamble &&
    git log --pretty=medium --encoding=none -p -U0 --inter-hunk-context=0 --root --no-ext-diff --no-textconv --text --no-color --diff-merges=separate "$@" -- </dev/null; } ||
    : >"$tmp/failed"; } |
  { LC_ALL=C sed -e '/^-/d' -e 's/^\(@@ -[0-9][0-9,]* +[0-9][0-9,]* @@\).*/\1/' || : >"$tmp/failed"; } |
  { LC_ALL=C tr '\000' ' ' || : >"$tmp/failed"; } |
  { LC_ALL=C awk -f "$filter" || case $? in (3) : >"$tmp/long" ;; (*) : >"$tmp/failed" ;; esac; } |
  gitleaks stdin --redact --no-banner || status=$?
if [ -e "$tmp/long" ]; then
  printf 'secret-scan: the secret scan cannot read lines over 20 000 bytes whole; split the line into shorter lines.\n' >&2
fi
if [ -e "$tmp/failed" ]; then
  if [ "$status" != 0 ]; then
    printf 'secret-scan: the secret scan failed or could not read the commits; see the output above.\n' >&2
  else
    printf 'secret-scan: could not read the commits to scan.\n' >&2
  fi
  exit 2
fi
if [ -e "$tmp/long" ]; then
  if [ "$status" != 0 ]; then
    printf 'secret-scan: the secret scan also failed or found a secret; see the output above.\n' >&2
  fi
  exit 2
fi
if [ "$status" != 0 ]; then exit 1; fi
exit 0
