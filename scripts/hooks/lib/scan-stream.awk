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
# A longer line could be cut where a chunk ends, so a line over 20 000 bytes
# (counting the diff's + or the message indent, and any CR) fails the scan: it
# is still printed, and at the end the filter names its length and where it is
# (the diff --git header's path or the commit message, and the last commit
# line's commit), never its content, on standard error and exits 3. The scans
# then block, naming any Gitleaks failure too; no inline allow comment passes
# it. Git C-quotes control characters in paths, so none reach the terminal raw.
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
# Gitleaks skips a finding whose lines hold its inline allow marker (gitleaks,
# a colon, allow), and a finding can start in a header line: an author name
# can open a private key that the message completes, and a path can hold a
# whole secret. So in header lines, from a commit or diff --git line to the
# next empty or @@ line, the marker becomes the same-length gitleaks-allow;
# added (+) lines and the indented message keep it, so an inline allow comment
# there still works. The marker is built at run time, so this file does not
# hold it and is not named by the pre-push allow-marker note.
#
# Known limits: a blank line inside a key, such as a PGP armor header gap in a
# commit message, ends a chunk there; a key spread over several hunks is not
# one run; and rules that match across lines, such as kubernetes-secret-yaml,
# see the added blank lines (each costs a byte of their windows). Git's --text
# shows a binary file as text, so an uncompressed binary with over 20 000
# bytes between newlines fails the scan; compressed formats rarely do. A long
# line that reaches published history fails every later history scan, CI's
# included, until that history is rewritten: the scan fails closed.

BEGIN { allow_marker = "gitleaks" ":" "allow" }

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
# Where the current line is: a file named by the last diff --git header, or the
# commit message after a commit line, with that commit when there is one.
function source(where) {
  where = path == "" ? "the commit message" : "file " path
  return commit == "" ? where : where " of commit " commit
}
# The path of a diff --git header: "a/P b/P", quoted or not, gives P; other
# headers, such as renames, give both names. Over-long names are not printed.
function header_path(rest, half, first, second) {
  if (length(rest) > 4096) return "(a path over 4 096 bytes)"
  half = (length(rest) - 1) / 2
  first = substr(rest, 1, half)
  second = substr(rest, half + 2)
  if (half == int(half) && substr(rest, half + 1, 1) == " ") {
    if (substr(first, 1, 2) == "a/" && substr(second, 1, 2) == "b/" && substr(first, 3) == substr(second, 3)) return substr(first, 3)
    if (substr(first, 1, 3) == "\"a/" && substr(second, 1, 3) == "\"b/" && substr(first, 4) == substr(second, 4)) return "\"" substr(first, 4)
  }
  return rest
}

{
  n = length($0)
  if (/^commit [0-9a-f]+( |$)/) {
    commit = $2
    path = ""
    header = 1
  } else if (/^diff --git /) {
    path = header_path(substr($0, 12))
    header = 1
  } else if ($0 == "" || /^@@ /) header = 0
  if (header) gsub(allow_marker, "gitleaks-allow")
  if (n > 20000 && !long++) {
    long_bytes = n
    long_source = source()
  }
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
  if (long) {
    printf("scan-stream: a line of %d bytes in %s is over 20 000 bytes, which the secret scan cannot read whole.\n", long_bytes, long_source) > "/dev/stderr"
    if (long > 1) printf("scan-stream: lines over 20 000 bytes in all: %d.\n", long) > "/dev/stderr"
    exit 3
  }
}
