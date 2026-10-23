// Real-Gitleaks tests of what the pre-commit hook, the pre-push hook and
// scripts/secret-scan.sh feed Gitleaks and how they report findings. The shared
// fixtures and helpers are in scripts/hook-test-helpers.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isolatedEnv } from './check-setup.mjs';
import {
  gitleaksSkip, syntheticKey, allowMarker, fixture, mergeOnlySecret, ref, rangeCheck, stageSyntheticKey, repoRules,
  commitRules, scanAssignment, realShaped, headStream, stagedStream, placeAt, secretScan, privateKeyPem, fillerLines,
  keyOffsets, idListLine, lineMarker, longLine, longFilter,
} from './hook-test-helpers.mjs';

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
