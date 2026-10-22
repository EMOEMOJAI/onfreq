import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isolatedEnv } from './check-setup.mjs';

const hook = fileURLToPath(new URL('./hooks/pre-push', import.meta.url));
const hooksDir = fileURLToPath(new URL('./hooks', import.meta.url));
const preCommit = fileURLToPath(new URL('./hooks/pre-commit', import.meta.url));
const zero = '0'.repeat(40);
const hookHelpers = ['check-privacy.mjs', 'repo-files.mjs', 'secret-scan.sh', 'hooks/lib/gitleaks-settings.sh'];
const hasGitleaks = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;
// Locally a missing Gitleaks skips the real-scan tests; in CI they run and fail.
const gitleaksSkip = !hasGitleaks && !process.env.CI && 'gitleaks is not installed';
// A synthetic AWS-format key assembled at runtime, so this file never contains it.
const syntheticKey = () => ['AKIA', 'Q7RZ', 'LX2M', 'NB4K', 'TWPJ'].join('');

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
  // Separator characters, URL handles and noreply identities in a message pass.
  const clean = commit('synthetic\x1e\x1f\tsubject\n\nSee https://social.example/@person and pkg@1.2.3\x1e'
    + '\n\nCo-Authored-By: Synthetic Model <noreply@anthropic.com>');
  assert.equal(check().status, 0, check().stderr);
  assert.equal(f.push([ref(clean)]).status, 0);
  const head = commit(`synthetic\n\nContact ${person}\x1e\tfor access\x1f`);
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
// or archive format, and reads in 100 KB chunks that it extends by at most
// 25 KB to a blank line, so a line could be cut in two. The scans feed it a
// preamble first and a blank line after every line.
const preamble = '# onfreq secret-scan preamble';
function assertScanStream(stream, label) {
  // Past the furthest bytes a file-type signature uses (ISO 9660's, 32 769-32 773).
  const content = stream.search(new RegExp(`^(?!${preamble}$).+$`, 'm'));
  assert.ok(content >= 33000, `${label}: content starts at ${content}`);
  assert.ok(stream.split('\n').every((line, index) => index % 2 === 0 || line === ''), `${label}: lines without a blank line`);
}

test('both scans feed Gitleaks a preamble and a blank line after every line (RA)', (t) => {
  const f = fixture(t);
  const saved = join(f.repo, '..', 'stream.txt');
  writeFileSync(join(f.repo, 'public.txt'), 'staged\nsecond line\n');
  f.git('add', 'public.txt');
  let result = f.commitHook({ extraEnv: { GITLEAKS_STDIN: saved } });
  assert.equal(result.status, 0, result.stderr);
  let stream = readFileSync(saved, 'utf8');
  assertScanStream(stream, 'pre-commit');
  assert.match(stream, /^\+staged\n\n\+second line\n\n/m);
  rmSync(saved);
  f.git('commit', '--quiet', '--no-verify', '-m', 'staged');
  const head = f.git('rev-parse', 'HEAD');
  result = f.push([ref(head)], undefined, { GITLEAKS_STDIN: saved });
  assert.equal(result.status, 0, result.stderr);
  stream = readFileSync(saved, 'utf8');
  assertScanStream(stream, 'secret-scan');
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
const headStream = (f) => filteredOutput(f, ['log', '--pretty=medium', '--encoding=none', '-p', '-U0',
  '--inter-hunk-context=0', '--root', '--no-ext-diff', '--no-textconv', '--text', '--no-color', '--diff-merges=separate',
  '-1', 'HEAD', '--']);
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

test('a private key block is still flagged with blank lines between its lines (RA)',
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
