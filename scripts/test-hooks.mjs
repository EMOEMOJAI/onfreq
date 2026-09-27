import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isolatedEnv } from './check-setup.mjs';

const hook = fileURLToPath(new URL('./hooks/pre-push', import.meta.url));
const hooksDir = fileURLToPath(new URL('./hooks', import.meta.url));
const preCommit = fileURLToPath(new URL('./hooks/pre-commit', import.meta.url));
const preCommitShim = fileURLToPath(new URL('./pre-commit', import.meta.url));
const zero = '0'.repeat(40);
const hasGitleaks = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;
// A synthetic AWS-format key assembled at runtime, so this file never contains it.
const syntheticKey = () => ['AKIA', 'Q7RZ', 'LX2M', 'NB4K', 'TWPJ'].join('');

// A synthetic repository with fake npm and gitleaks commands that record their
// arguments (and, for gitleaks, the commits in the scanned log), so the hook's ref
// and index gating is tested without running the real checks. With realRange,
// range checks run the real check-privacy.mjs copied into the fixture; gitleaks:
// 'real' uses the installed Gitleaks, 'missing' none. Global and system Git
// configuration are ignored so the scanned log format is predictable.
function fixture(t, { npmExit = 0, realRange = false, gitleaks = 'fake', gitleaksExit = 0 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-hooks-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  const env = isolatedEnv({ PATH: `${bin}:${process.env.PATH}`, NPM_LOG: join(dir, 'npm.log'), NPM_EXIT: String(npmExit),
    GITLEAKS_LOG: join(dir, 'gitleaks.log'), GITLEAKS_EXIT: String(gitleaksExit),
    NODE: process.execPath, REAL_RANGE: realRange ? '1' : '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  for (const path of [repo, bin, join(repo, 'scripts')]) mkdirSync(path);
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
printf '[%s]' "$@" >> "$GITLEAKS_LOG"
printf '\\n' >> "$GITLEAKS_LOG"
if [ -n "\${GITLEAKS_CONFIG+x}\${GITLEAKS_CONFIG_TOML+x}" ]; then printf 'config variable set\\n' >> "$GITLEAKS_LOG"; fi
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
  if (realRange) {
    for (const name of ['check-privacy.mjs', 'repo-files.mjs']) {
      copyFileSync(new URL(`./${name}`, import.meta.url), join(repo, 'scripts', name));
    }
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(repo, 'node_modules'));
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  } else {
    writeFileSync(join(repo, 'scripts/check.mjs'), '// synthetic check\n');
  }
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
  assert.match(result.stderr, /pushed commits look like they contain a secret/);
  f = fixture(t, { gitleaks: 'missing' });
  result = f.push([ref(f.head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /install gitleaks before pushing/);
  assert.equal(result.npm, '');
});

test('pre-push Gitleaks scan catches a secret committed with --no-verify and redacts it (S19-24)',
  { skip: !hasGitleaks && 'gitleaks is not installed' }, (t) => {
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
    assert.match(result.stderr, /pushed commits look like they contain a secret/);
    assert.doesNotMatch(result.stderr + result.stdout, new RegExp(token.slice(4)));
    assert.equal(result.npm, rangeCheck(head), 'the secret scan blocks before the full checks');
    // A remote that already has the secret commit is only sent the removal.
    result = f.push([ref(head, 'refs/heads/main', secret)]);
    assert.equal(result.status, 0, result.stderr);
  });

test('pre-push Gitleaks scan reads the literal bytes of binary, -diff and textconv files (S19-28)',
  { skip: !hasGitleaks && 'gitleaks is not installed' }, (t) => {
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
      assert.match(result.stderr, /pushed commits look like they contain a secret/, name);
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
  { skip: !hasGitleaks && 'gitleaks is not installed' }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const { merge, head } = mergeOnlySecret(f, token);
    let result = f.push([ref(head, 'refs/heads/main', f.head)]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /pushed commits look like they contain a secret/);
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
  { skip: !hasGitleaks && 'gitleaks is not installed' }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    const token = syntheticKey();
    const { head } = mergeOnlySecret(f, token);
    // With this repository setting, `git log -m` shows no merge diffs at all.
    f.git('config', 'log.diffMerges', 'off');
    const result = f.push([ref(head, 'refs/heads/main', f.head)]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /pushed commits look like they contain a secret/);
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

test('pre-push ignores Gitleaks configuration variables (S19-29)', (t) => {
  const f = fixture(t);
  const result = f.push([ref(f.head)], undefined,
    { GITLEAKS_CONFIG: join(f.repo, 'rules.toml'), GITLEAKS_CONFIG_TOML: 'title = "no rules"\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.gitleaks, leakScan(f.head, f.first));
});

test('pre-push Gitleaks scan cannot be emptied by configuration variables (S19-29)',
  { skip: !hasGitleaks && 'gitleaks is not installed' }, (t) => {
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
      assert.match(result.stderr, /pushed commits look like they contain a secret/);
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
  for (const file of ['package.json', 'scripts/check.mjs']) {
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

test('pre-commit passes a clean commit, directly, through the shim and as an installed hook (S19-31)', (t) => {
  const f = fixture(t, { gitleaks: hasGitleaks ? 'real' : 'fake' });
  writeFileSync(join(f.repo, 'public.txt'), 'clean\n');
  f.git('add', 'public.txt');
  for (const path of [preCommit, preCommitShim]) {
    const result = f.commitHook({ path });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
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
  { skip: !hasGitleaks && 'gitleaks is not installed' }, (t) => {
    const f = fixture(t, { gitleaks: 'real' });
    // A configuration with no rules reports nothing when Gitleaks honours it.
    const rules = join(f.repo, '..', 'rules.toml');
    writeFileSync(rules, 'title = "no rules"\n');
    const token = stageSyntheticKey(f);
    const head = f.git('rev-parse', 'HEAD');
    for (const env of [{}, { GITLEAKS_CONFIG: rules }, { GITLEAKS_CONFIG_TOML: 'title = "no rules"\n' }]) {
      for (const options of [{ extraEnv: env }, { extraEnv: env, path: preCommitShim }, { extraEnv: env, commit: true }]) {
        const result = f.commitHook(options);
        const label = JSON.stringify(Object.keys(env)) + (options.path ? ' shim' : '') + (options.commit ? ' git commit' : '');
        assert.equal(result.status, 1, `${label}: ${result.stderr}`);
        assert.match(result.stderr, /staged changes look like they contain a secret/, label);
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
    result = f.commitHook({ path: preCommitShim });
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
  assert.match(result.stderr, /could not read the staged changes for the secret scan/);
});
