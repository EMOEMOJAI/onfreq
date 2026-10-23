// Shared fixtures and helpers for the Git hook tests (scripts/test-hooks*.mjs),
// moved unchanged from scripts/test-hooks.mjs so the real-Gitleaks tests can
// run in parallel processes. This name does not match scripts/test-*.mjs, so
// node --test never runs it as a test file.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { isolatedEnv } from './check-setup.mjs';

const hook = fileURLToPath(new URL('./hooks/pre-push', import.meta.url));
const hooksDir = fileURLToPath(new URL('./hooks', import.meta.url));
const preCommit = fileURLToPath(new URL('./hooks/pre-commit', import.meta.url));
const zero = '0'.repeat(40);
const hookHelpers = ['check-privacy.mjs', 'repo-files.mjs', 'secret-scan.sh', 'hooks/lib/gitleaks-settings.sh',
  'hooks/lib/scan-stream.awk'];
const hasGitleaks = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;
// Locally a missing Gitleaks skips the real-scan tests; in CI they run and fail.
const gitleaksSkip = !hasGitleaks && !process.env.CI && 'gitleaks is not installed';
// A synthetic AWS-format key assembled at runtime, so this file never contains it.
const syntheticKey = () => ['AKIA', 'Q7RZ', 'LX2M', 'NB4K', 'TWPJ'].join('');
// Gitleaks' inline allow marker, assembled at runtime so this file's lines do not carry it.
const allowMarker = ['gitleaks', 'allow'].join(':');

// A synthetic repository with fake npm and gitleaks commands that record their
// arguments (and, for gitleaks, the commits in the scanned log), so the hook's ref
// and index gating is tested without running the real checks. The hooks' own
// helpers (range arguments, secret scan, Gitleaks settings guard) are copied in
// and committed, as the hooks run them from the repository root. With realRange,
// npm range checks run the real check-privacy.mjs too; gitleaks: 'real' uses the
// installed Gitleaks, 'missing' none. The fake answers `gitleaks version` without
// logging: 8.30.1, FAKE_GITLEAKS_VERSION, or a failure with FAKE_GITLEAKS_VERSION_FAIL.
// With GITLEAKS_STDIN set, the fake also saves the stream it read to that file.
// Global and system Git configuration are ignored so the scanned log format is
// predictable.
function fixture(t, { npmExit = 0, realRange = false, gitleaks = 'fake', gitleaksExit = 0 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-hooks-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  const env = isolatedEnv({ PATH: `${bin}:${process.env.PATH}`, NPM_LOG: join(dir, 'npm.log'), NPM_EXIT: String(npmExit),
    GITLEAKS_LOG: join(dir, 'gitleaks.log'), GITLEAKS_EXIT: String(gitleaksExit),
    NODE: process.execPath, REAL_RANGE: realRange ? '1' : '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  for (const path of [repo, bin, join(repo, 'scripts/hooks/lib')]) mkdirSync(path, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'npm'), `#!/bin/sh
printf '%s\\n' "$*" >> "$NPM_LOG"
if [ -n "$REAL_RANGE" ] && [ "$3" = check:privacy ] && [ "\${5:-}" = --range ]; then
  shift 4
  exec "$NODE" scripts/check-privacy.mjs "$@"
fi
exit "$NPM_EXIT"
`, { mode: 0o700 });
  if (gitleaks === 'fake') {
    writeFileSync(join(bin, 'gitleaks'), `#!/bin/sh
if [ "\${1:-}" = version ]; then
  if [ -n "\${FAKE_GITLEAKS_VERSION_FAIL:-}" ]; then exit 1; fi
  printf '%s\\n' "\${FAKE_GITLEAKS_VERSION:-8.30.1}"
  exit 0
fi
printf '[%s]' "$@" >> "$GITLEAKS_LOG"
printf '\\n' >> "$GITLEAKS_LOG"
if [ -n "\${GITLEAKS_CONFIG+x}\${GITLEAKS_CONFIG_TOML+x}" ]; then printf 'config variable set\\n' >> "$GITLEAKS_LOG"; fi
if [ -n "\${GITLEAKS_STDIN:-}" ]; then tee "$GITLEAKS_STDIN"; else cat; fi |
  sed -n 's/^commit \\([0-9a-f]\\{40\\}\\).*/\\1/p' >> "$GITLEAKS_LOG"
if [ "$GITLEAKS_EXIT" != 0 ]; then printf 'synthetic finding: REDACTED\\n' >&2; fi
exit "$GITLEAKS_EXIT"
`, { mode: 0o700 });
  }
  // The hook checks for Gitleaks before running Git or npm, so only the fake npm is needed.
  const hookEnv = gitleaks === 'missing' ? { ...env, PATH: bin } : env;
  const email = realRange ? 'synthetic@users.noreply.github.com' : 'synthetic@example.test';
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', `user.email=${email}`,
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args[0]} failed`);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repo, 'public.txt'), 'first\n');
  writeFileSync(join(repo, 'package.json'), '{ "private": true }\n');
  for (const name of hookHelpers) copyFileSync(new URL(`./${name}`, import.meta.url), join(repo, 'scripts', name));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(repo, 'node_modules'));
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git('add', '.');
  git('commit', '--quiet', '--no-verify', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'public.txt'), 'second\n');
  git('commit', '--quiet', '--no-verify', '-am', 'second');
  const head = git('rev-parse', 'HEAD');
  return {
    first, head, git, repo,
    push(lines, args = ['origin', 'https://example.test/synthetic.git'], extraEnv = {}) {
      rmSync(env.NPM_LOG, { force: true });
      rmSync(env.GITLEAKS_LOG, { force: true });
      const result = spawnSync('/bin/sh', [hook, ...args],
        { cwd: repo, env: { ...hookEnv, ...extraEnv }, input: lines.join('\n'), encoding: 'utf8' });
      const log = (file) => existsSync(file) ? readFileSync(file, 'utf8') : '';
      return { ...result, npm: log(env.NPM_LOG), gitleaks: log(env.GITLEAKS_LOG) };
    },
    // Runs a pre-commit hook script directly, or with commit: true runs a real
    // `git commit` with the versioned hooks directory installed.
    commitHook({ extraEnv = {}, path = preCommit, commit = false } = {}) {
      rmSync(env.GITLEAKS_LOG, { force: true });
      const options = { cwd: repo, env: { ...hookEnv, ...extraEnv }, encoding: 'utf8' };
      const result = commit
        ? spawnSync('git', ['-c', 'user.name=Synthetic', '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false',
          '-c', `core.hooksPath=${hooksDir}`, 'commit', '--quiet', '-m', 'hooked commit'], options)
        : spawnSync('/bin/sh', [path], options);
      return { ...result, gitleaks: existsSync(env.GITLEAKS_LOG) ? readFileSync(env.GITLEAKS_LOG, 'utf8') : '' };
    },
    // Runs scripts/secret-scan.sh with `git log` arguments, as CI and pre-push do.
    scan(args, extraEnv = {}) {
      rmSync(env.GITLEAKS_LOG, { force: true });
      return spawnSync('/bin/sh', ['scripts/secret-scan.sh', ...args],
        { cwd: repo, env: { ...hookEnv, ...extraEnv }, encoding: 'utf8' });
    },
  };
}

// A merge whose own resolution adds the key; no ordinary commit adds it. The
// key is then removed, so only the merge commit's diff contains it.
function mergeOnlySecret(f, token) {
  f.git('checkout', '--quiet', '-b', 'side');
  writeFileSync(join(f.repo, 'side.txt'), 'side\n');
  f.git('add', 'side.txt');
  f.git('commit', '--quiet', '--no-verify', '-m', 'side change');
  f.git('checkout', '--quiet', 'main');
  writeFileSync(join(f.repo, 'public.txt'), 'main\n');
  f.git('commit', '--quiet', '--no-verify', '-am', 'main change');
  f.git('merge', '--quiet', '--no-ff', '--no-commit', 'side');
  writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token}\n`);
  f.git('add', 'config.txt');
  f.git('commit', '--quiet', '--no-verify', '-m', 'merge side');
  const merge = f.git('rev-parse', 'HEAD');
  f.git('rm', '--quiet', 'config.txt');
  f.git('commit', '--quiet', '--no-verify', '-m', 'remove synthetic secret');
  return { merge, head: f.git('rev-parse', 'HEAD') };
}

const ref = (oid, name = 'refs/heads/main', remote = zero) => `${name} ${oid} ${name} ${remote}\n`;
const checks = 'run --silent check:privacy\nrun --silent check:setup\n';
const rangeCheck = (head, remote = zero, name = 'origin') => `run --silent check:privacy -- --range ${head} ${remote} ${name}\n`;
// One fake Gitleaks run over the piped log: its arguments, then the scanned commits.
const leakScan = (...commits) => `[stdin][--redact][--no-banner]\n${commits.map((c) => `${c}\n`).join('')}`;
// The pre-push note naming pushed commits that change Gitleaks settings or carry
// gitleaks:allow; the note does not block the push.
const gitleaksNote = (hashes) => new RegExp(`^pre-push: note — pushed commits change Gitleaks settings or gitleaks:allow lines, or carry gitleaks:allow in a message, author or path \\(${hashes}\\); the scan applies the settings and markers on added lines and in messages, not in author names, emails or paths, so review those commits\\.$`, 'm');

// Stages a synthetic key in the fixture repository.
function stageSyntheticKey(f) {
  const token = syntheticKey();
  writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token}\n`);
  f.git('add', 'config.txt');
  return token;
}

// T1-5: the repository's own Gitleaks rule for its secret names. Assignments are
// assembled at runtime, so this file never contains one.
const repoRules = () => readFileSync(new URL('../.gitleaks.toml', import.meta.url));
const assignment = (name, value) => `${name}="${value}"\n`;
function commitRules(f, rules) {
  writeFileSync(join(f.repo, '.gitleaks.toml'), rules);
  f.git('add', '.gitleaks.toml');
  f.git('commit', '--quiet', '--no-verify', '-m', 'gitleaks rules');
}
// Stages `text` and returns the pre-commit results (direct and as git commit),
// then commits it without the hook and returns the scan of that commit alone.
function scanAssignment(f, text) {
  writeFileSync(join(f.repo, 'settings.env'), text);
  f.git('add', 'settings.env');
  const hook = [f.commitHook(), f.commitHook({ commit: true })];
  // A passing hook already committed the file, so this commit may be empty: scan the commit that added it.
  f.git('commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'synthetic settings');
  const added = f.git('log', '-1', '--format=%H', '--', 'settings.env');
  const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const scan = spawnSync('/bin/sh', ['scripts/secret-scan.sh', `${added}^!`], { cwd: f.repo, env, encoding: 'utf8' });
  f.git('rm', '--quiet', 'settings.env');
  f.git('commit', '--quiet', '--no-verify', '-m', 'remove synthetic settings');
  return { hook, scan };
}

// ROT-1: operator Discord IDs and private JSON settings. Values are built at
// runtime so this file never holds an assignment the rules would flag.
const realShaped = ['7341258963', '14752089'].join('');
const otherReal = ['8862014473', '20518630'].join('');

// NX-1c: multi-line private JSON literals and deployment settings in dotenv or
// shell lines. Setting names are joined at runtime, so this file never holds a
// line the rules would flag. Prefixes that must be flagged start with J, which
// no ICAO region uses, so no real region appears here.
const firPrefixes = ['FIR', 'PREFIXES'].join('_');
const coordinatorName = ['COORDINATOR', 'NAME'].join('_');

// NX-2c: the first line of a pretty-printed private JSON literal. Every flagged
// line is assembled at runtime from a joined setting name, so this file never
// holds one; the lines that must pass are written out.
const jsonName = (...parts) => parts.join('_');

// RA: Gitleaks skips its whole input when the first chunk looks like a binary
// or archive format, and reads in chunks that it extends by at most 25 KB to a
// blank line, so a line could be cut in two. The scans feed it a preamble first
// and, through scripts/hooks/lib/scan-stream.awk, a blank line after every line
// outside private key and curl continuation runs (NX3-S1).
const preamble = '# onfreq secret-scan preamble';
const preambleStream = `${preamble}\n\n`.repeat(1200);
// A model of scripts/hooks/lib/scan-stream.awk for ASCII input, after NUL bytes
// become spaces; see that file.
function scanFilter(text) {
  assert.ok(text === '' || text.endsWith('\n'), 'input ends with a newline');
  const startsKey = (upper) => {
    const begin = upper.indexOf('-----BEGIN');
    return begin >= 0 && upper.includes('PRIVATE KEY', begin) && !upper.includes('-----END');
  };
  const endsKey = (upper) => ['-----END', 'KEY-----', 'KEY BLOCK-----'].some((end) => upper.includes(end));
  const continues = (line) => /\\\r?$/.test(line);
  const out = [];
  let run = false, key = false, bytes = 0, header = false;
  const stop = () => { out.push(''); run = false; };
  for (let line of text.replaceAll('\0', ' ').split('\n').slice(0, -1)) {
    // Commit and diff header lines lose the allow marker (NX-7 #11).
    if (/^commit [0-9a-f]+( |$)/.test(line) || /^diff --git /.test(line)) header = true;
    else if (line === '' || /^@@ /.test(line)) header = false;
    if (header) line = line.replaceAll(allowMarker, 'gitleaks-allow');
    const upper = line.toUpperCase();
    if (run && (line.length > 1024 || /^diff --git /.test(line) || /^commit [0-9a-f]+( |$)/.test(line) || startsKey(upper))) stop();
    if (run) {
      out.push(line);
      bytes += line.length + 1;
      if (key && endsKey(upper)) key = false;
      if (bytes >= 16384 || (!key && !continues(line))) stop();
    } else if (line.length <= 1024 && (startsKey(upper) || continues(line))) {
      run = true;
      key = startsKey(upper);
      bytes = line.length + 1;
      out.push(line);
    } else {
      out.push(line, '');
    }
  }
  if (run) out.push('');
  return out.map((line) => `${line}\n`).join('');
}
// `input` is the stream the scans' Git and sed stages produce; Gitleaks must
// read exactly the preamble and the model's output for it.
function assertScanStream(stream, label, input) {
  // Past the furthest bytes a file-type signature uses (ISO 9660's, 32 769-32 773).
  const content = stream.search(new RegExp(`^(?!${preamble}$).+$`, 'm'));
  assert.ok(content >= 33000, `${label}: content starts at ${content}`);
  assert.ok(stream === preambleStream + scanFilter(input), `${label}: stream differs from the filter model`);
}

const gitEnv = () => isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
// The stream the scans' Git and sed stages produce, before the preamble and
// blank lines: removed lines are dropped and hunk headers end at the second @@.
function filteredOutput(f, args) {
  const result = spawnSync('git', args, { cwd: f.repo, env: gitEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => !line.startsWith('-'))
    .map((line) => line.replace(/^(@@ -[0-9][0-9,]* \+[0-9][0-9,]* @@).*/, '$1')).join('\n');
}
const scanLogArgs = ['log', '--pretty=medium', '--no-show-signature', '--encoding=none', '-p', '-U0', '--inter-hunk-context=0', '--root',
  '--no-ext-diff', '--no-textconv', '--text', '--no-color', '--diff-merges=separate'];
const headStream = (f) => filteredOutput(f, [...scanLogArgs, '-1', 'HEAD', '--']);
const stagedStream = (f) => filteredOutput(f, ['diff', '--cached', '-U0', '--inter-hunk-context=0', '--no-ext-diff',
  '--no-textconv', '--no-color', '--text']);
// Calls write(pad), adjusting the pad until `marker` starts at `offset` in
// stream(); the text before the pad keeps its length, so one correction
// normally suffices.
function placeAt(offset, marker, write, stream) {
  let pad = 0;
  for (let step = 0; step < 4; step++) {
    write(pad);
    const at = stream().indexOf(marker);
    if (at === offset) return;
    pad += offset - at;
    assert.ok(at >= 0 && pad >= 0, `${marker} is past ${offset}`);
  }
  assert.fail(`could not place ${marker} at ${offset}`);
}
const secretScan = (f, ...args) => spawnSync('/bin/sh', ['scripts/secret-scan.sh', ...args],
  { cwd: f.repo, env: gitEnv(), encoding: 'utf8' });

// NX3-S1 (F1): Gitleaks ends each chunk at the first blank line after a read,
// and reads from a pipe often return a few KiB, so with a blank line after every
// line a multi-line private key was split between chunks and missed at some
// offsets. Keys are generated at test time and never stored.
let generatedKey;
const privateKeyPem = () => (generatedKey ??= generateKeyPairSync('rsa', { modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey);
// `x<n>` lines of at least `bytes` bytes in total.
function fillerLines(bytes) {
  const lines = [];
  for (let size = 0; size < bytes; size += lines.at(-1).length + 1) lines.push(`x${lines.length}`);
  return `${lines.join('\n')}\n`;
}
// Offsets where v2.2.5 missed the key, as its chunks ended inside it, then
// 256-byte steps over 4 KiB past 100 KB.
const keyOffsets = [18838, 26757, 42595, 50514, 58433, 66352, 121785, 185137, 296003,
  ...Array.from({ length: 16 }, (_, index) => 100000 + 256 * index)];

// Synthetic key material for the stream-shape checks, assembled at runtime.
const keyKind = ['RSA', 'PRIVATE', 'KEY'].join(' ');
const syntheticKeyLines = (count) => Array.from({ length: count }, () => randomBytes(48).toString('base64'));

// A DISCORD_CHANNEL_IDS line of `count` synthetic IDs with a real-shaped one third from the end.
function idListLine(count) {
  const ids = Array.from({ length: count }, (_, index) => String(900000000000000001n + BigInt(index)));
  ids.splice(-3, 0, realShaped);
  return assignment('DISCORD_CHANNEL_IDS', ids.join(','));
}

// NX5-L1: Gitleaks can cut a line over about 25 KB where a chunk ends, so the
// filter fails both scans for a line over 20 000 bytes, counting the diff's +
// or the message indent and any CR, as bytes. Each long line holds a random
// marker that no output may show.
const lineMarker = () => `m${randomBytes(8).toString('hex')}`;
const longLine = {
  hook: /^pre-commit: BLOCKED — the secret scan cannot read lines over 20 000 bytes whole; split the line into shorter lines\.$/m,
  scan: /^secret-scan: the secret scan cannot read lines over 20 000 bytes whole; split the line into shorter lines\.$/m,
};
const longFilter = (bytes, where) =>
  new RegExp(`^scan-stream: a line of ${bytes} bytes in ${where} is over 20 000 bytes, which the secret scan cannot read whole\\.$`, 'm');

// NX3-S2 (F7-F9): identifying settings. Setting names and flagged values are
// joined at runtime, so this file never holds a line the rules would flag; the
// lines that must pass are written out. Flagged callsigns use the unassigned J
// prefix, flagged hosts a random name under .org, and flagged client IDs a
// low-entropy value that the default rules miss.
const clientIdName = jsonName('IVAO', 'CLIENT', 'ID');
const callsignsName = jsonName('EXCLUDED', 'CALLSIGNS');
const policyUrlName = jsonName('GCA', 'POLICY', 'URL');
function identifyingCases() {
  const id = ['ab12', 'ab12', 'ab12'].join('');
  const tower = jsonName('JDDD', 'TWR');
  const centre = jsonName('JDDD', 'CTR');
  const host = `jddd-${randomBytes(3).toString('hex')}.org`;
  const policy = `https://${host}/gca`;
  const lower = (name) => name.toLowerCase();
  // [line, text the redacted output must not show, label]
  return [
    [`${clientIdName}="${id}"\n`, id, 'quoted client ID'],
    [`${clientIdName}=${id}\n`, id, 'unquoted client ID with a digit'],
    [`  ${clientIdName}: '${id}',\n`, id, 'client ID property'],
    [`"${clientIdName}": "${id}",\n`, id, 'client ID JSON key'],
    [`${lower(clientIdName)}=${id}\n`, id, 'lowercase client ID name'],
    [`${clientIdName}=' ${'abcd'.repeat(2)}'\n`, 'abcdabcd', 'quoted client ID without a digit, after a blank'],
    [`${clientIdName}='${['aaaa', 'test-client'].join('')}'\n`, 'aaaatest-client', 'client ID ending in the fixture'],
    [`${clientIdName}='${['test-client', '2'].join('-')}'\n`, 'test-client-2', 'client ID starting with the fixture'],
    [`${clientIdName}='${['synthetic', 'ab12.ab12'].join('-')}'\n`, 'ab12.ab12', 'synthetic prefix with a dot'],
    [`${clientIdName}=${['00000000', '0001'].join('-')}\n`, '0000-0001', 'nonzero client ID'],
    [`${callsignsName}="${centre}"\n`, centre, 'quoted callsign'],
    [`${callsignsName}=${centre},${tower}\n`, `${centre},${tower}`, 'unquoted callsign list'],
    [`  ${callsignsName}: 'QCXX_CTR, ${tower}',\n`, tower, 'mixed synthetic and real-shaped list'],
    [`${lower(callsignsName)}: '${lower(centre)}',\n`, lower(centre), 'lowercase name and callsign'],
    [`"${callsignsName}": "XA_SYN_CTR,${lower(tower)}"\n`, lower(tower), 'lowercase real-shaped item after a synthetic one'],
    [`${callsignsName}=' ${centre}'\n`, centre, 'callsign after a blank'],
    [`${callsignsName}=QCXX_CTR,,${tower}\n`, tower, 'real-shaped item after an empty one'],
    [`${policyUrlName}=${policy}\n`, host, 'unquoted policy link'],
    [`${policyUrlName}="${policy}"\n`, host, 'quoted policy link'],
    [`  ${policyUrlName}: '${policy}?ref=1',\n`, host, 'policy link property'],
    [`${lower(policyUrlName)}: "HTTPS://${host.toUpperCase()}/GCA"\n`, host.toUpperCase(), 'lowercase name, uppercase link'],
    [`${policyUrlName}=ftp://${host}/gca\n`, host, 'another scheme'],
    [`${policyUrlName}=https://x.test@${host}/gca\n`, host, 'reserved userinfo'],
    [`${policyUrlName}=https://example.test:x@${host}/\n`, host, 'reserved userinfo with a password'],
    [`${policyUrlName}=https://x.test\\@${host}/\n`, host, 'reserved userinfo after a backslash'],
    [`${policyUrlName}=https://test.${host}/gca\n`, host, 'reserved label as a subdomain'],
    [`${policyUrlName}=https://x.example.${host}/gca\n`, host, 'reserved domain as a subdomain'],
    [`${policyUrlName}=https://${host}/x.test\n`, host, 'reserved name in the path'],
    [`${policyUrlName}=https://${host}?x.example\n`, host, 'reserved name in the query'],
    [`${policyUrlName}=https://${host}#x.invalid\n`, host, 'reserved name in the fragment'],
    [`${policyUrlName}=https://example.test:8443/gca\n`, '', 'reserved host with a port'],
  ];
}

// NX4-G1 (1a, 1b, 2b): quoted userinfo in a policy link, callsign lists with
// dashed, dotted or Unicode-space items, and FIR prefixes outside dotenv lines.
// Flagged lines are assembled at runtime from joined names, J prefixes and
// random hosts, so this file never holds one. Each rule's cases pass with that
// rule removed (or, for the callsign rule, with its previous regex), so the new
// or widened rule is what blocks them.
const jPrefix = (letter) => ['J', letter].join('');
function g1Cases() {
  const host = `jddd-${randomBytes(3).toString('hex')}.org`;
  const tower = jsonName('JDDD', 'TWR');
  const centre = jsonName('JDDD', 'CTR');
  const [jd, je] = [jPrefix('D'), jPrefix('E')];
  const lower = (name) => name.toLowerCase();
  // rule id -> [line, text the redacted output must not show, label]
  return {
    'onfreq-gca-policy-url-quoted-userinfo': [
      [`${policyUrlName}="https://x.test"@${host}/gca\n`, host, 'double quote before @, joined by the shell'],
      [`${policyUrlName}='https://x.test'@${host}/gca\n`, host, 'single quote before @'],
      [`${policyUrlName}=https://x.example\`@${host}/gca\n`, host, 'backtick before @'],
      [`${policyUrlName}="https://x.test"\\@${host}/\n`, host, 'quote and backslash before @'],
      [`${policyUrlName}='https://x.test'\\''@${host}/'\n`, host, 'shell-escaped single quote before @'],
      [`  ${lower(policyUrlName)}: "HTTPS://X.INVALID"@${host.toUpperCase()}\n`, host.toUpperCase(), 'lowercase name'],
    ],
    'onfreq-excluded-callsigns-assignment': [
      [`${callsignsName}=QCXX_CTR,QCXX-APP,${tower}\n`, tower, 'dashed item early in the list'],
      [`  ${callsignsName}: 'QCXX_CTR, QC.X, ${tower}',\n`, tower, 'dotted item early in the list'],
      [`"${callsignsName}": "QCXX_CTR,\u00a0${tower}"\n`, tower, 'no-break space before an item'],
      [`${callsignsName}=QCXX_CTR,QCXX\u00a0${tower}\n`, tower, 'no-break space inside an item'],
      [`${callsignsName}='\u00a0${centre}'\n`, centre, 'leading no-break space'],
      [`${callsignsName}="\u3000${centre}"\n`, centre, 'leading ideographic space'],
      [`${callsignsName}=\ufeff${centre}\n`, centre, 'leading byte order mark'],
    ],
    'onfreq-fir-prefixes-property': [
      [`  ${firPrefixes}: '${jd}',\n`, '', 'TypeScript property'],
      [`  ${firPrefixes}: '${jd}, XA',\n`, `${jd}, XA`, 'TypeScript list, J item first'],
      [`"${firPrefixes}": "${jd},${je}"\n`, `${jd},${je}`, 'JSON key'],
      [`{"${firPrefixes}":"\u00a0${jd}"}\n`, '', 'compact JSON with a no-break space'],
      [`  ${firPrefixes}: ${jd}, ${je} # note\n`, `${jd}, ${je}`, 'YAML list'],
      [`  ${firPrefixes}: "${jd}"\n`, '', 'quoted YAML'],
      [`$env:${firPrefixes} = '${jd},${je}'\n`, `${jd},${je}`, 'PowerShell'],
      [`      - ${firPrefixes}=${jd}\n`, '', 'compose list item'],
      [`env ${firPrefixes}=${jd},${je} npm run deploy\n`, `${jd},${je}`, 'env command'],
      [`A=1 ${firPrefixes}=${jd}\n`, '', 'after another assignment'],
      [`A=1 ${firPrefixes}=${lower(jd)},${je}; npm test\n`, `${lower(jd)},${je}`, 'lowercase item before a semicolon'],
      [`(${firPrefixes}=${jd})\n`, '', 'subshell'],
    ],
  };
}
// NX5-L2: the callsign allowlist takes any synthetic item up to a comma or
// blank, the first callsign item may hold a dash, the blank class B covers VT,
// FF, CR and the line and paragraph separators, the quoted-userinfo rule has
// one branch per opener, and the NAME:value forms of FIR prefixes and the
// coordinator name are flagged. Flagged lines are assembled at runtime from joined names, J
// prefixes, random hosts and values, so this file never holds one. Each rule's
// texts before NX5-L2 are pinned here, so the necessity test can restore them.
// NX-6: the coordinator-name colon rule also takes a whole quoted value, and the
// FIR prefix NAME:list branch takes the blank class B around commas. The colon
// rule had no text before NX5-L2, so its pinned earlier text is the one before
// NX-6; the FIR text before NX-6 is pinned separately (firColonBeforeNx6).
// NX-7 changed the current texts below (and the allowlists the earlier texts
// are restored with); nx7Texts pins the 2.2.10 texts. NX-8 changed the callsign
// rule and allowlist again (callsignRegexNx8, callsignAllowNx8); the NX-7 texts
// are those of 2.2.11.
const tick = '`';
const blankClass = String.raw`[\t\v\f\r \p{Zs}\x{FEFF}\x{2028}\x{2029}]`;
const itemClass = String.raw`[^\s,"'${tick};)}\]]*`;
const callsignHead = String.raw`regex = '''\b(?i:EXCLUDED_CALLSIGNS)\b["']?\s*[=:]\s*["'${tick}]?`;
const callsign2210 = String.raw`${callsignHead}${blankClass}*([A-Za-z0-9-]+_${itemClass}(?:${blankClass}*,${blankClass}*${itemClass})*)'''`;
const callsignItem = String.raw`[^,\s\v\p{Zs}\x{FEFF}\x{2028}\x{2029}]*`;
const firBlank = String.raw`[\t \p{Zs}\x{FEFF}]`;
const firBeforeL2 = String.raw`regex = '''(?m)\bFIR_PREFIXES\b["']?[ \t]*[=:][ \t]*(?:["'${tick}](${firBlank}*[A-PR-WYZa-pr-wyz][A-Za-z]{0,3}(?:${firBlank}*,${firBlank}*[A-Za-z]{0,4})*${firBlank}*)["'${tick}]|([A-Z]{1,4}(?:[ \t]*,[ \t]*[A-Z]{1,4})*)[ \t\r]*(?:#[^\n]*)?$)|\bFIR_PREFIXES=([A-Za-z]{1,4}(?:,[A-Za-z]{0,4})*)(?:[ \t\r;&|)]|$)'''`;
// The FIR prefix rule's NAME:list branch, with `blank` around commas.
const firColon = (blank) => String.raw`|\bFIR_PREFIXES:([A-Za-z]{1,4}(?:${blank}*,${blank}*[A-Za-z]{0,4})*)(?:[\s"'${tick};&|)]|$)'''`;
// The FIR prefix rule as released in 2.2.10, before NX-7.
const fir2210 = firBeforeL2.replaceAll(firBlank, blankClass).slice(0, -3) + firColon(blankClass);
// NX-7 texts. The callsign rule also reads blank escapes before the first item,
// the letters that uppercase to Latin ones, an all-uppercase dotted first item
// and quotes the shell joins; its allowlist takes a quote before an item.
const blankEscape = String.raw`\\[ tvfrn]|\\x(?:0[9a-dA-D]|20|[aA]0)|\\u(?:00(?:0[9a-dA-D]|20|[aA]0)|1680|200[0-9aA]|202[89fF]|205[fF]|3000|[fF][eE][fF][fF])`;
const someItem = String.raw`[^\s,"'${tick};)}\]]+`;
const callsignRegexNx7 = String.raw`regex = '''\b(?i:EXCLUDED_CALLSIGNS)\b["']?\s*[=:]\s*(?:\$'|["'${tick}])?(?:${blankClass}|${blankEscape})*((?:[A-Za-z0-9\x{DF}\x{131}\x{17F}\x{FB00}-\x{FB06}-]+|[A-Z0-9-]+(?:\.[A-Z0-9-]*)+)_${itemClass}(?:${blankClass}*,${blankClass}*(?:["'${tick}]${someItem}|${itemClass})|["'${tick}],${someItem})*)'''`;
const callsignAllow = (quote, pairs = '') => String.raw`regexes = ['''(?i)^[QX]${callsignItem}(?:${blankClass}*,${blankClass}*${pairs}(?:${quote}[QX]${callsignItem})?)*${blankClass}*$''']`;
const callsignAllowNx7 = callsignAllow(String.raw`["'${tick}]?`);
// NX-8 (A1): the callsign rule and its allowlist also read empty quote pairs
// after a comma, which the shell drops (<item>,"",<item>).
const emptyPairs = String.raw`(?:""|''|${tick}${tick})*`;
const callsignRegexNx8 = String.raw`regex = '''\b(?i:EXCLUDED_CALLSIGNS)\b["']?\s*[=:]\s*(?:\$'|["'${tick}])?(?:${blankClass}|${blankEscape})*((?:[A-Za-z0-9\x{DF}\x{131}\x{17F}\x{FB00}-\x{FB06}-]+|[A-Z0-9-]+(?:\.[A-Z0-9-]*)+)_${itemClass}(?:${blankClass}*,${blankClass}*${emptyPairs}(?:["'${tick}]${someItem}|${itemClass})|["'${tick}],${someItem})*)'''`;
const callsignAllowNx8 = callsignAllow(String.raw`["'${tick}]?`, emptyPairs);
// Every FIR prefix secret starts with its opening quote, = or :, and the
// NAME=list, NAME:list and end-of-line forms may end in any blank of B.
const firNx7Text = (colonBlank) => String.raw`regex = '''(?m)\bFIR_PREFIXES\b["']?[ \t]*[=:][ \t]*(["'${tick}]${blankClass}*[A-PR-WYZa-pr-wyz][A-Za-z]{0,3}(?:${blankClass}*,${blankClass}*[A-Za-z]{0,4})*${blankClass}*)["'${tick}]`
  + String.raw`|\bFIR_PREFIXES\b["']?[ \t]*([=:][ \t]*[A-Z]{1,4}(?:[ \t]*,[ \t]*[A-Z]{1,4})*)${blankClass}*(?:#[^\n]*)?$`
  + String.raw`|\bFIR_PREFIXES(=[A-Za-z]{1,4}(?:,[A-Za-z]{0,4})*)(?:[\t\v\f\r \p{Zs}\x{FEFF}\x{2028}\x{2029};&|)]|$)`
  + String.raw`|\bFIR_PREFIXES(:[A-Za-z]{1,4}(?:${colonBlank}*,${colonBlank}*[A-Za-z]{0,4})*)(?:[\s\v\p{Zs}\x{FEFF}\x{2028}\x{2029}"'${tick};&|)]|$)'''`;
const firNx7 = firNx7Text(blankClass);
const firColonBeforeNx6 = firNx7Text(String.raw`[ \t]`);
const firAllow = (delimiter) => String.raw`regexes = ['''(?i)^${delimiter}\s*[QX][A-Z]{0,3}(?:\s*,\s*(?:[QX][A-Z]{0,3})?)*\s*$''']`;
const firAllowNx7 = firAllow(String.raw`(?:[=:][ \t]*|["'${tick}])?`);
const quotedPart = String.raw`"[^"\n]*"|'[^'\n]*'|${tick}[^${tick}\n]*${tick}`;
const colon2210 = String.raw`regex = '''\b${coordinatorName}:(?:"([^"\n]+)"|'([^'\n]+)'|${tick}([^${tick}\n]+)${tick}|([^\s"'${tick}#;&|)]+))'''`;
const colonNx7 = String.raw`regex = '''\b${coordinatorName}(:(?:${quotedPart}|[^\s"'${tick}#;&|)]|"[^"\s,;)+}\]][^"\n]*|'[^'\s,;)+}\]][^'\n]*)+)'''`;
const synthetic = 'synthetic[-A-Za-z0-9]*';
const synthetic2210 = `regexes = ['''^${synthetic}$''']`;
const colonAllowNx7 = String.raw`regexes = ['''^:(?:${synthetic}|"${synthetic}"|'${synthetic}'|${tick}${synthetic}${tick}|""|''|${tick}${tick})[}\]]*$''']`;
const dotenv2210 = (name) => String.raw`regex = '''(?m)^[+]?\s*(?:export\s+)?${name}\s*=[ \t]*(?:"([^"\n]+)"|'([^'\n]+)'|${tick}([^${tick}\n]+)${tick}|([^\s"'${tick}#](?:[^#\n]*[^\s#])?))'''`;
const dotenvNx7 = (name) => String.raw`regex = '''(?m)^[+]?\s*(?:export\s+)?${name}\s*(=[ \t]*(?:(?:${quotedPart})(?:${quotedPart}|[^\s"'${tick}#])+|"[^"\n]+"|'[^'\n]+'|${tick}[^${tick}\n]+${tick}|["'${tick}][^"'${tick}\n]*[^\s"'${tick}#]|[^\s"'${tick}#](?:[^#\n]*[^\s#])?))'''`;
const firList = String.raw`\s*[QX][A-Z]{0,3}(?:\s*,\s*[QX][A-Z]{0,3})*\s*,?\s*`;
const firDotenvAllowNx7 = String.raw`regexes = ['''(?i)^=[ \t]*(?:"${firList}"|'${firList}'|${tick}${firList}${tick}|${firList})$''']`;
const coordinatorAllowNx7 = String.raw`regexes = ['''^=[ \t]*(?:${synthetic}|"${synthetic}"|'${synthetic}'|${tick}${synthetic}${tick})$''']`;
const secretGroup = 'secretGroup = 1';
const l2Texts = {
  'onfreq-excluded-callsigns-assignment': [
    ['regex', callsignRegexNx8,
      String.raw`${callsignHead}[ \t\p{Zs}\x{FEFF}]*([A-Za-z0-9]+_${itemClass}(?:[ \t]*,[ \t]*${itemClass})*)'''`],
    ['regexes', callsignAllowNx8,
      String.raw`regexes = ['''(?i)^[QX][A-Z0-9_]*(?:[ \t]*,[ \t]*(?:[QX][A-Z0-9_]*)?)*$''']`],
  ],
  'onfreq-fir-prefixes-property': [
    ['regex', firNx7, firBeforeL2],
    ['regexes', firAllowNx7, firAllow('')],
  ],
  'onfreq-coordinator-name-colon': [
    ['regex', colonNx7, String.raw`regex = '''\b${coordinatorName}:([^\s"'${tick}#;&|)]+)'''`],
    ['secretGroup', secretGroup, null],
    ['regexes', colonAllowNx7, synthetic2210],
  ],
  'onfreq-gca-policy-url-quoted-userinfo': [
    ['regex', String.raw`regex = '''\b(?i:GCA_POLICY_URL)\b["']?\s*[=:]\s*([A-Za-z][A-Za-z0-9+.-]*://[A-Za-z0-9._~%!$&*+;=-]*["'${tick}\\][A-Za-z0-9._~%!$&*+;=:"'${tick}\\-]*@[^\s"'${tick}]*|"[ \t]*[A-Za-z][A-Za-z0-9+.-]*://[A-Za-z0-9._~%!$&*+;=-]*(?:"(?:[A-Za-z0-9._~%!$*+=:"'${tick}\\-][A-Za-z0-9._~%!$&*+;=:"'${tick}\\-]*)?|['${tick}\\][A-Za-z0-9._~%!$&*+;=:"'${tick}\\-]*)@[^\s"'${tick}]*|'[ \t]*[A-Za-z][A-Za-z0-9+.-]*://[A-Za-z0-9._~%!$&*+;=-]*(?:'(?:[A-Za-z0-9._~%!$*+=:"'${tick}\\-][A-Za-z0-9._~%!$&*+;=:"'${tick}\\-]*)?|["${tick}\\][A-Za-z0-9._~%!$&*+;=:"'${tick}\\-]*)@[^\s"'${tick}]*|${tick}[ \t]*[A-Za-z][A-Za-z0-9+.-]*://[A-Za-z0-9._~%!$&*+;=-]*(?:${tick}[A-Za-z0-9._~%!$*+=:"'${tick}\\-][A-Za-z0-9._~%!$&*+;=:"'${tick}\\-]*|["'\\][A-Za-z0-9._~%!$&*+;=:"'${tick}\\-]*)@[^\s"'${tick}]*)'''`,
      String.raw`regex = '''\b(?i:GCA_POLICY_URL)\b["']?\s*[=:]\s*["'${tick}]?[ \t]*([A-Za-z][A-Za-z0-9+.-]*://[A-Za-z0-9._~%!$&*+;=-]*["'${tick}\\][A-Za-z0-9._~%!$&*+;=:"'${tick}\\-]*@[^\s"'${tick}]*)'''`],
  ],
};
// NX-8: the quoted-join rule reads the same callsign lists as the callsign
// rule, so every rollback of the callsign rule (editRule and withoutRule below,
// and so beforeL2, previousCallsignRule and as2210) also removes it, and each
// earlier callsign text is checked alone.
const callsignRule = 'onfreq-excluded-callsigns-assignment';
const quotedJoinRule = 'onfreq-excluded-callsigns-quoted-join';
const withoutCompanions = (text, id) => (id === callsignRule ? withoutRule(text, quotedJoinRule) : text);
// The configuration with each `key = ` line of rule `id` (its allowlist
// included) changed from the expected current text to another, or removed
// when the other is null.
function editRule(rules, id, edits) {
  const lines = rules.toString().split('\n');
  const start = lines.indexOf(`id = "${id}"`);
  assert.ok(start > 0, id);
  const end = lines.indexOf('[[rules]]', start);
  for (const [key, from, to] of edits) {
    const at = lines.findIndex((line, index) => index > start && line?.startsWith(`${key} = `));
    assert.ok(at > start && (end < 0 || at < end), `${id} ${key}`);
    assert.equal(lines[at], from, `${id} ${key} is the current text`);
    lines[at] = to;
  }
  return withoutCompanions(lines.filter((line) => line !== null).join('\n'), id);
}
// The configuration with rule `id` as before NX5-L2.
const beforeL2 = (rules, id) => editRule(rules, id, l2Texts[id]);
// rule id -> { block: [line, text or texts the redacted output must not show, label, needs the change,
//                      needs NX-6's FIR blanks][],
//              pass: [line, label, needs the change][] }; "needs the change" marks
// cases whose outcome differs with the rule's pinned earlier text (pass instead
// of block, or block instead of pass); the others guard against regressions.
function l2Cases() {
  const host = `jddd-${randomBytes(3).toString('hex')}.org`;
  const tower = jsonName('JDDD', 'TWR');
  const [jd, je] = [jPrefix('D'), jPrefix('E')];
  const name = ['jd', randomBytes(3).toString('hex')].join('-');
  const [first, last] = ['jd', 'je'].map((part) => [part, randomBytes(3).toString('hex')].join('-'));
  const mail = ['a', 'b.test'].join('@');
  const cn = (rest) => `${coordinatorName}${rest}\n`;
  const cs = (rest) => `${callsignsName}${rest}\n`;
  return {
    'onfreq-excluded-callsigns-assignment': {
      block: [
        [`<code>${cs(`=${tower}</code>`)}`, tower, 'code element', false],
        [cs(`=QCXX_CTR</b>,${tower}`), tower, 'markup after a synthetic item', false],
        [cs(`=QCXX_CTR,QCXX ${tower}`), tower, 'no-break space inside an item (NX4-G1)', false],
        [cs(`=QC-X_CTR,${tower}`), tower, 'dashed first item', true],
        [cs(`=-X_CTR,${tower}`), tower, 'first item starting with a dash', true],
        [cs(`=QCXX_CTR\f,${tower}`), tower, 'FF before a comma', true],
        [cs(`=QCXX_CTR\t\f,${tower}`), tower, 'tab and FF before a comma', true],
        [cs(`=QCXX_CTR,\f${tower}`), tower, 'FF after a comma', true],
        [cs(`=QCXX_CTR,\r${tower}`), tower, 'CR after a comma', true],
        [cs(`="\f${tower}"`), tower, 'leading FF', true],
        [cs(`=\v${tower}`), tower, 'leading VT', true],
        [cs(`= ${tower}`), tower, 'leading line separator', true],
        [cs(`=" ${tower}"`), tower, 'leading paragraph separator', true],
      ],
      pass: [
        [`Set ${cs('=QCXX_CTR.')}`, 'full stop after a synthetic item', true],
        [`<code>${cs('=QCXX_CTR,xd_syn_twr</code>')}`, 'code element around synthetic items', true],
        [cs("='QCXX_CTR '"), 'blank before the closing quote', false],
        [cs('=QCXX_CTR,QC.X'), 'dotted synthetic item (NX4-G1 case)', true],
        [cs('=QC-X_CTR,QD_TWR'), 'dashed synthetic first item', false],
        [cs(`: env.${callsignsName},`), 'reference', false],
        [cs(': config.excluded_callsigns'), 'lowercase reference', false],
        [cs('=QCXX_CTR\f,QDXX_TWR'), 'FF before a synthetic item', false],
        [cs('=\vQCXX_CTR'), 'leading VT before a synthetic item', false],
        [cs('=" QCXX_CTR, \fXD_SYN"'), 'line separator and FF before synthetic items', false],
        [`${callsignsName}=QCXX_CTR\r\n`, 'CRLF line', false],
      ],
    },
    'onfreq-gca-policy-url-quoted-userinfo': {
      block: [
        [`${policyUrlName}="https://x.test"+"@${host}"\n`, host, 'quoted @ joined by +', false],
        [`${policyUrlName}='https://x.test"@${host}'\n`, host, 'double quote inside single quotes', false],
        [`${policyUrlName}="https://x.test"";x"@${host}\n`, host, 'empty quoted word before ;', false],
        [`${policyUrlName}: ${tick}https://x.test${tick}+'@${host}'\n`, host, 'backtick-closed link joined by +', false],
        [`${policyUrlName}=https://x.test";x@${host}\n`, host, 'unquoted link with a quote and ;', false],
      ],
      pass: [
        [`${policyUrlName}="https://example.test";MAIL=${mail}\n`, 'double-quoted link, then ; and an address', true],
        [`${policyUrlName}='https://example.test';MAIL=${mail}\n`, 'single-quoted link, then ; and an address', true],
        [`${policyUrlName}="https://example.test"&&MAIL=${mail}\n`, 'double-quoted link, then && and an address', true],
        [`${policyUrlName}=${tick}https://example.test${tick}@owner\n`, 'backtick-closed link, then @', true],
      ],
    },
    'onfreq-fir-prefixes-property': {
      block: [
        [`  ${firPrefixes}: '${jd},\f${je}'\n`, '', 'FF after a comma', true],
        [`${firPrefixes}: "\v${jd}"\n`, '', 'leading VT', true],
        [`{"${firPrefixes}":" ${jd}"}\n`, '', 'leading line separator in JSON', true],
        [`wrangler dev --var ${firPrefixes}:${jd},${je} --port 1\n`, `${jd},${je}`, 'wrangler --var NAME:list', true],
        [`wrangler dev --var=${firPrefixes}:${jd.toLowerCase()}\n`, '', 'wrangler --var=NAME:list, lowercase', true],
        // The uppercase list at the end of the line was already flagged before NX5-L2.
        [`wrangler dev --var A:1 ${firPrefixes}:${jd}\n`, '', 'second --var item ending the line', false],
        [`wrangler dev --var A:1 ${firPrefixes}:${jd} --port 1\n`, '', 'second --var item before more options', true],
        [`wrangler dev --var "${firPrefixes}:${jd}, ${je}"\n`, `${jd}, ${je}`, 'quoted --var with a blank', true],
        // NX-7's Unicode-blank terminators flag this one with ASCII blanks around commas too (as :JD,).
        [`wrangler dev --var ${firPrefixes}:${jd},\u00a0${je}\n`, `${jd},\u00a0${je}`,
          'no-break space after a comma in NAME:list (NX-6)', true],
        [`wrangler dev --var ${firPrefixes}:QC,\u00a0${je}\n`, `QC,\u00a0${je}`,
          'no-break space after a comma after a synthetic item in NAME:list (NX-6)', true, true],
      ],
      pass: [
        [`wrangler dev --var ${firPrefixes}:QC,XA --port 1\n`, 'synthetic NAME:list', false],
        [`wrangler dev --var ${firPrefixes}:QC,XA\n`, 'synthetic NAME:list ending the line (NX-6)', false],
      ],
    },
    'onfreq-coordinator-name-colon': {
      block: [
        // The unquoted value was already flagged before NX-6.
        [`wrangler dev --var ${cn(`:${name}`)}`, name, 'wrangler --var NAME:value', false],
        [`wrangler dev --var ${cn(`:'${first} ${last}'`)}`, [first, last], 'single-quoted name with a blank (NX-6)', true],
        [`wrangler dev --var ${cn(`:"${name}"`)}`, name, 'double-quoted name (NX-6)', true],
        [`wrangler dev --var ${cn(`:${tick}${name}${tick}`)}`, name, 'backtick-quoted name (NX-6)', true],
        [`wrangler dev --var ${cn(`:' ${name}'`)}`, name, 'quoted name with a leading blank (NX-6)', true],
        [`wrangler dev --var ${cn(`:"synthetic ${name}"`)}`, name, 'quoted synthetic word and a blank (NX-6)', true],
        [`const vars = {${coordinatorName}:'${name}'};\n`, name, 'compact TypeScript object (NX-6)', true],
        [`wrangler dev --var ${cn(`:"synthetic-x\\"${name}\\""`)}`, name, 'escaped quote after a synthetic word (NX-6)', true],
        [cn(`:${name}`), name, 'NAME:value at the start of a line (NX-6 regression)', false],
        [`wrangler dev --var "${coordinatorName}:${first} ${last}"\n`, first, 'quoted --var with a blank (NX-6 regression)', false],
      ],
      pass: [
        [`wrangler dev --var ${coordinatorName}:synthetic-x\n`, 'synthetic NAME:value', false],
        [`wrangler dev --var ${cn(':"synthetic-x"')}`, 'double-quoted synthetic name (NX-6)', false],
        [`wrangler dev --var ${cn(":'synthetic-x'")}`, 'single-quoted synthetic name (NX-6)', false],
        [cn(":''"), 'empty single-quoted value (NX-6)', false],
        [cn(':""'), 'empty double-quoted value (NX-6)', false],
        [`{"${coordinatorName}":"${name}"}\n`, 'compact JSON (NX-6)', false],
        [cn(": ' preserved-state '"), 'code with a blank after the colon (NX-6)', false],
      ],
    },
  };
}
const settingsText = (line) => `# synthetic settings\n${line}# end\n`;

// The configuration without one rule and its allowlist.
function withoutRule(rules, id) {
  const text = rules.toString();
  const start = text.indexOf(`[[rules]]\nid = "${id}"\n`);
  assert.ok(start >= 0, id);
  const next = text.indexOf('\n[[rules]]\n', start);
  return withoutCompanions(text.slice(0, start) + (next < 0 ? '' : text.slice(next + 1)), id);
}
// The configuration with the callsign rule's regex as before NX4-G1: ASCII
// blanks before the list and around commas, and items of letters, digits and
// underscores. Its allowlist is the current one (NX-8), which every NX4-G1
// case's previous match passes.
function previousCallsignRule(rules) {
  return editRule(rules, 'onfreq-excluded-callsigns-assignment', [['regex', callsignRegexNx8,
    String.raw`${callsignHead}[ \t]*([A-Za-z0-9]+_[A-Za-z0-9_]*(?:[ \t]*,[ \t]*[A-Za-z0-9_]*)*)'''`]]);
}
// Commits `text` without the hook and returns secret-scan.sh over that commit alone.
function scanCommit(f, text) {
  writeFileSync(join(f.repo, 'settings.env'), text);
  f.git('add', 'settings.env');
  f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic settings');
  const scan = secretScan(f, 'HEAD^!');
  f.git('rm', '--quiet', 'settings.env');
  f.git('commit', '--quiet', '--no-verify', '-m', 'remove synthetic settings');
  return scan;
}

// NX-7: quotes the shell joins and unclosed quotes in callsign lists, coordinator
// names and FIR prefixes; blank escapes, Unicode letters that uppercase to Latin
// ones and an all-uppercase dotted first item in callsign lists; FIR prefix
// lists ending in a Unicode blank; and secrets that keep their delimiter, so
// Gitleaks' default allowlist cannot pass a list of one letter or one repeated
// letter (FIR prefixes) or a value of one repeated letter or starting with
// "true" (coordinator names). Flagged lines are assembled at runtime from
// joined names, J prefixes and random values, so this file never holds one.
// Each rule's 2.2.10 texts are pinned, with its allowlist and secret group.
const nx7Texts = {
  'onfreq-excluded-callsigns-assignment': [
    ['regex', callsignRegexNx8, callsign2210],
    ['regexes', callsignAllowNx8, callsignAllow('')],
  ],
  'onfreq-fir-prefixes-property': [
    ['regex', firNx7, fir2210],
    ['regexes', firAllowNx7, firAllow('')],
  ],
  'onfreq-coordinator-name-colon': [
    ['regex', colonNx7, colon2210],
    ['secretGroup', secretGroup, null],
    ['regexes', colonAllowNx7, synthetic2210],
  ],
  'onfreq-coordinator-name-assignment': [
    ['regex', dotenvNx7(coordinatorName), dotenv2210(coordinatorName)],
    ['secretGroup', secretGroup, null],
    ['regexes', coordinatorAllowNx7, synthetic2210],
  ],
  'onfreq-fir-prefixes-assignment': [
    ['regex', dotenvNx7(firPrefixes), dotenv2210(firPrefixes)],
    ['secretGroup', secretGroup, null],
    ['regexes', firDotenvAllowNx7, String.raw`regexes = ['''(?i)^${firList}$''']`],
  ],
};
// The configuration with rules `ids` as released in 2.2.10.
const as2210 = (ids) => ids.reduce((rules, id) => editRule(rules, id, nx7Texts[id]), repoRules());
// { block: [line, text or texts the redacted output must not show, label, ids of
//   the rules whose 2.2.10 texts together pass it (none: Gitleaks already
//   flagged it)][], pass: [line, label][] }
function nx7Cases() {
  const tower = jsonName('JDDD', 'TWR');
  const [jd, je] = [jPrefix('D'), jPrefix('E')];
  const name = ['jd', randomBytes(3).toString('hex')].join('-');
  const [cs, cn, fp] = [callsignsName, coordinatorName, firPrefixes].map((setting) => (rest) => `${setting}${rest}\n`);
  const [callsigns, colon, dotenv, firDotenv, fir] = ['onfreq-excluded-callsigns-assignment', 'onfreq-coordinator-name-colon',
    'onfreq-coordinator-name-assignment', 'onfreq-fir-prefixes-assignment', 'onfreq-fir-prefixes-property'].map((id) => [id]);
  const bs = '\\';
  const twoJ = jPrefix('J');
  return {
    block: [
      [cs(`="QCXX_CTR",${tower}`), tower, 'quoted synthetic first item joined to a later item', callsigns],
      [cs(`='QCXX_CTR',${tower}`), tower, 'single-quoted synthetic first item joined to a later item', callsigns],
      [cs(`=QCXX_CTR,"${tower}"`), tower, 'quoted later item', callsigns],
      [cs(`=QCXX_CTR,'${tower}'`), tower, 'single-quoted later item', callsigns],
      [cs(`=QCXX_CTR,${tick}${tower}${tick}`), tower, 'backtick-quoted later item', callsigns],
      [cs(`="${bs}t${tower}"`), tower, 'tab escape before the first item', callsigns],
      [cs(`=$'${bs}f${tower}'`), tower, 'ANSI-C form feed escape before the first item', callsigns],
      [cs(`="${bs}x20${tower}"`), tower, 'hex space escape before the first item', callsigns],
      [cs(`=$'${bs}xa0${tower}'`), tower, 'hex no-break space escape before the first item', callsigns],
      [cs(`=${bs} ${tower}`), tower, 'backslash before a space before the first item', callsigns],
      [cs('=ſDDD_TWR'), 'DDD_TWR', 'long s, which uppercases to S', callsigns],
      [cs('=JDıD_TWR'), 'D_TWR', 'dotless i, which uppercases to I', callsigns],
      [cs('=JDßD_TWR'), 'D_TWR', 'sharp s, which uppercases to SS', callsigns],
      [cs('=JﬀD_TWR'), 'D_TWR', 'ff ligature, which uppercases to FF', callsigns],
      [cs(`=QC.X_CTR,${tower}`), tower, 'all-uppercase dotted first item', callsigns],
      // Gitleaks decodes \u escapes and scans the decoded text, so 2.2.10 already flagged this one.
      [cs(`="${bs}u00a0${tower}"`), tower, 'Unicode no-break space escape before the first item', []],
      [`wrangler dev --var ${cn(`:'synthetic'"${name}"`)}`, name, 'quoted synthetic name joined to more text', colon],
      [`wrangler dev --var ${cn(`:"aa""${name}"`)}`, name, 'quoted parts joined', colon],
      [cn(':zzzz'), 'zzzz', 'one repeated letter after the colon', colon],
      [cn(`:true${name}`), name, 'value starting with true after the colon', colon],
      [`wrangler dev --var ${cn(`:"${name}`)}`, name, 'unclosed double quote after the colon', colon],
      [`wrangler dev --var ${cn(`:'${name}`)}`, name, 'unclosed single quote after the colon', colon],
      [cn(`='synthetic'${name}`), name, 'quoted synthetic dotenv name joined to more text', dotenv],
      [cn(`=""${name}`), name, 'empty quotes joined to a dotenv name', dotenv],
      [cn(`="${name}`), name, 'unclosed quote in a dotenv name', dotenv],
      [cn('=zzzz'), 'zzzz', 'dotenv name of one repeated letter', dotenv],
      [cn(`=true${name}`), name, 'dotenv name starting with true', dotenv],
      [fp(`="QX",${jd}`), `"QX",${jd}`, 'quoted synthetic dotenv list joined to a later item', firDotenv],
      [fp(`="${jd}`), '', 'unclosed quote in a dotenv list', firDotenv],
      [`  ${fp(": 'J',")}`, '', 'quoted one-letter list', fir],
      [`wrangler dev --var ${fp(`:${twoJ}`)}`, '', 'NAME:list of one repeated letter', fir],
      [`env ${firPrefixes}=J npm test\n`, '', 'NAME=list of one letter', fir],
      [`  ${fp(`: ${twoJ}`)}`, '', 'YAML list of one repeated letter', fir],
      [`wrangler dev --var ${fp(`:${jd},${je} `)}`, `${jd},${je}`, 'NAME:list ending in a no-break space', fir],
      [`wrangler dev --var ${firPrefixes}:${jd}　 --port 1\n`, '', 'NAME:list before an ideographic space', fir],
      [`env ${fp(`=${jd},${je} `)}`, `${jd},${je}`, 'NAME=list ending in a no-break space', fir],
      [`A=1 ${firPrefixes}=${jd}　npm test\n`, '', 'NAME=list before an ideographic space', fir],
      [`  ${fp(`: ${jd} `)}`, '', 'YAML list ending in a no-break space', fir],
      [`  ${fp(`: ${jd}, ${je}　# note`)}`, `${jd}, ${je}`, 'YAML list before an ideographic space and a comment', fir],
      // At the start of a line both FIR prefix rules read it.
      [fp(`=${twoJ}`), '', 'dotenv list of one repeated letter', [...firDotenv, ...fir]],
    ],
    pass: [
      [`{"${callsignsName}":"QCXX_CTR","N":1}\n`, 'compact JSON callsign'],
      [`{ ${callsignsName}: 'QCXX_CTR', N: 1 }\n`, 'TypeScript object callsign'],
      [cs('="QCXX_CTR",QDXX_APP'), 'quoted synthetic first item joined to a synthetic one'],
      [cs("='QCXX_CTR',QDXX_APP"), 'single-quoted synthetic first item joined to a synthetic one'],
      [cs('=QCXX_CTR,"QDXX_APP"'), 'quoted synthetic later item'],
      [cs('=QCXX_CTR,""'), 'empty quoted later item'],
      [cs(`="${bs}tQCXX_CTR"`), 'tab escape before a synthetic item'],
      [cs(`=$'${bs}fQCXX_CTR'`), 'ANSI-C form feed escape before a synthetic item'],
      [cs(`=$${callsignsName}`), 'shell variable'],
      [`{${cn(":'synthetic-x'}").trimEnd()}\n`, 'compact TypeScript object with a synthetic name'],
      [`'${coordinatorName}:' + value\n`, 'concatenation'],
      [`Set ${tick}${coordinatorName}:${tick} first.\n`, 'Markdown span ending at the colon'],
      [cn('="synthetic-state"'), 'double-quoted synthetic dotenv name'],
      [cn("='synthetic-state'"), 'single-quoted synthetic dotenv name'],
      [`wrangler dev --var ${fp(':QC,XA')}`, 'synthetic NAME:list'],
      [fp('=QQ'), 'synthetic list of one repeated letter'],
      [`  ${fp(": 'XD',")}`, 'quoted synthetic list'],
      [`wrangler dev --var ${fp(':QC,XA ')}`, 'synthetic NAME:list ending in a no-break space'],
      [`env ${fp('=QC,XA ')}`, 'synthetic NAME=list ending in a no-break space'],
      [`  ${fp(': QC, XA ')}`, 'synthetic YAML list ending in a no-break space'],
    ],
  };
}

// NX-8 (A1, A2): empty quote pairs after a comma, which the shell drops, and
// quoted items the shell joins (NAME="<item>","<item>"). Flagged lines are
// assembled at runtime from the joined name and a J tower, so this file never
// holds one. A1 cases need the callsign rule's NX-8 regex: the callsign rule
// alone blocks them, and they pass with its 2.2.11 regex (the quoted-join rule
// removed). A2 cases need the quoted-join rule: they pass with only that rule
// removed. Synthetic lists with empty quotes need the NX-8 allowlist.
function nx8Cases() {
  const tower = jsonName('JDDD', 'TWR');
  const cs = (rest) => `${callsignsName}${rest}\n`;
  return {
    // [line, text the redacted output must not show, label, 'regex' (A1) or 'join' (A2)]
    block: [
      [cs(`=QCXX_CTR,"",${tower}`), tower, 'empty double quotes after a comma', 'regex'],
      [cs(`=QCXX_CTR,'',${tower}`), tower, 'empty single quotes after a comma', 'regex'],
      [cs(`=QCXX_CTR,""${tower}`), tower, 'empty quotes joined to the next item', 'regex'],
      [cs(` = QCXX_CTR,"",${tower}`), tower, 'blanks around = and empty quotes', 'regex'],
      [cs(`="QCXX_CTR","${tower}"`), tower, 'double-quoted items joined', 'join'],
      [cs(`='QCXX_CTR','${tower}'`), tower, 'single-quoted items joined', 'join'],
      [cs(`=QCXX_CTR,"QDXX","${tower}"`), tower, 'quoted items joined after a quoted synthetic item', 'join'],
      [cs(`="QCXX_CTR"",${tower}"`), tower, 'empty quotes joining two items', 'join'],
      [`wrangler dev --var ${cs(`:"QCXX_CTR","${tower}"`)}`, tower, 'wrangler --var NAME:list with quoted items', 'join'],
    ],
    // [line, label, needs the NX-8 allowlist]
    pass: [
      [`{"${callsignsName}":"QCXX_CTR","N":1}\n`, 'compact JSON', false],
      [`{"${callsignsName}":"QCXX_CTR","":1}\n`, 'compact JSON with an empty key', false],
      [`{ ${callsignsName}: 'QCXX_CTR', 'N': 1 }\n`, 'TypeScript object with a quoted key', false],
      [cs('=QCXX_CTR,""'), 'empty quotes ending a synthetic list', true],
      [cs('=QCXX_CTR,"",QDXX_APP'), 'empty quotes before a synthetic item', true],
      [cs('=QCXX_CTR,""QDXX_APP'), 'empty quotes joined to a synthetic item', true],
      [cs('="QCXX_CTR","QDXX_APP"'), 'quoted synthetic items joined', false],
      [cs('=QCXX_CTR,"QDXX","QEXX_APP"'), 'three quoted synthetic items', false],
      [cs('=["QCXX_CTR","QDXX_APP"]'), 'array of synthetic items', false],
      [`{"${callsignsName}":["QCXX_CTR","QDXX_APP"]}\n`, 'JSON array of synthetic items', false],
    ],
  };
}

export {
  hook,
  hooksDir,
  preCommit,
  zero,
  hookHelpers,
  hasGitleaks,
  gitleaksSkip,
  syntheticKey,
  allowMarker,
  fixture,
  mergeOnlySecret,
  ref,
  checks,
  rangeCheck,
  leakScan,
  gitleaksNote,
  stageSyntheticKey,
  repoRules,
  assignment,
  commitRules,
  scanAssignment,
  realShaped,
  otherReal,
  firPrefixes,
  coordinatorName,
  jsonName,
  preamble,
  preambleStream,
  scanFilter,
  assertScanStream,
  gitEnv,
  filteredOutput,
  scanLogArgs,
  headStream,
  stagedStream,
  placeAt,
  secretScan,
  generatedKey,
  privateKeyPem,
  fillerLines,
  keyOffsets,
  keyKind,
  syntheticKeyLines,
  idListLine,
  lineMarker,
  longLine,
  longFilter,
  clientIdName,
  callsignsName,
  policyUrlName,
  identifyingCases,
  jPrefix,
  g1Cases,
  tick,
  blankClass,
  itemClass,
  callsignHead,
  callsign2210,
  callsignItem,
  firBlank,
  firBeforeL2,
  firColon,
  fir2210,
  blankEscape,
  someItem,
  callsignRegexNx7,
  callsignAllow,
  callsignAllowNx7,
  emptyPairs,
  callsignRegexNx8,
  callsignAllowNx8,
  firNx7Text,
  firNx7,
  firColonBeforeNx6,
  firAllow,
  firAllowNx7,
  quotedPart,
  colon2210,
  colonNx7,
  synthetic,
  synthetic2210,
  colonAllowNx7,
  dotenv2210,
  dotenvNx7,
  firList,
  firDotenvAllowNx7,
  coordinatorAllowNx7,
  secretGroup,
  l2Texts,
  callsignRule,
  quotedJoinRule,
  withoutCompanions,
  editRule,
  beforeL2,
  l2Cases,
  settingsText,
  withoutRule,
  previousCallsignRule,
  scanCommit,
  nx7Texts,
  as2210,
  nx7Cases,
  nx8Cases,
};
