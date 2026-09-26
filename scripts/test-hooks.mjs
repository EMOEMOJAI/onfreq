import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isolatedEnv } from './check-setup.mjs';

const hook = fileURLToPath(new URL('./hooks/pre-push', import.meta.url));
const zero = '0'.repeat(40);

// A synthetic repository with a fake npm that records which checks ran, so the
// hook's ref and index gating is tested without running the real checks.
function fixture(t, npmExit = 0) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-hooks-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  const env = isolatedEnv({ PATH: `${bin}:${process.env.PATH}`, NPM_LOG: join(dir, 'npm.log'), NPM_EXIT: String(npmExit) });
  for (const path of [repo, bin]) mkdirSync(path);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$NPM_LOG"\nexit "$NPM_EXIT"\n', { mode: 0o700 });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args[0]} failed`);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  writeFileSync(join(repo, 'public.txt'), 'first\n');
  git('add', 'public.txt');
  git('commit', '--quiet', '--no-verify', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'public.txt'), 'second\n');
  git('commit', '--quiet', '--no-verify', '-am', 'second');
  const head = git('rev-parse', 'HEAD');
  return {
    first, head, git, repo,
    push(lines) {
      rmSync(env.NPM_LOG, { force: true });
      const result = spawnSync('/bin/sh', [hook, 'origin', 'https://example.test/synthetic.git'],
        { cwd: repo, env, input: lines.join('\n'), encoding: 'utf8' });
      return { ...result, npm: existsSync(env.NPM_LOG) ? readFileSync(env.NPM_LOG, 'utf8') : '' };
    },
  };
}

const ref = (oid, name = 'refs/heads/main', remote = zero) => `${name} ${oid} ${name} ${remote}\n`;

test('pre-push runs privacy and setup checks when the pushed commit is the clean HEAD', (t) => {
  const f = fixture(t);
  for (const lines of [[ref(f.head)], [ref(f.head).trimEnd()], [ref(f.head), ref(zero, 'refs/heads/old', f.first)], []]) {
    const result = f.push(lines);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.npm, 'run --silent check:privacy\nrun --silent check:setup\n');
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
  // Unstaged working-tree edits are not pushed and do not affect index-based checks.
  writeFileSync(join(f.repo, 'public.txt'), 'unstaged\n');
  result = f.push([ref(f.head)]);
  assert.equal(result.status, 0, result.stderr);
});

test('pre-push blocks when a check fails', (t) => {
  const f = fixture(t, 1);
  const result = f.push([ref(f.head)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /privacy or deployment setup checks failed/);
});
