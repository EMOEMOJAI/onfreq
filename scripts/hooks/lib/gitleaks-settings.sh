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
