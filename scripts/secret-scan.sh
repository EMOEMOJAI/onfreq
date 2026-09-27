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
# --encoding=UTF-8 overrides i18n.logOutputEncoding, so commit messages are
# always emitted in an ASCII-compatible encoding for the scanner. Gitleaks
# redacts findings.
#
# Exit status: 0 clean; 1 Gitleaks found a secret or failed; 2 the commits
# could not be read. POSIX sh has no pipefail, so a failed Git or filter stage
# leaves a marker file instead. A Gitleaks that exits before reading all its
# input, for example on a bad configuration, can make those stages fail on the
# closed pipe, so when both fail the message names both causes; the status is
# still 2.
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

status=0
{ git log --pretty=medium --encoding=UTF-8 -p -U0 --inter-hunk-context=0 --root --no-ext-diff --no-textconv --text --no-color --diff-merges=separate "$@" -- </dev/null ||
    : >"$tmp/failed"; } |
  { LC_ALL=C sed -e '/^-/d' -e 's/^\(@@ -[0-9][0-9,]* +[0-9][0-9,]* @@\).*/\1/' || : >"$tmp/failed"; } |
  gitleaks stdin --redact --no-banner || status=$?
if [ -e "$tmp/failed" ]; then
  if [ "$status" != 0 ]; then
    printf 'secret-scan: the secret scan failed or could not read the commits; see the output above.\n' >&2
  else
    printf 'secret-scan: could not read the commits to scan.\n' >&2
  fi
  exit 2
fi
if [ "$status" != 0 ]; then exit 1; fi
exit 0
