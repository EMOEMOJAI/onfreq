// Git hook and secret-scan tests with fake npm and Gitleaks, and other tests
// that need no real Gitleaks scan. The real-Gitleaks tests are in
// scripts/test-hooks-*.mjs, so node --test runs them in parallel processes;
// the shared fixtures and helpers are in scripts/hook-test-helpers.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolatedEnv } from './check-setup.mjs';
import {
  zero, hookHelpers, hasGitleaks, allowMarker, fixture, ref, checks, rangeCheck, leakScan, gitleaksNote,
  preambleStream, assertScanStream, gitEnv, filteredOutput, scanLogArgs, headStream, stagedStream, keyKind,
  syntheticKeyLines, lineMarker, longLine,
} from './hook-test-helpers.mjs';

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
  let result = f.push([ref(f.head)]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /note/);
  const [ignore, ignoreShort] = commit('ignore list', { '.gitleaksignore': '# synthetic\n' });
  result = f.push([ref(ignore, 'refs/heads/main', f.head)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, gitleaksNote(ignoreShort));
  const [allow, allowShort] = commit('allow', { 'allowed.txt': 'example = "synthetic" # gitleaks:allow\n' });
  result = f.push([ref(allow, 'refs/heads/main', ignore)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, gitleaksNote(allowShort));
  assert.equal(result.gitleaks, leakScan(allow), 'the scan is unchanged');
  // Each commit is named once, whichever way it qualifies.
  const [both, bothShort] = commit('both', { '.gitleaksignore': '# synthetic\n# more\n', 'allowed.txt': 'x = 1 # gitleaks:allow\n' });
  result = f.push([ref(both, 'refs/heads/main', f.head)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, gitleaksNote(`${bothShort} ${ignoreShort} ${allowShort}`));
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
      assert.match(result.stderr, gitleaksNote(mergeShort), `${name} log.diffMerges=${diffMerges}`);
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
  assert.match(pushNew(oid).stderr, gitleaksNote(short));
  // A UTF-16 encoding header, then a UTF-16 log output encoding, cannot hide it.
  [oid, short] = commit('synthetic gitleaks:allow', { config: ['-c', 'i18n.commitEncoding=UTF-16'] });
  assert.match(pushNew(oid).stderr, gitleaksNote(short));
  f.git('config', 'i18n.logOutputEncoding', 'UTF-16');
  [oid, short] = commit('synthetic gitleaks:allow again');
  assert.match(pushNew(oid).stderr, gitleaksNote(short));
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
  assert.match(mergeResult.stderr, gitleaksNote(mergeShort));
  assert.doesNotMatch(mergeResult.stderr, new RegExp(sideShort));
  // In both the message and the diff: named once.
  [oid, short] = commit('both gitleaks:allow', { file: 'allowed.txt', text: 'x = 1 # gitleaks:allow\n' });
  assert.match(pushNew(oid).stderr, gitleaksNote(short));
  // A plain commit is not named.
  [oid] = commit('plain');
  assert.doesNotMatch(pushNew(oid).stderr, /note/);
});

test('pre-push names commits whose author or changed path carries gitleaks:allow (NX-1c)', (t) => {
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
    assert.match(pushNew(oid), gitleaksNote(short), label);
  }
  // A path, added or as either side of a rename, without the marker in any
  // line of the diff: -G alone would not name these commits.
  const marked = 'notes-GitLeaks:Allow.txt';
  let [oid, short] = commit({ file: marked });
  assert.match(pushNew(oid), gitleaksNote(short), 'added path');
  [oid, short] = commit({ file: 'renamed.txt', rename: marked });
  assert.match(pushNew(oid), gitleaksNote(short), 'renamed from');
  [oid, short] = commit({ file: `again-${marked}`, rename: 'renamed.txt' });
  assert.match(pushNew(oid), gitleaksNote(short), 'renamed to');
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
  assert.match(pushNew(merge), gitleaksNote(f.git('log', '-1', '--format=%h')), 'merge-only path');
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
