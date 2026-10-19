# shellcheck shell=sh
# Sourced by scripts/hooks/pre-commit and pre-push from the repository root.
#
# gitleaks_settings_guard <hook> <Commit|Stage> <push|commit>
# Gitleaks reads .gitleaks.toml and .gitleaksignore from the current directory
# even when untracked or ignored, and GITLEAKS_CONFIG* variables would replace
# the repository's rules, for example with an empty rule set. The scan must use
# only the reviewed configuration: the variables are dropped and untracked,
# ignored or unstaged settings block the hook.
gitleaks_settings_guard() {
  unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML
  for gitleaks_file in .gitleaks.toml .gitleaksignore; do
    if { [ -e "$gitleaks_file" ] || [ -L "$gitleaks_file" ]; } &&
      ! git ls-files --error-unmatch -- "$gitleaks_file" >/dev/null 2>&1; then
      printf '%s: BLOCKED — untracked or ignored %s would change the secret scan.\n' "$1" "$gitleaks_file" >&2
      printf '%s or remove it, then %s.\n' "$2" "$3" >&2
      return 1
    fi
  done
  if ! git diff --quiet --no-ext-diff --no-textconv -- .gitleaks.toml .gitleaksignore; then
    printf '%s: BLOCKED — unstaged changes to Gitleaks settings would change the secret scan.\n' "$1" >&2
    printf '%s, stash or discard them, then %s.\n' "$2" "$3" >&2
    return 1
  fi
}

# The Gitleaks version CI installs; must match .github/actions/install-gitleaks/action.yml.
gitleaks_pinned_version=8.30.1

# gitleaks_version_notice <hook>
# Rules and defaults change between Gitleaks releases, so a different local
# version can pass what CI blocks, or the reverse. Warns only; never blocks.
gitleaks_version_notice() {
  gitleaks_version=$(gitleaks version </dev/null 2>/dev/null) || gitleaks_version=
  gitleaks_version=$(printf '%s\n' "$gitleaks_version" | sed -n '1{s/[[:space:]]//g;s/^v//;p;}') ||
    gitleaks_version=
  if [ "$gitleaks_version" != "$gitleaks_pinned_version" ]; then
    printf '%s: warning — Gitleaks %s is not the %s CI uses; local scan results may differ.\n' \
      "$1" "${gitleaks_version:-unknown}" "$gitleaks_pinned_version" >&2
  fi
  return 0
}
