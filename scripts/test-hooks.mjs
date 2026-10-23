import { test } from 'node:test';
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

test('pre-push runs range, privacy and setup checks when the pushed commit is the clean HEAD', (t) => {
  const f = fixture(t);
  for (const lines of [[ref(f.head)], [ref(f.head).trimEnd()], [ref(f.head), ref(zero, 'refs/heads/old', f.first)]]) {
    const result = f.push(lines);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.npm, rangeCheck(f.head) + checks);
    assert.equal(result.gitleaks, leakScan(f.head, f.first));
  }
  let result = f.push([ref(f.head, 'refs/heads/main', f.first)]);
  assert.equal(result.npm, rangeCheck(f.head, f.first) + checks);
  assert.equal(result.gitleaks, leakScan(f.head));
  // A deletion-only push, or a wrapper that omits the remote arguments.
  result = f.push([]);
  assert.equal(result.npm, checks);
  assert.equal(result.gitleaks, '');
  result = f.push([ref(f.head)], []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.npm, rangeCheck(f.head, zero, '') + checks);
  assert.equal(result.gitleaks, leakScan(f.head, f.first));
});

test('pre-push scans the same pushed range with Gitleaks as the privacy range check (S19-24)', (t) => {
  const f = fixture(t);
  f.git('remote', 'add', 'origin', 'https://example.test/synthetic.git');
  f.git('update-ref', 'refs/remotes/origin/main', f.first);
  const unknown = 'b'.repeat(40);
  const url = 'https://example.test/synthetic.git';
  // Only the named remote's tracking refs and known remote commits are excluded.
  for (const [remoteOid, args, commits] of [
    [zero, undefined, [f.head]],
    [f.first, undefined, [f.head]],
    [unknown, undefined, [f.head]],
    [f.first, [url, url], [f.head]],
    [zero, [url, url], [f.head, f.first]],
    [unknown, ['public', 'https://example.test/public.git'], [f.head, f.first]],
  ]) {
    const result = f.push([ref(f.head, 'refs/heads/main', remoteOid)], args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.gitleaks, leakScan(...commits));
  }
  const result = f.push([ref(f.head), ref(f.head, 'refs/heads/copy', f.first)], ['public', 'https://example.test/public.git']);
  assert.equal(result.gitleaks, leakScan(f.head, f.first) + leakScan(f.head));
});

test('pre-push blocks when Gitleaks reports a finding or is not installed (S19-24)', (t) => {
  let f = fixture(t, { gitleaksExit: 1 });
  let result = f.push([ref(f.head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthetic finding: REDACTED/);
  assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/);
  // Regression (C53): Gitleaks errors, such as a bad configuration, exit non-zero
  // too; the message stays neutral instead of asserting a leak.
  for (const gitleaksExit of [1, 2, 126]) {
    f = fixture(t, { gitleaksExit });
    result = f.push([ref(f.head)]);
    assert.equal(result.status, 1, String(gitleaksExit));
    assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits; see the output above/);
    assert.doesNotMatch(result.stderr, /look like they contain a secret|could not read the pushed commits/);
  }
  f = fixture(t, { gitleaks: 'missing' });
  result = f.push([ref(f.head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /install gitleaks before pushing/);
  assert.equal(result.npm, '');
});

test('pre-push Gitleaks scan catches a secret committed with --no-verify and redacts it (S19-24)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token}\n`);
    f.git('add', 'config.txt');
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic secret');
    const secret = f.git('rev-parse', 'HEAD');
    f.git('rm', '--quiet', 'config.txt');
    f.git('commit', '--quiet', '--no-verify', '-m', 'remove synthetic secret');
    const head = f.git('rev-parse', 'HEAD');
    // Removed from the final tree, but still in a pushed commit.
    let result = f.push([ref(head)]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/);
    assert.doesNotMatch(result.stderr + result.stdout, new RegExp(token.slice(4)));
    assert.equal(result.npm, rangeCheck(head), 'the secret scan blocks before the full checks');
    // A remote that already has the secret commit is only sent the removal.
    result = f.push([ref(head, 'refs/heads/main', secret)]);
    assert.equal(result.status, 0, result.stderr);
  });

test('pre-push Gitleaks scan reads the literal bytes of binary, -diff and textconv files (S19-28)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    // Without --text/--no-textconv, git log -p shows these as "Binary files differ"
    // or as the textconv output, so Gitleaks would never see the key.
    writeFileSync(join(f.repo, '.gitattributes'), 'marked.txt -diff\nhidden.txt diff=hide\n');
    f.git('config', 'diff.hide.textconv', 'true');
    f.git('add', '.gitattributes');
    f.git('commit', '--quiet', '--no-verify', '-m', 'attributes');
    let base = f.git('rev-parse', 'HEAD');
    const line = `aws_access_key_id = ${token}\n`;
    for (const [name, content] of [
      ['marked.txt', line],
      ['hidden.txt', line],
      ['blob.bin', Buffer.concat([Buffer.from([0, 0xff, 0xfe, 0x00, 0x0a]), Buffer.from(line), Buffer.from([0, 0x80])])],
    ]) {
      writeFileSync(join(f.repo, name), content);
      f.git('add', name);
      f.git('commit', '--quiet', '--no-verify', '-m', `synthetic secret in ${name}`);
      f.git('rm', '--quiet', name);
      f.git('commit', '--quiet', '--no-verify', '-m', `remove ${name}`);
      const head = f.git('rev-parse', 'HEAD');
      const result = f.push([ref(head, 'refs/heads/main', base)]);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/, name);
      assert.doesNotMatch(result.stderr + result.stdout, new RegExp(token.slice(4)), name);
      base = head;
    }
    // Once the remote has those commits, a clean push passes.
    writeFileSync(join(f.repo, 'public.txt'), 'clean\n');
    f.git('commit', '--quiet', '--no-verify', '-am', 'clean');
    const result = f.push([ref(f.git('rev-parse', 'HEAD'), 'refs/heads/main', base)]);
    assert.equal(result.status, 0, result.stderr);
  });

test('pre-push Gitleaks scan catches a secret only a merge resolution adds (S19-28)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const { merge, head } = mergeOnlySecret(f, token);
    let result = f.push([ref(head, 'refs/heads/main', f.head)]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/);
    assert.doesNotMatch(result.stderr + result.stdout, new RegExp(token.slice(4)));
    // A clean merge in the pushed range passes.
    result = f.push([ref(head, 'refs/heads/main', merge)]);
    assert.equal(result.status, 0, result.stderr);
    f.git('checkout', '--quiet', '-b', 'side2');
    writeFileSync(join(f.repo, 'side2.txt'), 'side2\n');
    f.git('add', 'side2.txt');
    f.git('commit', '--quiet', '--no-verify', '-m', 'side2 change');
    f.git('checkout', '--quiet', 'main');
    f.git('merge', '--quiet', '--no-ff', '--no-verify', '-m', 'merge side2', 'side2');
    result = f.push([ref(f.git('rev-parse', 'HEAD'), 'refs/heads/main', head)]);
    assert.equal(result.status, 0, result.stderr);
  });

test('pre-push Gitleaks scan still diffs merges when log.diffMerges is off (S19-30)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const { head } = mergeOnlySecret(f, token);
    // With this repository setting, `git log -m` shows no merge diffs at all.
    f.git('config', 'log.diffMerges', 'off');
    const result = f.push([ref(head, 'refs/heads/main', f.head)]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/);
    assert.doesNotMatch(result.stderr + result.stdout, new RegExp(token.slice(4)));
  });

test('pre-push blocks when Git cannot produce the pushed log (S19-28)', (t) => {
  const f = fixture(t);
  // The first commit's public.txt blob is read only by the scan's log.
  const blob = f.git('rev-parse', `${f.first}:public.txt`);
  rmSync(join(f.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const result = f.push([ref(f.head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not read the pushed commits for the secret scan/);
  assert.doesNotMatch(result.npm, /check:setup/);
});

test('a Gitleaks that exits before reading a large log is reported as a scan or read failure (C59)', (t) => {
  const f = fixture(t);
  // Well beyond any pipe buffer, so Git and sed fail on the closed pipe.
  writeFileSync(join(f.repo, 'large.txt'), `${'synthetic filler line for the scanned log\n'.repeat(40000)}`);
  f.git('add', 'large.txt');
  f.git('commit', '--quiet', '--no-verify', '-m', 'large');
  const head = f.git('rev-parse', 'HEAD');
  const bin = join(f.repo, '..', 'bin');
  // Like Gitleaks on a bad configuration: fails without reading standard input.
  writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\nprintf \'synthetic gitleaks error\\n\' >&2\nexit 1\n', { mode: 0o700 });
  const scan = (...args) => spawnSync('/bin/sh', ['scripts/secret-scan.sh', ...args], { cwd: f.repo,
    env: isolatedEnv({ PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
    encoding: 'utf8' });
  const combined = /secret-scan: the secret scan failed or could not read the commits; see the output above/;
  let result = scan('HEAD');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /synthetic gitleaks error/);
  assert.match(result.stderr, combined);
  assert.doesNotMatch(result.stderr, /could not read the commits to scan/);
  result = f.push([ref(head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, combined);
  assert.match(result.stderr, /pre-push: BLOCKED — could not read the pushed commits for the secret scan, or the scan failed; see the output above/);
  assert.doesNotMatch(result.npm, /check:setup/);
  // A Git failure while Gitleaks reads everything and succeeds names only the read failure.
  writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o700 });
  result = scan('--not-a-revision-xyz');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /secret-scan: could not read the commits to scan/);
  assert.doesNotMatch(result.stderr, combined);
});

test('pre-push scans the range check-privacy.mjs --range-args prints and blocks without it (C47)', (t) => {
  const f = fixture(t);
  f.git('remote', 'add', 'origin', 'https://example.test/synthetic.git');
  f.git('update-ref', 'refs/remotes/origin/main', f.first);
  const rangeArgs = (...args) => spawnSync(process.execPath, ['scripts/check-privacy.mjs', '--range-args', ...args],
    { cwd: f.repo, env: isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }), encoding: 'utf8' });
  let result = rangeArgs(f.head, f.first, 'origin');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${f.head}\n--not\n${f.first}\n--remotes=origin\n`);
  assert.equal(rangeArgs(f.head, zero, '').stdout, `${f.head}\n`);
  // SHA-256 repositories use 64-digit IDs; anything else is refused, printing nothing.
  for (const bad of [f.head.slice(0, 39), 'HEAD', zero]) {
    result = rangeArgs(bad, zero, 'origin');
    assert.equal(result.status, 1, bad);
    assert.equal(result.stdout, '', bad);
  }
  // A committed range script that fails blocks the push before the setup checks.
  writeFileSync(join(f.repo, 'scripts/check-privacy.mjs'), 'process.exitCode = 1;\n');
  f.git('commit', '--quiet', '--no-verify', '-am', 'broken range');
  result = f.push([ref(f.git('rev-parse', 'HEAD'))]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not read the pushed commits for the secret scan/);
  assert.equal(result.gitleaks, '');
  assert.doesNotMatch(result.npm, /check:setup/);
});

test('CI and pre-push share scripts/secret-scan.sh; it reports unreadable history separately (C47)', (t) => {
  const f = fixture(t, { gitleaksExit: 1 });
  const scan = (...args) => spawnSync('/bin/sh', ['scripts/secret-scan.sh', ...args],
    { cwd: f.repo, env: isolatedEnv({ PATH: `${join(f.repo, '..', 'bin')}:${process.env.PATH}`,
      GITLEAKS_LOG: join(f.repo, '..', 'scan.log'), GITLEAKS_EXIT: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GITLEAKS_CONFIG: 'rules.toml' }), encoding: 'utf8' });
  assert.equal(scan('HEAD').status, 1, 'any Gitleaks failure is status 1');
  assert.equal(scan().status, 2, 'no revisions is a usage error');
  assert.equal(scan('--not-a-revision-xyz').status, 2, 'a Git failure is status 2');
  const log = readFileSync(join(f.repo, '..', 'scan.log'), 'utf8');
  assert.doesNotMatch(log, /config variable set/);
  // The CI step runs this script over the full history, and every Gitleaks
  // install uses the one pinned, checksum-verified definition.
  const workflow = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^ +run: sh scripts\/secret-scan\.sh HEAD$/m);
  assert.doesNotMatch(workflow, /gitleaks stdin|gitleaks_\d/);
  assert.equal(workflow.match(/^ +uses: \.\/\.github\/actions\/install-gitleaks$/gm)?.length, 3);
  const action = readFileSync(new URL('../.github/actions/install-gitleaks/action.yml', import.meta.url), 'utf8');
  assert.equal(action.match(/ sha256=[0-9a-f]{64} ;;$/gm)?.length, 3);
  // Both hooks share one Gitleaks settings guard, followed by the version notice.
  for (const file of ['./hooks/pre-push', './hooks/pre-commit']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /^\. scripts\/hooks\/lib\/gitleaks-settings\.sh$/m, file);
    const name = file.split('/').at(-1);
    assert.match(source, new RegExp(`^gitleaks_settings_guard ${name} .* \\|\\| exit 1\ngitleaks_version_notice ${name}$`, 'm'), file);
    assert.doesNotMatch(source, /in \.gitleaks\.toml|untracked or ignored|GITLEAKS_CONFIG/, file);
  }
});

test('secret-scan.sh finds a secret anywhere in history with the real Gitleaks, as CI runs it (C47)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    const scan = () => spawnSync('/bin/sh', ['scripts/secret-scan.sh', 'HEAD'], { cwd: f.repo, env, encoding: 'utf8' });
    assert.equal(scan().status, 0, scan().stderr);
    const token = stageSyntheticKey(f);
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic secret');
    f.git('rm', '--quiet', 'config.txt');
    f.git('commit', '--quiet', '--no-verify', '-m', 'remove synthetic secret');
    const result = scan();
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr + result.stdout, new RegExp(token.slice(4)));
  });

test('privacy checks ignore log.showSignature on signed commits (C45)',
  { skip: spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error && 'ssh-keygen is not installed' }, (t) => {
    const f = fixture(t, { realRange: true });
    // An SSH-signed synthetic commit; no GPG agent or real key is involved.
    const key = join(f.repo, '..', 'signing-key');
    assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'synthetic', '-f', key]).status, 0);
    writeFileSync(join(f.repo, 'public.txt'), 'signed\n');
    f.git('-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'commit', '--quiet', '--no-verify', '-S', '-am', 'signed');
    const head = f.git('rev-parse', 'HEAD');
    f.git('config', 'log.showSignature', 'true');
    const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    for (const args of [[], ['--range', head, zero, 'origin']]) {
      const result = spawnSync(process.execPath, ['scripts/check-privacy.mjs', ...args], { cwd: f.repo, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    }
    const result = f.push([ref(head)]);
    assert.equal(result.status, 0, result.stderr);
  });

test('pre-push ignores Gitleaks configuration variables (S19-29)', (t) => {
  const f = fixture(t);
  const result = f.push([ref(f.head)], undefined,
    { GITLEAKS_CONFIG: join(f.repo, 'rules.toml'), GITLEAKS_CONFIG_TOML: 'title = "no rules"\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.gitleaks, leakScan(f.head, f.first));
});

test('pre-push Gitleaks scan cannot be emptied by configuration variables (S19-29)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    // A configuration with no rules reports nothing when Gitleaks honours it.
    const rules = join(f.repo, '..', 'rules.toml');
    writeFileSync(rules, 'title = "no rules"\n');
    writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${syntheticKey()}\n`);
    f.git('add', 'config.txt');
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic secret');
    const head = f.git('rev-parse', 'HEAD');
    for (const env of [{ GITLEAKS_CONFIG: rules }, { GITLEAKS_CONFIG_TOML: 'title = "no rules"\n' }]) {
      const result = f.push([ref(head, 'refs/heads/main', f.head)], undefined, env);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/);
    }
  });

test('pre-push refuses untracked, ignored or unstaged Gitleaks settings (S19-29)', (t) => {
  const f = fixture(t);
  for (const file of ['.gitleaks.toml', '.gitleaksignore']) {
    writeFileSync(join(f.repo, file), 'title = "no rules"\n');
    let result = f.push([ref(f.head)]);
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, new RegExp(`untracked or ignored \\${file} would change the secret scan`));
    assert.equal(result.npm, '');
    assert.equal(result.gitleaks, '');
    // Ignoring it does not hide it from Gitleaks, so it still blocks.
    writeFileSync(join(f.repo, '.git', 'info', 'exclude'), `${file}\n`);
    result = f.push([ref(f.head)]);
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, /would change the secret scan/);
    rmSync(join(f.repo, '.git', 'info', 'exclude'));
    rmSync(join(f.repo, file));
  }
  // A committed configuration is part of the reviewed history; edits to it are not.
  writeFileSync(join(f.repo, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
  f.git('add', '.gitleaks.toml');
  f.git('commit', '--quiet', '--no-verify', '-m', 'gitleaks config');
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(f.push([ref(head)]).status, 0);
  writeFileSync(join(f.repo, '.gitleaks.toml'), 'title = "no rules"\n');
  const result = f.push([ref(head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unstaged changes to package files, scripts\/ or Gitleaks settings/);
  assert.equal(result.gitleaks, '');
});

test('both hooks warn, without blocking, when the local Gitleaks is not the version CI pins', (t) => {
  const f = fixture(t);
  // pre-commit scans a staged change; pre-push needs the index to match HEAD.
  const run = (hook, extraEnv) => {
    if (hook === 'pre-push') return f.push([ref(f.head)], undefined, extraEnv);
    writeFileSync(join(f.repo, 'public.txt'), 'staged\n');
    f.git('add', 'public.txt');
    const result = f.commitHook({ extraEnv });
    f.git('checkout', '--quiet', 'HEAD', '--', 'public.txt');
    return result;
  };
  for (const hook of ['pre-commit', 'pre-push']) {
    for (const env of [{}, { FAKE_GITLEAKS_VERSION: 'v8.30.1' }]) {
      const result = run(hook, env);
      assert.equal(result.status, 0, `${hook}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /warning/, hook);
    }
    for (const [env, shown] of [[{ FAKE_GITLEAKS_VERSION: '8.18.0' }, '8.18.0'], [{ FAKE_GITLEAKS_VERSION_FAIL: '1' }, 'unknown']]) {
      const result = run(hook, env);
      assert.equal(result.status, 0, `${hook} ${shown}: ${result.stderr}`);
      assert.match(result.stderr,
        new RegExp(`^${hook}: warning — Gitleaks ${shown} is not the 8\\.30\\.1 CI uses; local scan results may differ\\.$`, 'm'), hook);
      // The scan still runs.
      assert.match(result.gitleaks, /^\[stdin\]/, hook);
    }
  }
  // The hooks' pin is the version CI installs.
  const pinned = readFileSync(new URL('./hooks/lib/gitleaks-settings.sh', import.meta.url), 'utf8')
    .match(/^gitleaks_pinned_version=(\S+)$/m)?.[1];
  const action = readFileSync(new URL('../.github/actions/install-gitleaks/action.yml', import.meta.url), 'utf8');
  assert.equal(pinned, '8.30.1');
  assert.equal(action.match(/^ +version=(\S+)$/m)?.[1], pinned);
  assert.equal(action.match(/^ +- name: Install verified Gitleaks (\S+)$/m)?.[1], pinned);
});

test('pre-push notes, without blocking, pushed commits that change Gitleaks settings or add gitleaks:allow', (t) => {
  const f = fixture(t);
  const commit = (message, files) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(f.repo, name), text);
    f.git('add', ...Object.keys(files));
    f.git('commit', '--quiet', '--no-verify', '-m', message);
    return [f.git('rev-parse', 'HEAD'), f.git('log', '-1', '--format=%h')];
  };
  const note = (hashes) => new RegExp(`^pre-push: note — pushed commits change Gitleaks settings or add gitleaks:allow \\(${hashes}\\); the scan honoured them, so review those changes\\.$`, 'm');
  let result = f.push([ref(f.head)]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /note/);
  const [ignore, ignoreShort] = commit('ignore list', { '.gitleaksignore': '# synthetic\n' });
  result = f.push([ref(ignore, 'refs/heads/main', f.head)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, note(ignoreShort));
  const [allow, allowShort] = commit('allow', { 'allowed.txt': 'example = "synthetic" # gitleaks:allow\n' });
  result = f.push([ref(allow, 'refs/heads/main', ignore)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, note(allowShort));
  assert.equal(result.gitleaks, leakScan(allow), 'the scan is unchanged');
  // Each commit is named once, whichever way it qualifies.
  const [both, bothShort] = commit('both', { '.gitleaksignore': '# synthetic\n# more\n', 'allowed.txt': 'x = 1 # gitleaks:allow\n' });
  result = f.push([ref(both, 'refs/heads/main', f.head)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, note(`${bothShort} ${ignoreShort} ${allowShort}`));
  // A later ordinary commit is not named.
  const [plain] = commit('plain', { 'public.txt': 'plain\n' });
  result = f.push([ref(plain, 'refs/heads/main', both)]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /note/);
  // A history Git cannot read blocks the scan; the note says it could not check.
  const blob = f.git('rev-parse', `${f.first}:public.txt`);
  rmSync(join(f.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  result = f.push([ref(plain)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^pre-push: note — could not check the pushed commits for Gitleaks settings changes or gitleaks:allow\.$/m);
});

test('pre-push notes a gitleaks:allow line or Gitleaks settings change that only a merge resolution adds', (t) => {
  const note = (hashes) => new RegExp(`^pre-push: note — pushed commits change Gitleaks settings or add gitleaks:allow \\(${hashes}\\); the scan honoured them, so review those changes\\.$`, 'm');
  // Neither parent adds the file; only the merge commit's own diff does, and no
  // later commit removes it, since a removal would be named too.
  const mergeOnly = (f, name, text) => {
    f.git('checkout', '--quiet', '-b', 'side');
    writeFileSync(join(f.repo, 'side.txt'), 'side\n');
    f.git('add', 'side.txt');
    f.git('commit', '--quiet', '--no-verify', '-m', 'side change');
    f.git('checkout', '--quiet', 'main');
    writeFileSync(join(f.repo, 'public.txt'), 'main\n');
    f.git('commit', '--quiet', '--no-verify', '-am', 'main change');
    f.git('merge', '--quiet', '--no-ff', '--no-commit', 'side');
    writeFileSync(join(f.repo, name), text);
    f.git('add', name);
    f.git('commit', '--quiet', '--no-verify', '-m', 'merge side');
    return [f.git('rev-parse', 'HEAD'), f.git('log', '-1', '--format=%h')];
  };
  for (const [name, text] of [['allowed.txt', 'example = "synthetic" # gitleaks:allow\n'], ['.gitleaksignore', '# synthetic\n']]) {
    for (const diffMerges of [undefined, 'off']) {
      const f = fixture(t);
      if (diffMerges) f.git('config', 'log.diffMerges', diffMerges);
      const [merge, mergeShort] = mergeOnly(f, name, text);
      const result = f.push([ref(merge, 'refs/heads/main', f.head)]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, note(mergeShort), `${name} log.diffMerges=${diffMerges}`);
    }
  }
});

test('pre-push refuses pushed commits other than HEAD before running checks (other:main bypass)', (t) => {
  const f = fixture(t);
  for (const lines of [[ref(f.first)], [ref(f.head), ref(f.first, 'refs/heads/other')], [ref(f.first).trimEnd()]]) {
    const result = f.push(lines);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pushed commits must be the checked-out HEAD/);
    assert.equal(result.npm, '');
  }
});

test('pre-push refuses when the index differs from HEAD (git rm --cached bypass)', (t) => {
  const f = fixture(t);
  f.git('rm', '--quiet', '--cached', 'public.txt');
  let result = f.push([ref(f.head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staged changes differ from HEAD/);
  assert.equal(result.npm, '');
  f.git('reset', '--quiet');
  // Unstaged edits to ordinary files are not pushed and do not change the checks.
  writeFileSync(join(f.repo, 'public.txt'), 'unstaged\n');
  result = f.push([ref(f.head)]);
  assert.equal(result.status, 0, result.stderr);
});

test('pre-push refuses unstaged edits to the checks or package files', (t) => {
  const f = fixture(t);
  for (const file of ['package.json', ...hookHelpers.map((name) => `scripts/${name}`)]) {
    const original = readFileSync(join(f.repo, file), 'utf8');
    writeFileSync(join(f.repo, file), `${original}// unstaged\n`);
    const result = f.push([ref(f.head)]);
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, /unstaged changes to package files, scripts\/ or Gitleaks settings/);
    assert.equal(result.npm, '');
    writeFileSync(join(f.repo, file), original);
  }
  assert.equal(f.push([ref(f.head)]).status, 0);
});

test('pre-push refuses untracked files under scripts/ (S19-23)', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'scripts/extra.mjs'), '// untracked\n');
  let result = f.push([ref(f.head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /untracked files under scripts/);
  assert.equal(result.npm, '');
  assert.equal(result.gitleaks, '');
  // Ignored files under scripts/ and untracked files elsewhere do not change the checks.
  writeFileSync(join(f.repo, '.gitignore'), 'scripts/extra.mjs\n');
  result = f.push([ref(f.head)]);
  assert.equal(result.status, 0, result.stderr);
  rmSync(join(f.repo, 'scripts/extra.mjs'));
  writeFileSync(join(f.repo, 'notes.txt'), 'untracked\n');
  assert.equal(f.push([ref(f.head)]).status, 0);
});

test('pre-push checks every commit in the pushed range, not only HEAD', (t) => {
  const f = fixture(t, { realRange: true });
  const value = 'synthetic-private-value';
  const commit = (message, write) => {
    write();
    f.git('add', '-A');
    f.git('commit', '--quiet', '--no-verify', '-m', message);
    return f.git('rev-parse', 'HEAD');
  };
  // A private file and an operator Wrangler setting added, then removed.
  commit('add private', () => {
    writeFileSync(join(f.repo, '.dev.vars'), `POLL_SECRET=${value}\n`);
    writeFileSync(join(f.repo, 'wrangler.jsonc'), `{ "account_id": "${value}" }\n`);
  });
  const head = commit('remove private', () => {
    rmSync(join(f.repo, '.dev.vars'));
    rmSync(join(f.repo, 'wrangler.jsonc'));
  });
  let result = f.push([ref(head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.dev\.vars: private file is tracked/);
  assert.match(result.stderr, /wrangler\.jsonc: operator deployment setting/);
  assert.match(result.stderr, /privacy or deployment setup checks failed/);
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(value));
  // Excluding the remote ref's old commit leaves only clean commits.
  result = f.push([ref(head, 'refs/heads/main', head)]);
  assert.equal(result.status, 0, result.stderr);

  // Already-public history is not re-flagged: publish it to a synthetic origin.
  const remote = join(f.repo, '..', 'origin.git');
  f.git('init', '--quiet', '--bare', remote);
  f.git('remote', 'add', 'origin', remote);
  f.git('push', '--quiet', '--no-verify', 'origin', 'main');
  const next = commit('clean', () => writeFileSync(join(f.repo, 'public.txt'), 'third\n'));
  for (const lines of [[ref(next, 'refs/heads/main', head)], [ref(next, 'refs/heads/new')]]) {
    result = f.push(lines);
    assert.equal(result.status, 0, result.stderr);
  }
  // Another remote's history is not public for this push; a URL names no remote.
  f.git('remote', 'add', 'public', 'https://example.test/public.git');
  result = f.push([ref(next, 'refs/heads/new')], ['public', 'https://example.test/public.git']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.dev\.vars: private file is tracked/);
  result = f.push([ref(next, 'refs/heads/new')], [remote, remote]);
  assert.equal(result.status, 1);

  // A private commit email anywhere in the pushed range is blocked.
  f.git('-c', 'user.email=private@example.test', 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'email');
  const email = commit('after email', () => writeFileSync(join(f.repo, 'public.txt'), 'fourth\n'));
  result = f.push([ref(email, 'refs/heads/main', next)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /commit email must use GitHub noreply/);
  assert.doesNotMatch(result.stderr, /private@example/);
});

test('pre-push range checks content added on a merged side branch and by a merge itself (S19-27)', (t) => {
  const f = fixture(t, { realRange: true });
  const value = 'synthetic-private-value';
  // A side branch adds a private file; it is merged, then deleted on main.
  f.git('checkout', '--quiet', '-b', 'side');
  writeFileSync(join(f.repo, '.dev.vars'), `POLL_SECRET=${value}\n`);
  f.git('add', '-A');
  f.git('commit', '--quiet', '--no-verify', '-m', 'side adds private');
  f.git('checkout', '--quiet', 'main');
  writeFileSync(join(f.repo, 'public.txt'), 'main\n');
  f.git('commit', '--quiet', '--no-verify', '-am', 'main change');
  f.git('merge', '--quiet', '--no-ff', '--no-verify', '-m', 'merge side', 'side');
  f.git('rm', '--quiet', '.dev.vars');
  f.git('commit', '--quiet', '--no-verify', '-m', 'delete private');
  const merged = f.git('rev-parse', 'HEAD');
  let result = f.push([ref(merged, 'refs/heads/main', f.head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.dev\.vars: private file is tracked/);
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(value));

  // A merge commit that itself adds a private file; no side-branch commit adds it.
  f.git('checkout', '--quiet', '-b', 'side2');
  writeFileSync(join(f.repo, 'side.txt'), 'side\n');
  f.git('add', '-A');
  f.git('commit', '--quiet', '--no-verify', '-m', 'side change');
  f.git('checkout', '--quiet', 'main');
  writeFileSync(join(f.repo, 'public.txt'), 'main again\n');
  f.git('commit', '--quiet', '--no-verify', '-am', 'main change again');
  f.git('merge', '--quiet', '--no-ff', '--no-commit', 'side2');
  writeFileSync(join(f.repo, 'wrangler.local.jsonc'), '{}\n');
  f.git('add', '-f', 'wrangler.local.jsonc');
  f.git('commit', '--quiet', '--no-verify', '-m', 'merge side2');
  f.git('rm', '--quiet', 'wrangler.local.jsonc');
  f.git('commit', '--quiet', '--no-verify', '-m', 'delete private config');
  const head = f.git('rev-parse', 'HEAD');
  result = f.push([ref(head, 'refs/heads/main', merged)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wrangler\.local\.jsonc: private file is tracked/);
  assert.doesNotMatch(result.stderr, /\.dev\.vars/);
});

test('pre-push blocks when a check fails', (t) => {
  const f = fixture(t, { npmExit: 1 });
  const result = f.push([ref(f.head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /privacy or deployment setup checks failed/);
});

// Stages a synthetic key in the fixture repository.
function stageSyntheticKey(f) {
  const token = syntheticKey();
  writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token}\n`);
  f.git('add', 'config.txt');
  return token;
}

test('Gitleaks is installed when tests run in CI', { skip: !process.env.CI && 'not running in CI' }, () => {
  assert.ok(hasGitleaks, 'CI must install Gitleaks; the real-scan tests would otherwise be skipped');
});

test('pre-commit passes a clean commit, directly and as an installed hook (S19-31)', (t) => {
  const f = fixture(t, { gitleaks: hasGitleaks ? 'real' : 'fake' });
  writeFileSync(join(f.repo, 'public.txt'), 'clean\n');
  f.git('add', 'public.txt');
  assert.equal(f.commitHook().status, 0);
  const before = f.git('rev-parse', 'HEAD');
  const result = f.commitHook({ commit: true });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(f.git('rev-parse', 'HEAD'), before);
});

test('pre-commit ignores Gitleaks configuration variables (S19-31)', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'public.txt'), 'staged\n');
  f.git('add', 'public.txt');
  const result = f.commitHook({ extraEnv: { GITLEAKS_CONFIG: join(f.repo, 'rules.toml'), GITLEAKS_CONFIG_TOML: 'title = "no rules"\n' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.gitleaks, '[stdin][--no-banner][--redact]\n');
});

test('pre-commit Gitleaks scan cannot be emptied by configuration variables (S19-31)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    // A configuration with no rules reports nothing when Gitleaks honours it.
    const rules = join(f.repo, '..', 'rules.toml');
    writeFileSync(rules, 'title = "no rules"\n');
    const token = stageSyntheticKey(f);
    const head = f.git('rev-parse', 'HEAD');
    for (const env of [{}, { GITLEAKS_CONFIG: rules }, { GITLEAKS_CONFIG_TOML: 'title = "no rules"\n' }]) {
      for (const options of [{ extraEnv: env }, { extraEnv: env, commit: true }]) {
        const result = f.commitHook(options);
        const label = JSON.stringify(Object.keys(env)) + (options.commit ? ' git commit' : '');
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        assert.match(result.stderr, /pre-commit: BLOCKED — the secret scan failed or found a secret; see the output above/, label);
        assert.doesNotMatch(result.stderr, /could not read the staged changes/, label);
        assert.doesNotMatch(result.stderr + result.stdout, new RegExp(token.slice(4)), label);
      }
    }
    assert.equal(f.git('rev-parse', 'HEAD'), head, 'no commit was made');
  });

test('pre-commit refuses untracked, ignored or unstaged Gitleaks settings (S19-31)', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'public.txt'), 'staged\n');
  f.git('add', 'public.txt');
  for (const file of ['.gitleaks.toml', '.gitleaksignore']) {
    writeFileSync(join(f.repo, file), 'title = "no rules"\n');
    let result = f.commitHook();
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, new RegExp(`untracked or ignored \\${file} would change the secret scan`));
    assert.equal(result.gitleaks, '');
    // Ignoring it does not hide it from Gitleaks, so it still blocks.
    writeFileSync(join(f.repo, '.git', 'info', 'exclude'), `${file}\n`);
    result = f.commitHook();
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, /would change the secret scan/);
    assert.equal(result.gitleaks, '');
    rmSync(join(f.repo, '.git', 'info', 'exclude'));
    rmSync(join(f.repo, file));
  }
  // A staged configuration is part of the reviewed commit; unstaged edits are not.
  writeFileSync(join(f.repo, '.gitleaksignore'), '# synthetic\n');
  f.git('add', '.gitleaksignore');
  assert.equal(f.commitHook().status, 0);
  writeFileSync(join(f.repo, '.gitleaksignore'), '# synthetic\nsynthetic-fingerprint\n');
  const result = f.commitHook();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unstaged changes to Gitleaks settings would change the secret scan/);
  assert.equal(result.gitleaks, '');
});

test('pre-commit blocks when Git cannot read the staged changes (S19-31)', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'staged.txt'), 'staged only\n');
  f.git('add', 'staged.txt');
  // The staged blob is read only by the scan's diff. Git would reuse a matching
  // working-tree file instead, so the file is removed too.
  const blob = f.git('rev-parse', ':staged.txt');
  rmSync(join(f.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  rmSync(join(f.repo, 'staged.txt'));
  const result = f.commitHook();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pre-commit: BLOCKED — could not read the staged changes for the secret scan\.\n/);
  assert.doesNotMatch(result.stderr, /or the scan failed|found a secret/);
});

test('pre-commit reports a Gitleaks that exits before reading a large staged diff as a scan or read failure (C62)', (t) => {
  const f = fixture(t);
  // Well beyond any pipe buffer, so Git fails on the closed pipe.
  writeFileSync(join(f.repo, 'large.txt'), `${'synthetic filler line for the staged diff\n'.repeat(40000)}`);
  f.git('add', 'large.txt');
  const head = f.git('rev-parse', 'HEAD');
  // Like Gitleaks on a bad configuration: fails without reading standard input.
  writeFileSync(join(f.repo, '..', 'bin', 'gitleaks'), '#!/bin/sh\nprintf \'synthetic gitleaks error\\n\' >&2\nexit 1\n',
    { mode: 0o700 });
  for (const options of [{}, { commit: true }]) {
    const label = options.commit ? 'git commit' : 'hook';
    const result = f.commitHook(options);
    assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    assert.match(result.stderr, /synthetic gitleaks error/, label);
    assert.match(result.stderr,
      /pre-commit: BLOCKED — could not read the staged changes for the secret scan, or the scan failed; see the output above/, label);
    assert.doesNotMatch(result.stderr, /secret scan\.\n|found a secret/, label);
  }
  // A Gitleaks that reads everything and exits non-zero names only the scan.
  writeFileSync(join(f.repo, '..', 'bin', 'gitleaks'), '#!/bin/sh\ncat >/dev/null\nexit 1\n', { mode: 0o700 });
  const result = f.commitHook();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /pre-commit: BLOCKED — the secret scan failed or found a secret; see the output above/);
  assert.doesNotMatch(result.stderr, /could not read the staged changes/);
  assert.equal(f.git('rev-parse', 'HEAD'), head, 'no commit was made');
});

test('pre-commit passes a commit that removes a committed secret, but blocks an added one (C63)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const secret = new RegExp(token.slice(4));
    writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token}\nregion = one\n`);
    f.git('add', 'config.txt');
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic secret committed without the hook');
    const run = (options) => [options.commit ? 'git commit' : 'hook', f.commitHook(options)];
    // Removing the secret, as the pre-push advice asks, leaves it as a removed line.
    f.git('rm', '--quiet', '--force', 'config.txt');
    let head = f.git('rev-parse', 'HEAD');
    for (const options of [{}, { commit: true }]) {
      const [label, result] = run(options);
      assert.equal(result.status, 0, `removal ${label}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
    }
    assert.notEqual(f.git('rev-parse', 'HEAD'), head, 'the removal was committed');
    // Adding a secret is still blocked, including one on a line that replaces a removed one.
    stageSyntheticKey(f);
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic secret committed without the hook again');
    writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token} # replaced\n`);
    writeFileSync(join(f.repo, 'other.txt'), `aws_access_key_id = ${token}\n`);
    f.git('add', 'config.txt', 'other.txt');
    head = f.git('rev-parse', 'HEAD');
    for (const options of [{}, { commit: true }]) {
      const [label, result] = run(options);
      assert.equal(result.status, 1, `addition ${label}: ${result.stderr}`);
      assert.match(result.stderr, /pre-commit: BLOCKED — the secret scan failed or found a secret; see the output above/, label);
      assert.doesNotMatch(result.stderr, /could not read the staged changes/, label);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
    }
    assert.equal(f.git('rev-parse', 'HEAD'), head, 'no commit was made');
  });

test('hunk-header or GIT_DIFF_OPTS context naming a committed secret does not block an edit below it, but an added secret still blocks (C64 C68)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const secret = new RegExp(token.slice(4));
    const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    // GIT_DIFF_OPTS overrides -U0 on the command line, adding the key line back as context.
    const diffOpts = { GIT_DIFF_OPTS: '--unified=3' };
    const scan = (extra, ...args) =>
      spawnSync('/bin/sh', ['scripts/secret-scan.sh', ...args], { cwd: f.repo, env: { ...env, ...extra }, encoding: 'utf8' });
    const run = (options) => [(options.extraEnv ? 'GIT_DIFF_OPTS ' : '') +
      (options.commit ? 'git commit' : 'hook'), f.commitHook(options)];
    const hooks = [{}, { extraEnv: diffOpts }];
    writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token}\nregion = one\n`);
    f.git('add', 'config.txt');
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic secret committed without the hook');
    const committed = f.git('rev-parse', 'HEAD');
    // Editing the line below it: even with -U0, Git names the key line in the hunk header.
    const header = new RegExp(`^@@ -2 \\+2 @@ aws_access_key_id = ${token}$`, 'm');
    writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token}\nregion = two\n`);
    f.git('add', 'config.txt');
    assert.match(f.git('diff', '--cached', '-U0'), header);
    for (const options of [...hooks, { extraEnv: diffOpts, commit: true }]) {
      const [label, result] = run(options);
      assert.equal(result.status, 0, `edit ${label}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
    }
    const edited = f.git('rev-parse', 'HEAD');
    assert.notEqual(edited, committed, 'the edit was committed');
    assert.match(f.git('log', '-p', '-U0', '-1'), header);
    for (const extra of [{}, diffOpts]) {
      const label = JSON.stringify(Object.keys(extra));
      let result = f.push([ref(edited, 'refs/heads/main', committed)], undefined, extra);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
      result = scan(extra, edited, '--not', committed);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    }
    // A key added on the line after such a hunk header is still blocked.
    writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token}\nregion = two\naws_access_key_id = ${token} # added\n`);
    f.git('add', 'config.txt');
    for (const options of [...hooks, { commit: true }, { extraEnv: diffOpts, commit: true }]) {
      const [label, result] = run(options);
      assert.equal(result.status, 1, `addition ${label}: ${result.stderr}`);
      assert.match(result.stderr, /pre-commit: BLOCKED — the secret scan failed or found a secret; see the output above/, label);
      assert.doesNotMatch(result.stderr, /could not read the staged changes/, label);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
    }
    assert.equal(f.git('rev-parse', 'HEAD'), edited, 'no commit was made');
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic secret added without the hook');
    const added = f.git('rev-parse', 'HEAD');
    for (const extra of [{}, diffOpts]) {
      const label = JSON.stringify(Object.keys(extra));
      let result = f.push([ref(added, 'refs/heads/main', edited)], undefined, extra);
      assert.equal(result.status, 1, `${label}: ${result.stderr}`);
      assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/, label);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
      result = scan(extra, added, '--not', edited);
      assert.equal(result.status, 1, `${label}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
    }
  });

test('secret-scan.sh scans commit messages whatever format.pretty prints (C65)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const secret = new RegExp(token.slice(4));
    const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    const scan = (...args) => spawnSync('/bin/sh', ['scripts/secret-scan.sh', ...args], { cwd: f.repo, env, encoding: 'utf8' });
    const base = f.git('rev-parse', 'HEAD');
    // format:%H%n%B prints the message unindented, so a "- " line looked like a
    // removed line; oneline prints only the subject, not the key on line 3.
    for (const [pretty, body] of [['oneline', `aws_access_key_id = ${token}`], ['format:%H%n%B', `- aws_access_key_id = ${token}`]]) {
      f.git('commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'synthetic message secret', '-m', body);
      const commit = f.git('rev-parse', 'HEAD');
      f.git('config', 'format.pretty', pretty);
      let result = scan(commit, '--not', base);
      assert.equal(result.status, 1, `${pretty}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, secret, pretty);
      result = f.push([ref(commit, 'refs/heads/main', base)]);
      assert.equal(result.status, 1, `${pretty} push: ${result.stderr}`);
      assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/, pretty);
      assert.doesNotMatch(result.stderr + result.stdout, secret, pretty);
      // Control: the same commit without the setting.
      f.git('config', '--unset', 'format.pretty');
      result = scan(commit, '--not', base);
      assert.equal(result.status, 1, `${pretty} control: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, secret, pretty);
      f.git('reset', '--quiet', '--hard', base);
    }
    // i18n.logOutputEncoding re-encodes messages, for example into UTF-16, where
    // an ASCII key is no longer a byte sequence Gitleaks matches.
    f.git('commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'synthetic message secret',
      '-m', `aws_access_key_id = ${token}`);
    const commit = f.git('rev-parse', 'HEAD');
    for (const encoding of ['UTF-16', 'ISO-8859-1']) {
      f.git('config', 'i18n.logOutputEncoding', encoding);
      const result = scan(commit, '--not', base);
      assert.equal(result.status, 1, `${encoding}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, secret, encoding);
    }
  });

test('secret-scan.sh scans commit messages whatever encoding header the commit declares (C69)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const secret = new RegExp(token.slice(4));
    const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    const scan = (...args) => spawnSync('/bin/sh', ['scripts/secret-scan.sh', ...args], { cwd: f.repo, env, encoding: 'utf8' });
    const base = f.git('rev-parse', 'HEAD');
    // The message bytes are ASCII, but the header declares UTF-16; with an
    // even-length body, converting to UTF-8 pairs the bytes into other characters.
    let body = `aws_access_key_id = ${token}`;
    if (body.length % 2) body += '.';
    f.git('-c', 'i18n.commitEncoding=UTF-16', 'commit', '--quiet', '--no-verify', '--allow-empty',
      '-m', 'x', '-m', body);
    const commit = f.git('rev-parse', 'HEAD');
    assert.match(f.git('cat-file', 'commit', commit), /^encoding UTF-16$/m);
    // Precondition: re-encoding hides the key, so this commit exercises the bypass.
    assert.doesNotMatch(f.git('log', '-1', '--encoding=UTF-8', commit), secret);
    for (const encoding of [null, 'UTF-16', 'ISO-8859-1']) {
      const label = encoding ?? 'default';
      if (encoding) f.git('config', 'i18n.logOutputEncoding', encoding);
      let result = scan(commit, '--not', base);
      assert.equal(result.status, 1, `${label}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
      result = f.push([ref(commit, 'refs/heads/main', base)]);
      assert.equal(result.status, 1, `${label} push: ${result.stderr}`);
      assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/, label);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
    }
  });

test('diff.interHunkContext cannot turn a committed secret between two edits into scanned context (C66)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const secret = new RegExp(token.slice(4));
    const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    const scan = (...args) => spawnSync('/bin/sh', ['scripts/secret-scan.sh', ...args], { cwd: f.repo, env, encoding: 'utf8' });
    const run = (options) => [options.commit ? 'git commit' : 'hook', f.commitHook(options)];
    f.git('config', 'diff.interHunkContext', '1');
    writeFileSync(join(f.repo, 'config.txt'), `region = one\naws_access_key_id = ${token}\nzone = one\n`);
    f.git('add', 'config.txt');
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic secret committed without the hook');
    const committed = f.git('rev-parse', 'HEAD');
    // Editing lines 1 and 3: with the setting, -U0 alone merges the two hunks and
    // shows the key line between them as context.
    writeFileSync(join(f.repo, 'config.txt'), `region = two\naws_access_key_id = ${token}\nzone = two\n`);
    f.git('add', 'config.txt');
    assert.match(f.git('diff', '--cached', '-U0'), new RegExp(`^ aws_access_key_id = ${token}$`, 'm'));
    for (const options of [{}, { commit: true }]) {
      const [label, result] = run(options);
      assert.equal(result.status, 0, `edit ${label}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
    }
    const edited = f.git('rev-parse', 'HEAD');
    assert.notEqual(edited, committed, 'the edit was committed');
    let result = f.push([ref(edited, 'refs/heads/main', committed)]);
    assert.equal(result.status, 0, result.stderr);
    result = scan(edited, '--not', committed);
    assert.equal(result.status, 0, result.stderr);
    // Adding a key is still blocked.
    writeFileSync(join(f.repo, 'config.txt'),
      `region = three\naws_access_key_id = ${token}\nzone = two\naws_access_key_id = ${token} # added\n`);
    f.git('add', 'config.txt');
    for (const options of [{}, { commit: true }]) {
      const [label, result] = run(options);
      assert.equal(result.status, 1, `addition ${label}: ${result.stderr}`);
      assert.match(result.stderr, /pre-commit: BLOCKED — the secret scan failed or found a secret; see the output above/, label);
      assert.doesNotMatch(result.stderr + result.stdout, secret, label);
    }
    assert.equal(f.git('rev-parse', 'HEAD'), edited, 'no commit was made');
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic secret added without the hook');
    const added = f.git('rev-parse', 'HEAD');
    result = scan(added, '--not', edited);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr + result.stdout, secret);
  });

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

test('the repository Gitleaks rule blocks low-entropy values of its secret names (T1-5)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    // Gitleaks' default allowlist treats one repeated character as a placeholder,
    // so the low-entropy fixture alternates two.
    const value = 'ab'.repeat(10);
    const text = assignment('IVAO_WEBHOOK_SECRET', value);
    // Default rules alone miss it, so only the repository rule can block it.
    commitRules(f, '[extend]\nuseDefault = true\n');
    let { hook, scan } = scanAssignment(f, text);
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
    commitRules(f, repoRules());
    for (const [name, quoted] of [['IVAO_WEBHOOK_SECRET', text], ['POLL_SECRET', `POLL_SECRET: '${value}',\n`],
      ['HISTORY_SECRET', `export HISTORY_SECRET=${value}\n`], ['IVAO_CLIENT_SECRET', `"IVAO_CLIENT_SECRET": "${value}"\n`],
      ['DISCORD_BOT_TOKEN', `DISCORD_BOT_TOKEN = ${value}\n`]]) {
      ({ hook, scan } = scanAssignment(f, quoted));
      for (const result of hook) {
        assert.equal(result.status, 1, `${name}: ${result.stderr}`);
        assert.match(result.stderr, /pre-commit: BLOCKED — the secret scan failed or found a secret/, name);
        assert.doesNotMatch(result.stderr + result.stdout, new RegExp(value), name);
      }
      assert.equal(scan.status, 1, `${name}: ${scan.stderr}`);
      assert.doesNotMatch(scan.stderr + scan.stdout, new RegExp(value), name);
    }
    // Shorter values and empty placeholders are not flagged.
    ({ hook, scan } = scanAssignment(f, assignment('POLL_SECRET', 'a'.repeat(15)) + assignment('HISTORY_SECRET', '')));
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

test('the repository Gitleaks allowlist matches whole synthetic fixture values only (T1-5)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const value of ['aaaaaaaa-synthetic-aaaaaaaa', 'notsynthetic-aaaaaaaaaaaa', 'synthetic-aaaaaaaa.aaaaaaaa',
      'aaaatest-poll-secret', 'test-poll-secret-aaaa', 'env.POLL_SECRET.aaaaaaaa', 'aaaaaaaa.env.POLL_SECRET']) {
      const { hook, scan } = scanAssignment(f, assignment('IVAO_WEBHOOK_SECRET', value));
      for (const result of hook) assert.equal(result.status, 1, `${value}: ${result.stderr}`);
      assert.equal(scan.status, 1, `${value}: ${scan.stderr}`);
    }
    // A fixture value, and a code reference to a binding rather than a value.
    const reference = (name) => `${name}: env.${name},\n`;
    const { hook, scan } = scanAssignment(f, assignment('IVAO_WEBHOOK_SECRET', 'synthetic-webhook-fixture-0123')
      + reference('POLL_SECRET'));
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

test('privacy checks reject private emails in commit trailers, allowing noreply co-authors (T1-5)', (t) => {
  const f = fixture(t, { realRange: true });
  const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const check = (...args) => spawnSync(process.execPath, ['scripts/check-privacy.mjs', ...args], { cwd: f.repo, env, encoding: 'utf8' });
  f.git('commit', '--quiet', '--no-verify', '--allow-empty', '-m',
    'co-authored\n\nCo-Authored-By: Synthetic Model <noreply@anthropic.com>');
  const allowed = f.git('rev-parse', 'HEAD');
  assert.equal(check().status, 0, check().stderr);
  assert.equal(f.push([ref(allowed)]).status, 0);
  f.git('commit', '--quiet', '--no-verify', '--allow-empty', '-m',
    'co-authored\n\nCo-authored-by: Person <person@example.test>');
  const head = f.git('rev-parse', 'HEAD');
  for (const result of [check(), check('--range', head, zero, 'origin'), f.push([ref(head, 'refs/heads/main', allowed)])]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /commit trailer email must use a noreply address/);
    assert.doesNotMatch(result.stderr + result.stdout, /person@example/);
  }
});

test('privacy checks reject private emails anywhere in commit messages, however encoded (NX-2a)', (t) => {
  const f = fixture(t, { realRange: true });
  const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const check = (...args) => spawnSync(process.execPath, ['scripts/check-privacy.mjs', ...args], { cwd: f.repo, env, encoding: 'utf8' });
  // Assembled at runtime, so this address never appears literally in this file.
  const person = ['person', 'example.invalid'].join('@');
  const leaked = /person|example\.invalid/;
  const commit = (message, config = []) => {
    f.git(...config, 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', message);
    return f.git('rev-parse', 'HEAD');
  };
  // Tabs, URL handles and noreply identities in a message pass.
  const clean = commit('synthetic\tsubject\n\nSee https://social.example/@person and pkg@1.2.3'
    + '\n\nCo-Authored-By: Synthetic Model <noreply@anthropic.com>');
  assert.equal(check().status, 0, check().stderr);
  assert.equal(f.push([ref(clean)]).status, 0);
  const head = commit(`synthetic\n\nContact ${person}\tfor access`);
  for (const result of [check(), check('--range', head, zero, 'origin'), f.push([ref(head, 'refs/heads/main', clean)])]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^[0-9a-f]{12}: commit message email must use a noreply address$/m);
    assert.doesNotMatch(result.stderr, /commit trailer email|commit email must use/);
    assert.doesNotMatch(result.stderr + result.stdout, leaked);
  }
  // A log output encoding cannot hide the address; --encoding=none keeps rows parseable.
  f.git('config', 'i18n.logOutputEncoding', 'UTF-16');
  let base = head;
  for (const config of [[], ['-c', 'i18n.commitEncoding=ISO-8859-1']]) {
    const oid = commit(`synthetic encoded\n\nContact ${person}`, config);
    assert.doesNotMatch(f.git('log', '-1', '--format=%B', oid), leaked);
    for (const result of [check('--range', oid, base), f.push([ref(oid, 'refs/heads/main', base)])]) {
      assert.equal(result.status, 1, config.join(' '));
      assert.match(result.stderr, /^[0-9a-f]{12}: commit message email must use a noreply address$/m, config.join(' '));
      // A non-UTF-8 encoding header now fails closed by itself too (NX-7 #10).
      if (config.length) assert.match(result.stderr, /^[0-9a-f]{12}: commit encoding must be UTF-8$/m);
      assert.doesNotMatch(result.stderr + result.stdout, leaked);
    }
    base = oid;
  }
  // --format converts an ASCII-incompatible message encoding, headers included,
  // to UTF-8, so the identities vanish and the commit still fails closed.
  const utf16 = commit(`synthetic encoded\n\nContact ${person}`, ['-c', 'i18n.commitEncoding=UTF-16']);
  for (const result of [check('--range', utf16, base), f.push([ref(utf16, 'refs/heads/main', base)])]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^[0-9a-f]{12}: commit (?:message )?email must use /m);
    assert.doesNotMatch(result.stderr + result.stdout, leaked);
  }
});

test('pre-push names commits whose message carries gitleaks:allow, however encoded (ROT-1)', (t) => {
  const note = (hashes) => new RegExp(`^pre-push: note — pushed commits change Gitleaks settings or add gitleaks:allow \\(${hashes}\\); the scan honoured them, so review those changes\\.$`, 'm');
  const f = fixture(t);
  let base = f.head;
  let n = 0;
  const commit = (message, { file = 'public.txt', text, config = [] } = {}) => {
    writeFileSync(join(f.repo, file), text ?? `change ${++n}\n`);
    f.git('add', file);
    f.git(...config, 'commit', '--quiet', '--no-verify', '-m', message);
    return [f.git('rev-parse', 'HEAD'), f.git('log', '-1', '--encoding=none', '--format=%h')];
  };
  const pushNew = (oid) => {
    const result = f.push([ref(oid, 'refs/heads/main', base)]);
    base = oid;
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  // Message only, in any case.
  let [oid, short] = commit('synthetic change\n\nGitleaks:Allow');
  assert.match(pushNew(oid).stderr, note(short));
  // A UTF-16 encoding header, then a UTF-16 log output encoding, cannot hide it.
  [oid, short] = commit('synthetic gitleaks:allow', { config: ['-c', 'i18n.commitEncoding=UTF-16'] });
  assert.match(pushNew(oid).stderr, note(short));
  f.git('config', 'i18n.logOutputEncoding', 'UTF-16');
  [oid, short] = commit('synthetic gitleaks:allow again');
  assert.match(pushNew(oid).stderr, note(short));
  f.git('config', '--unset', 'i18n.logOutputEncoding');
  // A merge carrying it in its message.
  f.git('checkout', '--quiet', '-b', 'side');
  commit('side change', { file: 'side.txt' });
  f.git('checkout', '--quiet', 'main');
  f.git('merge', '--quiet', '--no-ff', '--no-verify', '-m', 'merge side gitleaks:allow', 'side');
  const merge = f.git('rev-parse', 'HEAD');
  const mergeShort = f.git('log', '-1', '--format=%h');
  const sideShort = f.git('log', '-1', '--format=%h', 'side');
  const mergeResult = pushNew(merge);
  assert.match(mergeResult.stderr, note(mergeShort));
  assert.doesNotMatch(mergeResult.stderr, new RegExp(sideShort));
  // In both the message and the diff: named once.
  [oid, short] = commit('both gitleaks:allow', { file: 'allowed.txt', text: 'x = 1 # gitleaks:allow\n' });
  assert.match(pushNew(oid).stderr, note(short));
  // A plain commit is not named.
  [oid] = commit('plain');
  assert.doesNotMatch(pushNew(oid).stderr, /note/);
});

test('pre-push names commits whose author or changed path carries gitleaks:allow (NX-1c)', (t) => {
  const note = (hashes) => new RegExp(`^pre-push: note — pushed commits change Gitleaks settings or add gitleaks:allow \\(${hashes}\\); the scan honoured them, so review those changes\\.$`, 'm');
  const f = fixture(t);
  // Stored names map to other names here, so the stored and mailmapped
  // identities differ; the scan prints either, depending on log.mailmap.
  const mailmap = join(f.repo, '..', 'mailmap');
  writeFileSync(mailmap, 'Synthetic GitLeaks:Allow <mapped@example.test>\nPlain Name <raw@example.test>\n');
  f.git('config', 'mailmap.file', mailmap);
  let base = f.head;
  let n = 0;
  const commit = ({ author, file = 'public.txt', rename } = {}) => {
    const config = author ? ['-c', `user.name=${author[0]}`, '-c', `user.email=${author[1]}`] : [];
    if (rename) f.git('mv', rename, file);
    else {
      writeFileSync(join(f.repo, file), `change ${++n}\n`);
      f.git('add', file);
    }
    f.git(...config, 'commit', '--quiet', '--no-verify', '-m', 'synthetic change');
    return [f.git('rev-parse', 'HEAD'), f.git('log', '-1', '--format=%h')];
  };
  const pushNew = (oid) => {
    const result = f.push([ref(oid, 'refs/heads/main', base)]);
    base = oid;
    assert.equal(result.status, 0, result.stderr);
    return result.stderr;
  };
  for (const [label, author] of [['author name', ['Synthetic gitleaks:allow', 'synthetic@example.test']],
    ['author email', ['Synthetic', 'GITLEAKS:ALLOW@example.test']],
    ['mailmapped name only', ['Mapped Author', 'mapped@example.test']],
    ['stored name only', ['Raw gitleaks:allow', 'raw@example.test']]]) {
    const [oid, short] = commit({ author });
    assert.match(pushNew(oid), note(short), label);
  }
  // A path, added or as either side of a rename, without the marker in any
  // line of the diff: -G alone would not name these commits.
  const marked = 'notes-GitLeaks:Allow.txt';
  let [oid, short] = commit({ file: marked });
  assert.match(pushNew(oid), note(short), 'added path');
  [oid, short] = commit({ file: 'renamed.txt', rename: marked });
  assert.match(pushNew(oid), note(short), 'renamed from');
  [oid, short] = commit({ file: `again-${marked}`, rename: 'renamed.txt' });
  assert.match(pushNew(oid), note(short), 'renamed to');
  // A path only a merge resolution adds.
  f.git('checkout', '--quiet', '-b', 'side');
  commit({ file: 'side.txt' });
  f.git('checkout', '--quiet', 'main');
  commit();
  f.git('merge', '--quiet', '--no-ff', '--no-commit', 'side');
  writeFileSync(join(f.repo, 'merge-gitleaks:allow.txt'), 'merge\n');
  f.git('add', 'merge-gitleaks:allow.txt');
  f.git('commit', '--quiet', '--no-verify', '-m', 'merge side');
  const merge = f.git('rev-parse', 'HEAD');
  assert.match(pushNew(merge), note(f.git('log', '-1', '--format=%h')), 'merge-only path');
  // Ordinary commits by an ordinary author are not named.
  [oid] = commit();
  assert.doesNotMatch(pushNew(oid), /note/);
});

test('pre-push prints the could-not-check note when the message search fails (ROT-1)', (t) => {
  const f = fixture(t);
  const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(f.repo, '..', 'bin', 'git'), `#!/bin/sh
for arg in "$@"; do case "$arg" in --grep=*) exit 1 ;; esac; done
exec "${realGit}" "$@"
`, { mode: 0o700 });
  const result = f.push([ref(f.head)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^pre-push: note — could not check the pushed commits for Gitleaks settings changes or gitleaks:allow\.$/m);
});

// ROT-1: operator Discord IDs and private JSON settings. Values are built at
// runtime so this file never holds an assignment the rules would flag.
const realShaped = ['7341258963', '14752089'].join('');
const otherReal = ['8862014473', '20518630'].join('');

test('the repository Gitleaks rules block real-shaped Discord IDs and private JSON literals, redacted (ROT-1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const blocked = (text, secret, label) => {
      const { hook, scan } = scanAssignment(f, text);
      for (const result of hook) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        assert.doesNotMatch(result.stderr + result.stdout, new RegExp(secret), label);
      }
      assert.equal(scan.status, 1, `${label}: ${scan.stderr}`);
      assert.doesNotMatch(scan.stderr + scan.stdout, new RegExp(secret), label);
    };
    for (const name of ['MENTION_ROLE_ID', 'GCA_DISCORD_GUILD_ID', 'GCA_MEMBER_ROLE_ID', 'GCA_VERIFIED_ROLE_ID',
      'GCA_COPY_USER_ID', 'DISCORD_CHANNEL_IDS']) blocked(assignment(name, realShaped), realShaped, name);
    blocked(assignment('DISCORD_CHANNEL_IDS', `900000000000000001,${otherReal}`), otherReal, 'mixed list');
    const vid = ['73', '4125'].join('');
    for (const name of ['GCA_REGIONS', 'GCA_APPROVALS', 'GCA_HOME_OVERRIDES', 'FIR_LABELS']) {
      blocked(`${name}='{"${vid}":"AC"}'\n`, vid, name);
    }
    // Setting names match in any case.
    const lower = (name) => name.toLowerCase();
    blocked(assignment(lower('GCA_MEMBER_ROLE_ID'), realShaped), realShaped, 'lowercase ID name');
    blocked(`${lower('GCA_HOME_OVERRIDES')}='{"${vid}":"AC"}'\n`, vid, 'lowercase JSON name');
  });

test('the repository Gitleaks rules pass synthetic IDs, empty values, references and expressions (ROT-1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const reference = (name) => `${name}: env.${name},\n`;
    const text = assignment('GCA_MEMBER_ROLE_ID', '100000000000000002')
      + assignment('DISCORD_CHANNEL_IDS', '900000000000000001,900000000000000002')
      + assignment('MENTION_ROLE_ID', '') + assignment('GCA_COPY_USER_ID', '200000000000000099')
      + `GCA_APPROVALS='{}'\nFIR_LABELS='[]'\n` + reference('GCA_DISCORD_GUILD_ID') + 'GCA_VERIFIED_ROLE_ID: VERIFIED,\n'
      + "GCA_REGIONS: JSON.stringify({ AA: { name: 'Example', prefixes: ['XA'] } }),\n"
      + `GCA_HOME_OVERRIDES: '{"600001":"ZZ"}',\n`;
    const { hook, scan } = scanAssignment(f, text);
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

// NX-1c: multi-line private JSON literals and deployment settings in dotenv or
// shell lines. Setting names are joined at runtime, so this file never holds a
// line the rules would flag. Prefixes that must be flagged start with J, which
// no ICAO region uses, so no real region appears here.
const firPrefixes = ['FIR', 'PREFIXES'].join('_');
const coordinatorName = ['COORDINATOR', 'NAME'].join('_');

test('the repository Gitleaks rules block multi-line JSON literals and deployment settings, redacted (NX-1c)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // Each line sits between others, so the match is mid-stream in the scanned log.
    // `secret` is text on the matched line that redacted output never shows.
    const blocked = (line, secret, label) => {
      const { hook, scan } = scanAssignment(f, `# synthetic settings\n${line}# end\n`);
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        if (secret) assert.ok(!(result.stderr + result.stdout).includes(secret), label);
      }
    };
    blocked(`${firPrefixes}="XD, JD"\n`, 'XD, JD', 'quoted list with one real-looking prefix');
    blocked(`${firPrefixes}=JD\n`, '=JD', 'unquoted prefix');
    blocked(`${firPrefixes}=XD, JD # note\n`, 'XD, JD', 'unquoted list read to the comment, as dotenv does');
    blocked(`export ${coordinatorName}="synthetic realname"\n`, 'realname', 'quoted name with a space');
    blocked(`${coordinatorName}=prod-state\n`, 'prod-state', 'unquoted name');
    blocked(`${coordinatorName}='prod state'\n`, 'prod state', 'single-quoted name');
    const vid = ['73', '4125'].join('');
    for (const [name, open, close] of [['GCA_REGIONS', '{', '}'], ['GCA_APPROVALS', '{', '}'],
      ['GCA_HOME_OVERRIDES', '{', '}'], ['FIR_LABELS', '[', ']'], ['gca_regions', '{', '}']]) {
      // The match is the opening line, so its text is checked; the VID on the next line is never printed either.
      const opening = `${name}='${open}`;
      blocked(`${opening}\n  "${vid}": "AC"\n${close}'\n`, opening, `multi-line ${name}`);
    }
  });

test('the repository Gitleaks rules pass synthetic deployment settings, empty values, code and expressions (NX-1c)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const text = `${firPrefixes}="XD,QC"\n${firPrefixes}=""\n${firPrefixes}=xd, q,\n`
      + `${coordinatorName}=synthetic-state\n${coordinatorName}=synthetic-state # note\n${coordinatorName}=''\n`
      // Not dotenv or shell lines: TypeScript fixtures, code and commands.
      + `  ${firPrefixes}: 'XD',\nexport const ${coordinatorName} = 'onfreq';\n`
      + `npx wrangler secret put ${firPrefixes}\n`
      // Dotenv names are case-sensitive, so a lowercase name sets nothing.
      + `${firPrefixes.toLowerCase()}=JD\n`
      + "GCA_REGIONS: JSON.stringify({\n  AA: { name: 'Example', prefixes: ['XA'] },\n}),\n";
    const { hook, scan } = scanAssignment(f, text);
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

// NX-2c: the first line of a pretty-printed private JSON literal. Every flagged
// line is assembled at runtime from a joined setting name, so this file never
// holds one; the lines that must pass are written out.
const jsonName = (...parts) => parts.join('_');

test('the repository Gitleaks rules block the first line of a pretty-printed JSON literal, redacted (NX-2c)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // Each literal continues on later lines, so neither single-line nor bare-bracket rule applies.
    const blocked = (line, secret, rest) => {
      const { hook, scan } = scanAssignment(f, `# synthetic settings\n${line}${rest}# end\n`);
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${line}: ${result.stderr}`);
        assert.ok(!(result.stderr + result.stdout).includes(secret), line);
      }
    };
    const key = ['JD', 'DD'].join('');
    for (const [line, secret, rest] of [
      [`${jsonName('GCA', 'REGIONS')}='{"${key}": [\n`, `{"${key}": [`, '    "JD"\n  ]\n}\'\n'],
      [`export ${jsonName('GCA', 'APPROVALS')}={"a": {\n`, '{"a": {', '  "b": 1\n}}\n'],
      [`${jsonName('FIR', 'LABELS')} = [{"x": 1},\n`, '[{"x": 1},', '  {"y": 2}]\n'],
      // Shell-escaped quotes, a key whose value starts on the next line, nested
      // brackets, a lowercase name, a CRLF line and a TypeScript property.
      [`${jsonName('GCA', 'HOME', 'OVERRIDES')}="{\\"${key}\\": {\n`, `{\\"${key}\\": {`, '  \\"b\\": 1\n}}"\n'],
      [`${jsonName('GCA', 'REGIONS')}='{"${key}":\n`, `{"${key}":`, '  ["JD"]\n}\'\n'],
      [`${jsonName('gca', 'regions')}='[ {"${key}": [\n`, `[ {"${key}": [`, '  "JD"]}]\'\n'],
      [`${jsonName('FIR', 'LABELS')}='{"${key}": "Synthetic",\r\n`, `{"${key}": "Synthetic",`, '  "JDXX": "Other"\r\n}\'\r\n'],
      [`  ${jsonName('GCA', 'APPROVALS')}: \`{"${key}": [\n`, `{"${key}": [`, '    "1"\n  ]}`,\n'],
    ]) blocked(line, secret, rest);
  });

test('the repository Gitleaks rules pass JSON expressions, empty and fixture values and unquoted keys (NX-2c)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // A quote or backtick ends the value, so later code on the line is not read as JSON.
    const text = "  GCA_APPROVALS: '{}', GCA_HOME_OVERRIDES: JSON.stringify({\n    JDDD: ['JD'],\n  }),\n"
      + "  GCA_REGIONS: JSON.stringify({\n    AA: { name: 'Example', prefixes: ['XA'] },\n  }),\n"
      + "GCA_REGIONS='{}'\n"
      // The single-line rule's published synthetic fixture.
      + `  GCA_HOME_OVERRIDES: '{"600001":"ZZ"}',\n`
      // TypeScript object literals without a quoted key.
      + 'const GCA_REGIONS = { JDDD: [\n  \'JD\',\n] };\nconst FIR_LABELS = [{ x: 1 },\n  { y: 2 }];\n';
    const { hook, scan } = scanAssignment(f, text);
    for (const result of hook) assert.equal(result.status, 0, result.stderr);
    assert.equal(scan.status, 0, scan.stderr);
  });

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

test('both scans feed Gitleaks a preamble and a blank line after every line outside runs (RA)', (t) => {
  const f = fixture(t);
  const saved = join(f.repo, '..', 'stream.txt');
  writeFileSync(join(f.repo, 'public.txt'), 'staged\nsecond line\n');
  f.git('add', 'public.txt');
  let result = f.commitHook({ extraEnv: { GITLEAKS_STDIN: saved } });
  assert.equal(result.status, 0, result.stderr);
  let stream = readFileSync(saved, 'utf8');
  assertScanStream(stream, 'pre-commit', stagedStream(f));
  assert.match(stream, /^\+staged\n\n\+second line\n\n/m);
  rmSync(saved);
  f.git('commit', '--quiet', '--no-verify', '-m', 'staged');
  const head = f.git('rev-parse', 'HEAD');
  result = f.push([ref(head)], undefined, { GITLEAKS_STDIN: saved });
  assert.equal(result.status, 0, result.stderr);
  stream = readFileSync(saved, 'utf8');
  // The pushed range is all of HEAD's history, including the scripts' continuation lines.
  assertScanStream(stream, 'secret-scan', filteredOutput(f, [...scanLogArgs, 'HEAD', '--']));
  assert.match(stream, new RegExp(`^commit ${head}\n\n`, 'm'));
  assert.match(stream, /^\+staged\n\n\+second line\n\n/m);
});

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

test('a tar signature at byte 257 of a commit message or staged change does not hide a secret (RA)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const secret = new RegExp(token.slice(4));
    const base = f.git('rev-parse', 'HEAD');
    writeFileSync(join(f.repo, 'config.txt'), `aws_access_key_id = ${token}\n`);
    f.git('add', 'config.txt');
    placeAt(257, 'ustar', (pad) => {
      f.git('reset', '--quiet', '--soft', base);
      f.git('commit', '--quiet', '--no-verify', '-m', `${'a'.repeat(pad)}ustar`);
    }, () => headStream(f));
    let result = secretScan(f, 'HEAD', '--not', base);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr + result.stdout, secret);
    f.git('reset', '--quiet', '--hard', base);
    const staged = join(f.repo, 'staged.txt');
    placeAt(257, 'ustar', (pad) => {
      writeFileSync(staged, `${'b'.repeat(pad)}ustar\naws_access_key_id = ${token}\n`);
      f.git('add', 'staged.txt');
    }, () => stagedStream(f));
    for (const options of [{}, { commit: true }]) {
      result = f.commitHook(options);
      assert.equal(result.status, 1, `${JSON.stringify(options)}: ${result.stderr}`);
      assert.match(result.stderr, /pre-commit: BLOCKED — the secret scan failed or found a secret/);
      assert.doesNotMatch(result.stderr + result.stdout, secret);
    }
    assert.equal(f.git('rev-parse', 'HEAD'), base, 'no commit was made');
  });

test('a secret line across a Gitleaks chunk boundary is still found (RA)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const base = f.git('rev-parse', 'HEAD');
    const filler = Array.from({ length: 27000 }, (_, index) => `x${index}`);
    // The 20-byte key starts at each offset of the stream before the preamble.
    // 124 990 straddles 125 000, a 100 KB read plus the 25 KB look-ahead. When
    // the first read takes a full 64 KiB pipe buffer, chunks end near 90 536
    // and every 28 672 bytes after it (4 KiB buffered reads past the
    // look-ahead); the other offsets straddle those ends, where a stream
    // without blank lines was cut.
    for (const offset of [124990, 90526, 119198, 147870, 176542]) {
      // A line well before the offset carries the pad; the key's line keeps the line count.
      let index = 0;
      for (let sum = 400; sum < offset - 200; sum += filler[index].length + 2) index++;
      placeAt(offset, token, (pad) => {
        const lines = filler.with(index, `${filler[index]}${'p'.repeat(pad)}`).with(index + 2, `aws_access_key_id = ${token}`);
        writeFileSync(join(f.repo, 'filler.txt'), `${lines.join('\n')}\n`);
        f.git('add', 'filler.txt');
        f.git('reset', '--quiet', '--soft', base);
        f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic filler');
      }, () => headStream(f));
      const result = secretScan(f, 'HEAD', '--not', base);
      assert.equal(result.status, 1, `${offset}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, new RegExp(token.slice(4)), String(offset));
      f.git('reset', '--quiet', '--hard', base);
    }
  });

test('a private key block is flagged as one run without blank lines between its lines (RA, NX3-S1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // Random synthetic key material, assembled at runtime.
    const kind = ['RSA', 'PRIVATE', 'KEY'].join(' ');
    const body = randomBytes(1190).toString('base64').match(/.{1,64}/g).join('\n');
    const { hook, scan } = scanAssignment(f, `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----\n`);
    for (const result of [...hook, scan]) {
      assert.equal(result.status, 1, result.stderr);
      assert.ok(!(result.stderr + result.stdout).includes(body.slice(0, 64)));
    }
  });

test('the repository Gitleaks rules flag values after blanks inside the quotes (RA)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const vid = ['73', '4125'].join('');
    const value = 'ab'.repeat(10);
    for (const [line, label] of [
      [assignment('POLL_SECRET', ` ${value}`), 'secret'],
      [`${jsonName('POLL', 'SECRET')}=' \t${value}'\n`, 'secret after a tab'],
      [assignment('GCA_MEMBER_ROLE_ID', ` ${realShaped}`), 'Discord ID'],
      [`${jsonName('GCA', 'REGIONS')}=' {"${vid}":"AC"}'\n`, 'JSON literal'],
      [`${jsonName('FIR', 'LABELS')}=" [\n  "JD"\n]"\n`, 'multi-line JSON literal'],
      [`${jsonName('GCA', 'APPROVALS')}=' {"JDDD": [\n  "1"\n]}'\n`, 'pretty-printed JSON literal'],
    ]) {
      const { hook, scan } = scanAssignment(f, `# synthetic settings\n${line}# end\n`);
      for (const result of [...hook, scan]) assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    }
  });

test('the deployment rules allow Q and X prefixes only for FIR prefixes (RA)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const line of [`${coordinatorName}=QXA\n`, `export ${coordinatorName}="QX, XD"\n`, `${firPrefixes}=synthetic-prefixes\n`]) {
      const { hook, scan } = scanAssignment(f, `# synthetic settings\n${line}# end\n`);
      for (const result of [...hook, scan]) assert.equal(result.status, 1, `${line}: ${result.stderr}`);
    }
    const { hook, scan } = scanAssignment(f, `${firPrefixes}="QX, XD"\n${firPrefixes}=xd\n${coordinatorName}=synthetic-state\n`);
    for (const result of [...hook, scan]) assert.equal(result.status, 0, result.stderr);
  });

test('privacy checks fail closed without echoing Git output when the history cannot be read (RA)', (t) => {
  const f = fixture(t, { realRange: true });
  // The first commit is missing, so `git log` fails after HEAD.
  f.git('commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'synthetic', '--author', `Person <${['person', 'example.invalid'].join('@')}>`);
  rmSync(join(f.repo, '.git', 'objects', f.first.slice(0, 2), f.first.slice(2)));
  const result = spawnSync(process.execPath, ['scripts/check-privacy.mjs'], { cwd: f.repo, env: gitEnv(), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'Privacy checks: FAILED (indexed files and HEAD history)\n');
  assert.equal(result.stderr, 'commit log could not be parsed\n');
});

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

test('a 4096-bit private key after filler is flagged at every offset, as CI and pre-push scan it (NX3-S1 F1)',
  { skip: gitleaksSkip }, (t) => {
    const key = privateKeyPem();
    const body = key.split('\n')[1];
    const missed = [];
    for (const offset of keyOffsets) {
      const f = fixture(t, { gitleaks: 'real' });
      commitRules(f, repoRules());
      writeFileSync(join(f.repo, 'filler.txt'), fillerLines(offset) + key);
      f.git('add', 'filler.txt');
      f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic filler');
      const result = secretScan(f, 'HEAD');
      if (result.status !== 1) missed.push(`${offset} (status ${result.status})`);
      assert.ok(!(result.stderr + result.stdout).includes(body), `${offset}: redacted`);
    }
    assert.deepEqual(missed, [], `missed at ${missed.join(', ')}`);
  });

test('a staged 4096-bit private key after filler blocks the commit at several offsets (NX3-S1 F1)',
  { skip: gitleaksSkip }, (t) => {
    const key = privateKeyPem();
    const missed = [];
    for (const offset of [18838, 121785, 185137, 296003]) {
      const f = fixture(t, { gitleaks: 'real' });
      commitRules(f, repoRules());
      writeFileSync(join(f.repo, 'filler.txt'), fillerLines(offset) + key);
      f.git('add', 'filler.txt');
      const result = f.commitHook();
      if (result.status !== 1) missed.push(`${offset} (status ${result.status})`);
      assert.ok(!(result.stderr + result.stdout).includes(key.split('\n')[1]), `${offset}: redacted`);
    }
    assert.deepEqual(missed, [], `missed at ${missed.join(', ')}`);
  });

// Synthetic key material for the stream-shape checks, assembled at runtime.
const keyKind = ['RSA', 'PRIVATE', 'KEY'].join(' ');
const syntheticKeyLines = (count) => Array.from({ length: count }, () => randomBytes(48).toString('base64'));

test('both scans keep a private key block together and add blank lines everywhere else (NX3-S1 F1)', (t) => {
  const f = fixture(t);
  const saved = join(f.repo, '..', 'stream.txt');
  const body = syntheticKeyLines(20);
  const block = [`-----BEGIN ${keyKind}-----`, ...body, `-----END ${keyKind}-----`];
  const unterminated = [`-----BEGIN ${keyKind}-----`, ...Array.from({ length: 300 }, (_, index) => `u${index}`.padEnd(100, 'u'))];
  writeFileSync(join(f.repo, 'shape.txt'), [
    'before', ...block, 'between',
    `-----BEGIN ${keyKind}-----${body[0]}-----END ${keyKind}-----`,
    'after one-line key', ...unterminated, 'last',
  ].join('\n') + '\n');
  writeFileSync(join(f.repo, 'crlf.txt'), `${block.join('\r\n')}\r\nafter\r\n`);
  f.git('add', 'shape.txt', 'crlf.txt');
  const plus = (lines, eol = '\n') => lines.map((line) => `+${line}${eol}`).join('');
  const check = (stream, label) => {
    // No blank line inside the key; one after its END line.
    assert.ok(stream.includes(`+before\n\n${plus(block)}\n+between\n\n`), `${label}: LF key run`);
    assert.ok(stream.includes(`${plus(block, '\r\n')}\n+after\r\n\n`), `${label}: CRLF key run`);
    // BEGIN and END on one line start no run.
    assert.ok(/-----\n\n\+after one-line key\n\n/.test(stream), `${label}: one-line key`);
    // A BEGIN without END regains blank lines once its run holds 16 384 bytes.
    const start = stream.indexOf(`+${unterminated[0]}\n+${unterminated[1]}\n`);
    const end = stream.indexOf('\n\n', start) + 1;
    assert.ok(end - start >= 16384 && end - start < 17500, `${label}: unterminated run of ${end - start} bytes`);
    assert.ok(/^(?:\+u\d+u+\n\n)+\+last\n\n/.test(stream.slice(end + 1)), `${label}: blank lines after the run`);
  };
  let result = f.commitHook({ extraEnv: { GITLEAKS_STDIN: saved } });
  assert.equal(result.status, 0, result.stderr);
  let stream = readFileSync(saved, 'utf8');
  assertScanStream(stream, 'pre-commit', stagedStream(f));
  check(stream, 'pre-commit');
  f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic shapes');
  result = f.scan(['-1', 'HEAD'], { GITLEAKS_STDIN: saved });
  assert.equal(result.status, 0, result.stderr);
  stream = readFileSync(saved, 'utf8');
  assertScanStream(stream, 'secret-scan', headStream(f));
  check(stream, 'secret-scan');
});

test('runs end before a long line, a diff or commit line, and a new key, and stay below 17 500 bytes (NX3-S1 c3)', (t) => {
  const f = fixture(t);
  const saved = join(f.repo, '..', 'stream.txt');
  // Over the 1 024 bytes that end a run; lines over 20 000 bytes fail the scan (L1).
  const long = (char) => char.repeat(2000);
  // Adversarial input: 2 000-byte lines, keys without END and long continued commands.
  writeFileSync(join(f.repo, 'a.txt'), [
    long('a'), `-----BEGIN ${keyKind}-----`, 'k1', long('b'), 'plain',
    `-----BEGIN ${keyKind}-----`, ...Array.from({ length: 40 }, () => 'm'.repeat(1000)),
    `-----BEGIN ${keyKind}-----`, 'n'.repeat(1000), `-----BEGIN ${keyKind}-----`, 'second key', `-----END ${keyKind}-----`,
    ...Array.from({ length: 100 }, () => `curl ${'c'.repeat(400)} \\`), 'final', long('d'),
    `-----BEGIN ${keyKind}-----`,
  ].join('\n') + '\n');
  writeFileSync(join(f.repo, 'b.txt'), 'next file\n');
  f.git('add', 'a.txt', 'b.txt');
  f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic runs');
  writeFileSync(join(f.repo, 'c.txt'), `next commit\n-----BEGIN ${keyKind}-----\n`);
  f.git('add', 'c.txt');
  f.git('commit', '--quiet', '--no-verify', '-m', 'next');
  const checkStretches = (stream, label) => {
    const content = stream.slice(preambleStream.length);
    let todayMax = 0;
    for (const line of content.split('\n')) todayMax = Math.max(todayMax, line.length + 1);
    let multiMax = 0, singleMax = 0;
    for (const stretch of content.split('\n\n')) {
      if (stretch.includes('\n')) multiMax = Math.max(multiMax, stretch.length + 1);
      else singleMax = Math.max(singleMax, stretch.length + 1);
    }
    assert.equal(singleMax, todayMax, `${label}: single lines`);
    assert.ok(multiMax >= 16384 && multiMax <= 17500, `${label}: runs reach ${multiMax} bytes`);
    // A run ends before a long line, a new key's BEGIN line, a diff line and a commit line.
    assert.ok(content.includes(`+k1\n\n+${long('b')}\n\n`), `${label}: long line`);
    assert.ok(content.includes(`-----\n+${'n'.repeat(1000)}\n\n+-----BEGIN ${keyKind}-----\n+second key\n+-----END ${keyKind}-----\n\n`),
      `${label}: new key`);
    assert.ok(/\n\+-----BEGIN [^\n]*-----\n\ndiff --git a\/b\.txt b\/b\.txt\n\n/.test(content), `${label}: diff line`);
  };
  f.git('reset', '--quiet', '--soft', 'HEAD~2');
  let result = f.commitHook({ extraEnv: { GITLEAKS_STDIN: saved } });
  assert.equal(result.status, 0, result.stderr);
  let stream = readFileSync(saved, 'utf8');
  assertScanStream(stream, 'pre-commit', stagedStream(f));
  checkStretches(stream, 'pre-commit');
  f.git('reset', '--quiet', '--soft', 'ORIG_HEAD');
  result = f.scan(['-2', 'HEAD'], { GITLEAKS_STDIN: saved });
  assert.equal(result.status, 0, result.stderr);
  stream = readFileSync(saved, 'utf8');
  assertScanStream(stream, 'secret-scan', filteredOutput(f, [...scanLogArgs, '-2', 'HEAD', '--']));
  checkStretches(stream, 'secret-scan');
  // Git prints an empty line before the next commit line; the run ends at the commit line.
  assert.ok(/\n\+-----BEGIN [^\n]*-----\n\n\ncommit [0-9a-f]{40}\n\n/.test(stream), 'commit line');
});

test('a curl authorization header after a line continuation and a CRLF private key are flagged (NX3-S1 F2)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const token = randomBytes(16).toString('hex');
    for (const eol of ['\n', '\r\n']) {
      const text = ['# synthetic', 'curl https://api.example.test/v1/items \\', `  --header "Authorization: Bearer ${token}"`, '# end', '']
        .join(eol);
      const { hook, scan } = scanAssignment(f, text);
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${JSON.stringify(eol)}: ${result.stderr}`);
        assert.ok(!(result.stderr + result.stdout).includes(token), JSON.stringify(eol));
      }
    }
    const key = privateKeyPem();
    const { hook, scan } = scanAssignment(f, `${fillerLines(20000)}${key}`.replaceAll('\n', '\r\n'));
    for (const result of [...hook, scan]) {
      assert.equal(result.status, 1, `CRLF key: ${result.stderr}`);
      assert.ok(!(result.stderr + result.stdout).includes(key.split('\n')[1]), 'CRLF key');
    }
  });

// F2: a curl command continued over several KB was split between chunks like
// a key, in LF and CRLF files; v2.2.5 missed it at most of these offsets. (Go's
// `.` matches CR, so a short CRLF continuation in one chunk already matched.)
test('a curl command continued over long lines is flagged at every offset, in LF and CRLF files (NX3-S1 F2)',
  { skip: gitleaksSkip }, (t) => {
    const token = randomBytes(16).toString('hex');
    const missed = [];
    for (const eol of ['\n', '\r\n']) {
      const command = ['curl https://api.example.test/v1/items \\',
        ...Array.from({ length: 4 }, (_, index) => `  --data-urlencode "q${index}=${'v'.repeat(900)}" \\`),
        `  --header "Authorization: Bearer ${token}"`, ''].join('\n');
      for (const offset of keyOffsets.slice(0, 9)) {
        const f = fixture(t, { gitleaks: 'real' });
        writeFileSync(join(f.repo, 'filler.txt'), (fillerLines(offset) + command).replaceAll('\n', eol));
        f.git('add', 'filler.txt');
        f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic filler');
        const result = secretScan(f, 'HEAD');
        if (result.status !== 1) missed.push(`${JSON.stringify(eol)} ${offset} (status ${result.status})`);
        assert.ok(!(result.stderr + result.stdout).includes(token), `${offset}: redacted`);
      }
    }
    assert.deepEqual(missed, [], `missed at ${missed.join(', ')}`);
  });

test('a secret after a NUL byte, on its line or the next, is flagged through both scans (NX3-S1 F4)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    for (const text of [`binary\0 aws_access_key_id = ${token}\n`, `binary\0data\naws_access_key_id = ${token}\n`]) {
      const { hook, scan } = scanAssignment(f, text);
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${JSON.stringify(text)}: ${result.stderr}`);
        assert.doesNotMatch(result.stderr + result.stdout, new RegExp(token.slice(4)));
      }
    }
  });

// A DISCORD_CHANNEL_IDS line of `count` synthetic IDs with a real-shaped one third from the end.
function idListLine(count) {
  const ids = Array.from({ length: count }, (_, index) => String(900000000000000001n + BigInt(index)));
  ids.splice(-3, 0, realShaped);
  return assignment('DISCORD_CHANNEL_IDS', ids.join(','));
}

test('a real-shaped Discord ID near the end of a 19 000-byte ID list is flagged, as before (NX3-S1 c2)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const line = idListLine(1020);
    // Under the 20 000-byte long-line limit, with the diff's +.
    assert.ok(line.length > 19000 && line.length < 19900, String(line.length));
    const { hook, scan } = scanAssignment(f, `# synthetic\n${line}# end\n`);
    for (const result of [...hook, scan]) {
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stderr + result.stdout, /over 20 000 bytes/);
      assert.doesNotMatch(result.stderr + result.stdout, new RegExp(realShaped));
    }
  });

test('a 22 000-byte ID list line holding a real-shaped Discord ID fails as a long line, redacted (NX3-S1 c2, NX5-L1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const line = idListLine(1160);
    assert.ok(line.length > 22000 && line.length < 22100, String(line.length));
    const { hook, scan } = scanAssignment(f, `# synthetic\n${line}# end\n`);
    for (const result of hook) {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /pre-commit: BLOCKED — the secret scan cannot read lines over 20 000 bytes whole/);
      assert.doesNotMatch(result.stderr + result.stdout, new RegExp(realShaped));
    }
    assert.equal(scan.status, 2, scan.stderr);
    assert.match(scan.stderr, /secret-scan: the secret scan cannot read lines over 20 000 bytes whole/);
    assert.doesNotMatch(scan.stderr + scan.stdout, new RegExp(realShaped));
  });

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

test('a line over 20 000 bytes blocks the commit and fails the history scan without showing it (NX5-L1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // A random AWS-shaped key, built at runtime.
    const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const key = ['AKIA', Array.from(randomBytes(16), (byte) => base32[byte % 32]).join('')].join('');
    // Classic Mac line ends: short lines separated by CR only, one 30 000-byte Git line.
    const crOnly = (m) => {
      let text = `${m}\r`;
      for (let index = 0; text.length < 30000; index++) text += `x${index}\r`;
      return text.slice(0, 30000);
    };
    // [label, file content, the long line's bytes as Git prints it]
    const cases = [
      ['20 000 characters', (m) => `${m}${'a'.repeat(20000 - m.length)}`],
      ['30 000 bytes with CR line ends only', crOnly, true],
      ['5 001 four-byte characters', (m) => `${m}${'\u{1F600}'.repeat(5001)}`],
      ['15 000 x "a "', (m) => `${m} ${'a '.repeat(15000)}`],
      ['30 000 bytes ending in a real-shaped key', (m) => `${m}${'k'.repeat(30000 - m.length - key.length - 24)} aws_access_key_id = ${key}`],
    ].map(([label, build, whole]) => {
      const m = lineMarker();
      const line = build(m);
      return [label, m, whole ? line : `# synthetic\n${line}\n# end\n`, Buffer.byteLength(line) + 1];
    });
    for (const [label, m, text, bytes] of cases) {
      const { hook, scan } = scanAssignment(f, text);
      for (const result of hook) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        assert.match(result.stderr, longLine.hook, label);
        assert.match(result.stderr, longFilter(bytes, 'file settings\\.env'), label);
        assert.ok(!(result.stderr + result.stdout).includes(m), `${label}: marker shown`);
        assert.ok(!(result.stderr + result.stdout).includes(key.slice(4)), `${label}: key shown`);
      }
      assert.equal(scan.status, 2, `${label}: ${scan.stderr}`);
      assert.match(scan.stderr, longLine.scan, label);
      assert.match(scan.stderr, longFilter(bytes, 'file settings\\.env of commit [0-9a-f]{40}'), label);
      assert.ok(!(scan.stderr + scan.stdout).includes(m), `${label}: marker shown`);
      assert.ok(!(scan.stderr + scan.stdout).includes(key.slice(4)), `${label}: key shown`);
    }
    // 19 999 characters are 20 000 bytes with the +: scanned as before.
    const { hook, scan } = scanAssignment(f, `# synthetic\n${'a'.repeat(19999)}\n# end\n`);
    for (const result of [...hook, scan]) {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /over 20 000 bytes/);
    }
  });

test('a commit message line over 20 000 bytes fails the history scan without showing it (NX5-L1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const m = lineMarker();
    // Git indents each message line by four spaces: 20 001 bytes become 20 005.
    f.git('commit', '--quiet', '--no-verify', '--allow-empty', '-m', `${m}${'b'.repeat(20001 - m.length)}`);
    const head = f.git('rev-parse', 'HEAD');
    let result = secretScan(f, 'HEAD^!');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, longLine.scan);
    assert.match(result.stderr, longFilter(20005, `the commit message of commit ${head}`));
    assert.ok(!(result.stderr + result.stdout).includes(m), 'marker shown');
    // 19 996 bytes are 20 000 with the indent.
    f.git('commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'b'.repeat(19996));
    result = secretScan(f, 'HEAD^!');
    assert.equal(result.status, 0, result.stderr);
  });

test('a long line and a failing Gitleaks are both named; the filter still passes every line on (NX5-L1)', (t) => {
  const f = fixture(t, { gitleaksExit: 1 });
  const saved = join(f.repo, '..', 'stream.txt');
  const m = lineMarker();
  writeFileSync(join(f.repo, 'long.txt'), `${m}${'c'.repeat(25000)}\nshort\n${'d'.repeat(20001)}\n`);
  f.git('add', 'long.txt');
  const both = (result, label, prefix) => {
    assert.match(result.stderr, new RegExp(`^${prefix}: the secret scan also failed or found a secret; see the output above\\.$`, 'm'), label);
    assert.match(result.stderr, /^scan-stream: lines over 20 000 bytes in all: 2\.$/m, label);
    assert.ok(!(result.stderr + result.stdout).includes(m), `${label}: marker shown`);
  };
  for (const options of [{ extraEnv: { GITLEAKS_STDIN: saved } }, { commit: true }]) {
    const result = f.commitHook(options);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, longLine.hook);
    both(result, JSON.stringify(options), 'pre-commit');
  }
  assertScanStream(readFileSync(saved, 'utf8'), 'pre-commit', stagedStream(f));
  f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic long lines');
  const result = f.scan(['-1', 'HEAD'], { GITLEAKS_STDIN: saved });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, longLine.scan);
  both(result, 'secret-scan', 'secret-scan');
  assertScanStream(readFileSync(saved, 'utf8'), 'secret-scan', headStream(f));
});

test('both scans run the shared stream filter after NUL replacement, each stage with a failure marker (NX3-S1)', (t) => {
  for (const file of ['./secret-scan.sh', './hooks/pre-commit']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /^filter=(?:\$\(dirname -- "\$0"\)\/|scripts\/)hooks\/lib\/scan-stream\.awk$/m, file);
    // The filter's exit 3, a line over 20 000 bytes, leaves its own marker; any other failure the shared one.
    assert.match(source, /^ +\{ LC_ALL=C sed -e '\/\^-\/d' -e '[^']*' \|\| : >"\$tmp\/failed"; \} \|\n +\{ LC_ALL=C tr '\\000' ' ' \|\| : >"\$tmp\/failed"; \} \|\n +\{ LC_ALL=C awk -f "\$filter" \|\| case \$\? in \(3\) : >"\$tmp\/long" ;; \(\*\) : >"\$tmp\/failed" ;; esac; \} \|\n +gitleaks stdin /m, file);
    assert.doesNotMatch(source, / -e G\b/, file);
  }
  const f = fixture(t);
  writeFileSync(join(f.repo, 'public.txt'), 'staged\n');
  f.git('add', 'public.txt');
  const bin = join(f.repo, '..', 'bin');
  const realAwk = spawnSync('/bin/sh', ['-c', 'command -v awk'], { encoding: 'utf8' }).stdout.trim();
  // A filter that exits 3 reports a long line, not a read failure.
  writeFileSync(join(bin, 'awk'), `#!/bin/sh\nif [ "$1" = -f ]; then cat >/dev/null; exit 3; fi\nexec "${realAwk}" "$@"\n`, { mode: 0o700 });
  let long = f.scan(['HEAD']);
  assert.equal(long.status, 2, long.stderr);
  assert.match(long.stderr, /^secret-scan: the secret scan cannot read lines over 20 000 bytes whole/m);
  assert.doesNotMatch(long.stderr, /could not read the commits/);
  long = f.commitHook();
  assert.equal(long.status, 1, long.stderr);
  assert.match(long.stderr, /^pre-commit: BLOCKED — the secret scan cannot read lines over 20 000 bytes whole/m);
  assert.doesNotMatch(long.stderr, /could not be read|could not read/);
  rmSync(join(bin, 'awk'));
  for (const [name, wrapper] of [
    ['awk', `#!/bin/sh\nif [ "$1" = -f ]; then cat >/dev/null; exit 2; fi\nexec "${realAwk}" "$@"\n`],
    ['tr', '#!/bin/sh\ncat >/dev/null\nexit 1\n'],
  ]) {
    writeFileSync(join(bin, name), wrapper, { mode: 0o700 });
    let result = f.scan(['HEAD']);
    assert.equal(result.status, 2, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /secret-scan: could not read the commits to scan/, name);
    result = f.commitHook();
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /pre-commit: BLOCKED — could not read the staged changes for the secret scan\./, name);
    rmSync(join(bin, name));
  }
  rmSync(join(f.repo, 'scripts', 'hooks', 'lib', 'scan-stream.awk'));
  let result = f.scan(['HEAD']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^secret-scan: missing the stream filter scripts\/hooks\/lib\/scan-stream\.awk\.$/m);
  result = f.commitHook();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^pre-commit: BLOCKED — missing the stream filter scripts\/hooks\/lib\/scan-stream\.awk\.$/m);
  assert.equal(result.gitleaks, '');
});

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

test('the repository Gitleaks rules block identifying settings that the default rules miss, redacted (NX3-S2 F7-F9)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const cases = identifyingCases();
    // Default rules alone pass every case, so only the repository rules can block them.
    commitRules(f, '[extend]\nuseDefault = true\n');
    let { hook, scan } = scanAssignment(f, cases.map(([line]) => line).join(''));
    for (const result of [...hook, scan]) assert.equal(result.status, 0, result.stderr);
    commitRules(f, repoRules());
    for (const [line, secret, label] of cases) {
      ({ hook, scan } = scanAssignment(f, `# synthetic settings\n${line}# end\n`));
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        if (secret) assert.ok(!(result.stderr + result.stdout).includes(secret), label);
      }
    }
  });

test('the repository Gitleaks rules pass identifying-setting fixtures, empty values, code and reserved hosts (NX3-S2 F7-F9)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // The tracked fixtures and references, as written in src/, test/, config/ and vitest.config.ts.
    const text = "    ...env, IVAO_CLIENT_ID: 'test-client', IVAO_CLIENT_SECRET: 'test-secret',\n"
      + "    expect(ivaoAuthFromEnv({ IVAO_CLIENT_ID: 'a' } as unknown as Env)).toBeUndefined();\n"
      + "      ivaoAuthFromEnv({ IVAO_CLIENT_ID: ' ', IVAO_CLIENT_SECRET: ' ' } as unknown as Env),\n"
      + '  IVAO_CLIENT_ID?: string;\n  const clientId = env.IVAO_CLIENT_ID?.trim();\n'
      + "IVAO_CLIENT_ID=\"\"\n        IVAO_CLIENT_ID: '',\nIVAO_CLIENT_ID=synthetic-ivao-client\n"
      + "IVAO_CLIENT_ID='00000000-0000-0000-0000-000000000000'\n  IVAO_CLIENT_ID: clientId,\n"
      + "  IVAO_CLIENT_ID: env.IVAO_CLIENT_ID,\n  IVAO_CLIENT_ID: 'abc1234',\n"
      + "const EXCLUDED = { EXCLUDED_CALLSIGNS: 'QCXX_CTR' };\n"
      + "    ['an excluded callsign', entry('QCTT_GND'), { EXCLUDED_CALLSIGNS: 'QCTT_GND' }],\n"
      + "    ['a listed excluded callsign', {}, { EXCLUDED_CALLSIGNS: 'QC_OTHER, xa_syn_ctr' }],\n"
      + "    await expect(configuredPoll({ EXCLUDED_CALLSIGNS: a, DISCORD_CHANNEL_IDS: '900000000000000001' }))\n"
      + '        ...env, EXCLUDED_CALLSIGNS: b,\n  const excluded = parseExcludedCallsigns(env.EXCLUDED_CALLSIGNS);\n'
      + 'EXCLUDED_CALLSIGNS=""\nEXCLUDED_CALLSIGNS=QCXX_CTR,\n'
      + "    const parsed = parseGcaPolicy({ ...settings(), GCA_POLICY_URL: 'https://example.test/gca' })!;\n"
      + "    await gcaConfig({ GCA_DM_ENABLED: 'true', GCA_POLICY_URL: 'http://example.test/gca' });\n"
      + "      expect(parseGcaPolicy({ ...settings(), GCA_POLICY_URL: String(url) })?.policyUrl).toBeUndefined();\n"
      + "    await check([atc({ sessionId: 2 })], { ...settings(), GCA_POLICY_URL: ' ' });\n"
      + 'GCA_POLICY_URL=""\nGCA_POLICY_URL=https://policy.example/gca?ref=1#top\nGCA_POLICY_URL="HTTPS://X.INVALID"\n'
      + "GCA_POLICY_URL='https://example.test/gca?ref=xxxx'\n";
    const { hook, scan } = scanAssignment(f, text);
    for (const result of [...hook, scan]) assert.equal(result.status, 0, result.stderr);
  });

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
// are restored with); nx7Texts pins the 2.2.10 texts.
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
const callsignAllow = (quote) => String.raw`regexes = ['''(?i)^[QX]${callsignItem}(?:${blankClass}*,${blankClass}*(?:${quote}[QX]${callsignItem})?)*${blankClass}*$''']`;
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
    ['regex', callsignRegexNx7,
      String.raw`${callsignHead}[ \t\p{Zs}\x{FEFF}]*([A-Za-z0-9]+_${itemClass}(?:[ \t]*,[ \t]*${itemClass})*)'''`],
    ['regexes', callsignAllow(String.raw`["'${tick}]?`),
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
  return lines.filter((line) => line !== null).join('\n');
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

test('each NX5-L2 rule and change is needed: its cases pass without the rule or flip with its earlier text (NX5-L2)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    for (const [id, { block, pass }] of Object.entries(l2Cases())) {
      commitRules(f, withoutRule(repoRules(), id));
      let scan = scanCommit(f, block.map(([line]) => settingsText(line)).join(''));
      assert.equal(scan.status, 0, `${id} removed: ${scan.stderr}`);
      if (!l2Texts[id]) continue;
      commitRules(f, beforeL2(repoRules(), id));
      const needed = block.filter((item) => item[3]);
      if (needed.length) {
        scan = scanCommit(f, needed.map(([line]) => settingsText(line)).join(''));
        assert.equal(scan.status, 0, `${id} before NX5-L2: ${scan.stderr}`);
      }
      for (const [line, label] of pass.filter((item) => item[2])) {
        scan = scanCommit(f, settingsText(line));
        assert.equal(scan.status, 1, `${id} before NX5-L2 blocks ${label}: ${scan.stderr}`);
      }
    }
  });

test('the repository Gitleaks rules block NX5-L2 callsign, policy link, FIR prefix and coordinator forms, redacted (NX5-L2)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const { block } of Object.values(l2Cases())) {
      for (const [line, secret, label] of block) {
        const { hook, scan } = scanAssignment(f, settingsText(line));
        for (const result of [...hook, scan]) {
          assert.equal(result.status, 1, `${label}: ${result.stderr}`);
          for (const text of [secret].flat()) {
            if (text) assert.ok(!(result.stderr + result.stdout).includes(text), `${label}: ${text.length} characters shown`);
          }
        }
      }
    }
  });

test('the NX-6 blanks around commas in the FIR prefix NAME:list branch are needed: their cases pass with ASCII blanks (NX-6)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const id = 'onfreq-fir-prefixes-property';
    const needed = l2Cases()[id].block.filter((item) => item[4]);
    assert.ok(needed.length > 0);
    commitRules(f, editRule(repoRules(), id, [['regex', firNx7, firColonBeforeNx6]]));
    const scan = scanCommit(f, needed.map(([line]) => settingsText(line)).join(''));
    assert.equal(scan.status, 0, `${id} before NX-6: ${scan.stderr}`);
  });

test('the repository Gitleaks rules pass NX5-L2 synthetic, reference and shell-separated forms (NX5-L2)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const { pass } of Object.values(l2Cases())) {
      for (const [line, label] of pass) {
        const { hook, scan } = scanAssignment(f, settingsText(line));
        for (const result of [...hook, scan]) assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      }
    }
  });

// The configuration without one rule and its allowlist.
function withoutRule(rules, id) {
  const text = rules.toString();
  const start = text.indexOf(`[[rules]]\nid = "${id}"\n`);
  assert.ok(start >= 0, id);
  const next = text.indexOf('\n[[rules]]\n', start);
  return text.slice(0, start) + (next < 0 ? '' : text.slice(next + 1));
}
// The configuration with the callsign rule's regex as before NX4-G1: ASCII
// blanks before the list and around commas, and items of letters, digits and
// underscores. Its allowlist is the current one (NX-7), which every NX4-G1
// case's previous match passes.
function previousCallsignRule(rules) {
  return editRule(rules, 'onfreq-excluded-callsigns-assignment', [['regex', callsignRegexNx7,
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

test('each NX4-G1 rule is needed: its cases pass without it (NX4-G1)', { skip: gitleaksSkip }, (t) => {
  const f = fixture(t, { gitleaks: 'real' });
  for (const [id, cases] of Object.entries(g1Cases())) {
    const rules = id === 'onfreq-excluded-callsigns-assignment' ? previousCallsignRule(repoRules()) : withoutRule(repoRules(), id);
    commitRules(f, rules);
    const scan = scanCommit(f, cases.map(([line]) => `# synthetic settings\n${line}`).join(''));
    assert.equal(scan.status, 0, `${id}: ${scan.stderr}`);
  }
});

test('the repository Gitleaks rules block quoted userinfo, widened callsign items and FIR prefix properties, redacted (NX4-G1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const cases of Object.values(g1Cases())) {
      for (const [index, [line, secret, label]] of cases.entries()) {
        const text = `# synthetic settings\n${line}# end\n`;
        // The first case of each rule also goes through pre-commit, directly and as git commit.
        let results = [scanCommit(f, text)];
        if (index === 0) {
          const { hook, scan } = scanAssignment(f, text);
          results = [...hook, scan];
        }
        for (const result of results) {
          assert.equal(result.status, 1, `${label}: ${result.stderr}`);
          if (secret) assert.ok(!(result.stderr + result.stdout).includes(secret), label);
        }
      }
    }
  });

test('the repository Gitleaks rules pass every tracked line naming these settings, and synthetic forms (NX4-G1)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    // The rules file itself, as committed.
    assert.equal(secretScan(f, 'HEAD^!').status, 0);
    const root = fileURLToPath(new URL('..', import.meta.url));
    const grep = spawnSync('git', ['grep', '-h', '-I', '-i', '-E', 'GCA_POLICY_URL|EXCLUDED_CALLSIGNS|FIR_PREFIXES|COORDINATOR_NAME'],
      { cwd: root, env: gitEnv(), encoding: 'utf8' });
    assert.equal(grep.status, 0, grep.stderr);
    const tracked = grep.stdout;
    for (const name of [firPrefixes, callsignsName, policyUrlName, coordinatorName]) assert.ok(tracked.includes(`${name}: '`), name);
    const address = ['owner', 'example.test'].join('@');
    const jd = jPrefix('D');
    const text = tracked
      // Q and X prefixes are synthetic, and a quoted list whose first item is one passes.
      + `  ${firPrefixes}: 'XD',\n"${firPrefixes}": "QC, QE"\n$env:${firPrefixes} = "XA"\n      - ${firPrefixes}=QC\n`
      + `env ${firPrefixes}=QC,XA npm test\nA=1 ${firPrefixes}=xd\n  ${firPrefixes}: QC, XA # note\n`
      + `  ${firPrefixes}: 'XD, ${jd}',\n`
      // Code and lowercase dotenv names.
      + `  ${firPrefixes}: prefixes,\n  ${firPrefixes}: JSON.parse(raw),\n  ${firPrefixes}: env.${firPrefixes},\n`
      + `${firPrefixes.toLowerCase()}=${jd}\n`
      // Synthetic callsigns after Unicode spaces.
      + `${callsignsName}='\u00a0QCXX_CTR'\n${callsignsName}=\ufeffQCXX_CTR,QCXX_APP\n`
      // A reserved policy link followed by a quote, then a field or comment holding an address.
      + `{"${policyUrlName}": "https://example.test/gca", "contact": "${address}"}\n`
      + `{"${policyUrlName}":"https://example.test","contact":"${address}"}\n`
      + `${policyUrlName}=https://example.test/gca # owner ${address}\n`
      + `${policyUrlName}="https://example.test" # ${address}\n`;
    const { hook, scan } = scanAssignment(f, text);
    for (const result of [...hook, scan]) assert.equal(result.status, 0, result.stderr);
  });

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
    ['regex', callsignRegexNx7, callsign2210],
    ['regexes', callsignAllow(String.raw`["'${tick}]?`), callsignAllow('')],
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

test('the repository Gitleaks rules block NX-7 callsign, coordinator name and FIR prefix forms, redacted (NX-7)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const [line, secret, label] of nx7Cases().block) {
      const { hook, scan } = scanAssignment(f, settingsText(line));
      for (const result of [...hook, scan]) {
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        for (const text of [secret].flat()) {
          if (text) assert.ok(!(result.stderr + result.stdout).includes(text), `${label}: ${text.length} characters shown`);
        }
      }
    }
  });

test('the repository Gitleaks rules pass NX-7 synthetic, quoted, code and Markdown forms (NX-7)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    for (const [line, label] of nx7Cases().pass) {
      const { hook, scan } = scanAssignment(f, settingsText(line));
      for (const result of [...hook, scan]) assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    }
  });

test('each NX-7 rule change is needed: its cases pass with the 2.2.10 rule texts (NX-7)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const { block } = nx7Cases();
    for (const id of Object.keys(nx7Texts)) {
      const needed = block.filter(([, , , ids]) => ids.length === 1 && ids[0] === id);
      assert.ok(needed.length > 0, id);
      commitRules(f, as2210([id]));
      const scan = scanCommit(f, needed.map(([line]) => settingsText(line)).join(''));
      assert.equal(scan.status, 0, `${id} as in 2.2.10: ${scan.stderr}`);
    }
    // A case that several rules flag passes only with all of them as in 2.2.10.
    for (const [line, , label, ids] of block.filter((item) => item[3].length > 1)) {
      commitRules(f, as2210(ids));
      assert.equal(scanCommit(f, settingsText(line)).status, 0, `${label}: all as in 2.2.10`);
      for (const id of ids) {
        commitRules(f, as2210(ids.filter((other) => other !== id)));
        assert.equal(scanCommit(f, settingsText(line)).status, 1, `${label}: only ${id} current`);
      }
    }
    // Cases Gitleaks already flagged stay flagged with every rule as in 2.2.10.
    commitRules(f, as2210(Object.keys(nx7Texts)));
    for (const [line, , label] of block.filter((item) => !item[3].length)) {
      assert.equal(scanCommit(f, settingsText(line)).status, 1, label);
    }
  });

// NX-7 #10: the commit email check reads `git log` placeholders, which Git
// converts from the commit's encoding header, and splits rows on \x1e and
// trailers on \x1f. Flagged addresses are assembled at runtime on reserved hosts.
test('privacy checks block underscore-wrapped addresses, split trailers and non-UTF-8 encoding headers (NX-7 #10)', (t) => {
  const f = fixture(t, { realRange: true });
  const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const check = (...args) => spawnSync(process.execPath, ['scripts/check-privacy.mjs', ...args], { cwd: f.repo, env, encoding: 'utf8' });
  const at = (local, domain) => [local, domain].join('@');
  const leaked = /person|private\.test|localhost|Hb\.Ec|ISO-2022|UTF-7/;
  let base = f.head;
  const commit = (message, config = []) => {
    f.git(...config, 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', message);
    return f.git('rev-parse', 'HEAD');
  };
  const expect = (oid, status, error, label) => {
    for (const result of [check('--range', oid, base), f.push([ref(oid, 'refs/heads/main', base)])]) {
      assert.equal(result.status, status, `${label}: ${result.stderr}`);
      if (error) assert.match(result.stderr, error, label);
      assert.doesNotMatch(result.stderr + result.stdout, leaked, label);
    }
    if (!status) base = oid;
    else f.git('reset', '--quiet', '--hard', base);
  };
  const messageError = /^[0-9a-f]{12}: commit message email must use a noreply address$/m;
  const parseError = /^commit log could not be parsed$/m;
  const encodingError = /^[0-9a-f]{12}: commit encoding must be UTF-8$/m;
  // Passes: versions and noreply identities before an underscore, an ordinary
  // message, and a stored UTF-8 encoding header (Git writes none for UTF-8, so
  // that commit object is written directly).
  expect(commit(`synthetic\n\nBump pkg@1.2.3_ and ${at('noreply', 'github.com')}_ please`), 0, null, 'versions');
  expect(commit('synthetic\n\nAn ordinary message.'), 0, null, 'ordinary');
  const tree = f.git('rev-parse', 'HEAD^{tree}');
  const ident = `Synthetic <synthetic@users.noreply.github.com> 1700000000 +0000`;
  const raw = `tree ${tree}\nparent ${base}\nauthor ${ident}\ncommitter ${ident}\nencoding UTF-8\n\nsynthetic utf-8 header\n`;
  const written = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: f.repo, env, input: raw, encoding: 'utf8' });
  assert.equal(written.status, 0, written.stderr);
  const utf8 = written.stdout.trim();
  f.git('reset', '--quiet', '--hard', utf8);
  assert.match(f.git('log', '-1', '--format=%e', utf8), /^UTF-8$/);
  expect(utf8, 0, null, 'UTF-8 header');
  // 10a: an address followed by an underscore was not matched at all.
  expect(commit(`synthetic\n\nContact _${at('person', 'private.test')}_ please`), 1, messageError, 'underscore');
  // 10b: a \x1e in a trailer moved the dotless address after it out of the
  // trailer check; a \x1f split the trailer token before its @.
  expect(commit(`synthetic\n\nSigned-off-by: x\x1e${at('person', 'localhost')}`), 1, parseError, 'record separator');
  expect(commit(`synthetic\n\nCo-authored-by: person\x1f${at('', 'localhost')}`), 1, parseError, 'unit separator');
  // 10c: ISO-2022-JP shift sequences turn the ASCII address bytes into other
  // characters in the converted message, so the address was not seen.
  const hidden = `synthetic\n\nContact \x1b$B${at('Ka', 'Hb.Ec')}\x1b(B now`;
  const iso = commit(hidden, ['-c', 'i18n.commitEncoding=ISO-2022-JP']);
  assert.match(f.git('cat-file', 'commit', iso), /^encoding ISO-2022-JP$/m);
  assert.ok(f.git('cat-file', 'commit', iso).includes(at('Ka', 'Hb.Ec')), 'precondition: stored bytes hold the address');
  assert.ok(!f.git('log', '-1', '--format=%B', iso).includes('@'), 'precondition: the converted message hides it');
  expect(iso, 1, encodingError, 'ISO-2022-JP');
  for (const encoding of ['UTF-7', 'UTF-16']) {
    expect(commit(`synthetic\n\nContact +${at('personal', 'private.test')}`, ['-c', `i18n.commitEncoding=${encoding}`]),
      1, encodingError, encoding);
  }
});

// NX-7 #11: Gitleaks skips a finding whose lines hold its allow marker, and a
// finding can start in a commit or diff header line.
test('the stream filter neutralizes the allow marker in commit and diff headers only (NX-7 #11)', (t) => {
  const f = fixture(t);
  const saved = join(f.repo, '..', 'stream.txt');
  const marked = `notes ${allowMarker}.txt`;
  writeFileSync(join(f.repo, marked), `x = 1 # ${allowMarker}\n`);
  f.git('add', marked);
  let result = f.commitHook({ extraEnv: { GITLEAKS_STDIN: saved } });
  assert.equal(result.status, 0, result.stderr);
  let stream = readFileSync(saved, 'utf8');
  assertScanStream(stream, 'pre-commit', stagedStream(f));
  assert.ok(stream.includes('\ndiff --git a/notes gitleaks-allow.txt b/notes gitleaks-allow.txt\n'), 'pre-commit path');
  // Git ends a ---/+++ path holding a space with a tab.
  assert.match(stream, /^\+\+\+ b\/notes gitleaks-allow\.txt\t?$/m, 'pre-commit +++ path');
  assert.ok(stream.includes(`\n+x = 1 # ${allowMarker}\n`), 'pre-commit added line');
  rmSync(saved);
  f.git('-c', `user.name=Synthetic ${allowMarker}`, 'commit', '--quiet', '--no-verify', '-m', `subject ${allowMarker}`);
  const head = f.git('rev-parse', 'HEAD');
  result = f.push([ref(head, 'refs/heads/main', f.head)], undefined, { GITLEAKS_STDIN: saved });
  assert.equal(result.status, 0, result.stderr);
  stream = readFileSync(saved, 'utf8');
  assertScanStream(stream, 'secret-scan', filteredOutput(f, [...scanLogArgs, head, '--not', f.head, '--']));
  assert.ok(stream.includes('\nAuthor: Synthetic gitleaks-allow <'), 'author name');
  assert.ok(stream.includes('\ndiff --git a/notes gitleaks-allow.txt b/notes gitleaks-allow.txt\n'), 'path');
  assert.ok(stream.includes(`\n+x = 1 # ${allowMarker}\n`), 'added line');
  assert.ok(stream.includes(`\n    subject ${allowMarker}\n`), 'message');
});

test('an allow marker in an author name or a path no longer hides a finding from the scans (NX-7 #11)',
  { skip: gitleaksSkip }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    commitRules(f, repoRules());
    const base = f.git('rev-parse', 'HEAD');
    // 1. The author name opens a private key that the message completes; the
    // key is generated now, and its BEGIN line is only in the author name.
    const body = privateKeyPem().split('\n').filter((line) => line && !line.startsWith('-----BEGIN')).join('\n');
    const shown = (result) => (result.stderr + result.stdout).includes(body.split('\n')[3]);
    f.git('-c', `user.name=Synthetic -----BEGIN PRIVATE KEY----- ${allowMarker}`, 'commit', '--quiet', '--no-verify',
      '--allow-empty', '-m', 'synthetic subject', '-m', body);
    const author = f.git('rev-parse', 'HEAD');
    let result = secretScan(f, `${author}^!`);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(!shown(result));
    result = f.push([ref(author, 'refs/heads/main', base)]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /the secret scan failed or found a secret in the pushed commits/);
    assert.ok(!shown(result));
    // 2. A path holding the marker and a secret-named value.
    const value = randomBytes(12).toString('hex');
    const path = `${['POLL', 'SECRET'].join('_')}=${value} ${allowMarker}.txt`;
    writeFileSync(join(f.repo, path), 'x\n');
    f.git('add', '--', path);
    for (const hook of [f.commitHook(), f.commitHook({ commit: true })]) {
      assert.equal(hook.status, 1, hook.stderr);
      assert.doesNotMatch(hook.stderr + hook.stdout, new RegExp(value));
    }
    f.git('commit', '--quiet', '--no-verify', '-m', 'synthetic path');
    const pathCommit = f.git('rev-parse', 'HEAD');
    result = secretScan(f, `${pathCommit}^!`);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr + result.stdout, new RegExp(value));
    // 3. Passes: an added line with a trailing allow comment, and a marker path without a finding.
    writeFileSync(join(f.repo, 'allowed.env'), `${['POLL', 'SECRET'].join('_')}=${randomBytes(12).toString('hex')} # ${allowMarker}\n`);
    writeFileSync(join(f.repo, `notes-${allowMarker}.txt`), 'plain\n');
    f.git('add', 'allowed.env', `notes-${allowMarker}.txt`);
    assert.equal(f.commitHook().status, 0);
    result = f.commitHook({ commit: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(secretScan(f, 'HEAD^!').status, 0);
    // 4. Each block case passes the scan with the header replacement removed from the filter.
    const filter = join(f.repo, 'scripts', 'hooks', 'lib', 'scan-stream.awk');
    const current = readFileSync(filter, 'utf8');
    const without = current.replace('  if (header) gsub(allow_marker, "gitleaks-allow")\n', '');
    assert.notEqual(without, current);
    writeFileSync(filter, without);
    for (const commit of [author, pathCommit]) assert.equal(secretScan(f, `${commit}^!`).status, 0, commit);
  });

test('the secret scan ignores log.showSignature, so signature checks add no header lines (NX-7 #11)',
  { skip: spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error && 'ssh-keygen is not installed' }, (t) => {
    const f = fixture(t);
    const key = join(f.repo, '..', 'signing-key');
    assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'synthetic', '-f', key]).status, 0);
    writeFileSync(join(f.repo, 'public.txt'), 'signed\n');
    f.git('-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'commit', '--quiet', '--no-verify', '-S', '-am', 'signed');
    const head = f.git('rev-parse', 'HEAD');
    f.git('config', 'log.showSignature', 'true');
    f.git('config', 'gpg.format', 'ssh');
    const saved = join(f.repo, '..', 'stream.txt');
    const result = f.scan([`${head}^!`], { GITLEAKS_STDIN: saved });
    assert.equal(result.status, 0, result.stderr);
    const stream = readFileSync(saved, 'utf8');
    assertScanStream(stream, 'secret-scan', filteredOutput(f, [...scanLogArgs, `${head}^!`, '--']));
    assert.match(stream, new RegExp(`^commit ${head}\n\nAuthor: `, 'm'));
  });
