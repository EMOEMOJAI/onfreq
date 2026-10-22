# The stream filter that scripts/secret-scan.sh and scripts/hooks/pre-commit
# both run between their sed stage and Gitleaks. Run it with LC_ALL=C, so
# lengths are bytes, on input without NUL bytes (awk can cut a line at one); the
# scans replace them with spaces first. POSIX awk only: macOS and Linux CI run it.
#
# Gitleaks reads its input in chunks and ends each one at the first blank line
# after a read, looking at most 25 000 bytes ahead; reads from a pipe often
# return only a few KiB. So every line is printed followed by a blank line, and
# a line of up to about 25 000 bytes reaches Gitleaks whole.
#
# Runs are the exception: a multi-line private key, from a line with -----BEGIN
# and then PRIVATE KEY but no -----END, to the next line holding -----END,
# KEY----- or KEY BLOCK-----; and a curl command continued with a backslash at
# the end of a line (before an optional CR), to the first line without one.
# Inside a run no blank line is added, so Gitleaks never ends a chunk inside it
# and CRLF continuations stay matchable. A run ends with a blank line at its
# end, at end of input, once it holds 16 384 bytes, and before a line longer
# than 1 024 bytes, a diff --git or commit line, or a new key's BEGIN line; so
# no stretch without a blank line in a run exceeds 17 409 bytes.
#
# Known limits: a line longer than about 25 KB can be cut where a chunk ends; a
# blank line inside a key, such as a PGP armor header gap in a commit message,
# ends a chunk there; a key spread over several hunks is not one run; and
# rules that match across lines, such as kubernetes-secret-yaml, see the added
# blank lines (each costs a byte of their windows).

function starts_key(upper, begin) {
  begin = index(upper, "-----BEGIN")
  return begin > 0 && index(substr(upper, begin), "PRIVATE KEY") > 0 && index(upper, "-----END") == 0
}
function ends_key(upper) {
  return index(upper, "-----END") > 0 || index(upper, "KEY-----") > 0 || index(upper, "KEY BLOCK-----") > 0
}
function continues(line, n, last) {
  n = length(line)
  last = substr(line, n, 1)
  if (n > 0 && last == "\r") { n--; last = substr(line, n, 1) }
  return n > 0 && last == "\\"
}
function stop() {
  print ""
  run = 0
}

{
  n = length($0)
  upper = toupper($0)
  if (run && (n > 1024 || /^diff --git / || /^commit [0-9a-f]+( |$)/ || starts_key(upper))) stop()
  if (run) {
    print
    bytes += n + 1
    if (key && ends_key(upper)) key = 0
    if (bytes >= 16384 || (!key && !continues($0))) stop()
    next
  }
  if (n <= 1024 && (starts_key(upper) || continues($0))) {
    run = 1
    key = starts_key(upper)
    bytes = n + 1
    print
    next
  }
  print
  print ""
}

END {
  if (run) print ""
}
