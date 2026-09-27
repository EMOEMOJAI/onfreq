import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Resolved from this file, so the tests run from any working directory.
const script = fileURLToPath(new URL('./poll-trigger.sh', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'onfreq-poll-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'poll-endpoint'), 'https://example.test/poll', { mode: 0o600 });
  writeFileSync(join(dir, 'poll-secret'), 'synthetic-poll-token', { mode: 0o600 });
  writeFileSync(join(dir, '.curlrc'), 'verbose\n');
  writeFileSync(join(dir, 'curl'), `#!/bin/sh
printf '%s\\n' "$@" > "$ONFREQ_POLL_DIR/arguments"
cat > "$ONFREQ_POLL_DIR/header"
if [ "$1" != -q ]; then cat "$ONFREQ_POLL_DIR/header" >&2; fi
printf 'SYNTHETIC_PRIVATE_DIAGNOSTIC https://example.test/poll\\n' >&2
discard=false
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ] && [ "$2" = /dev/null ]; then discard=true; fi
  shift
done
if [ "$discard" = false ]; then printf 'SYNTHETIC_PRIVATE_RESPONSE\\n'; fi
printf '%s' "$TEST_HTTP_CODE"
exit "$TEST_CURL_EXIT"
`, { mode: 0o700 });
  return {
    dir,
    run(code = '200', overrides = {}) {
      return spawnSync('/bin/sh', [script], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, POLL_ENDPOINT: '',
          ONFREQ_POLL_DIR: dir, ONFREQ_POLL_LOG: join(dir, 'poll.log'), CURL_HOME: dir,
          TEST_HTTP_CODE: code, TEST_CURL_EXIT: '0', ...overrides }, encoding: 'utf8',
      });
    },
    read(name) { return readFileSync(join(dir, name), 'utf8'); },
  };
}

test('posts with a stdin token and suppresses curl config, bodies and diagnostics', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0);
  const args = f.read('arguments').trim().split('\n');
  assert.equal(args[0], '-q');
  assert.ok(args.includes('--globoff'));
  assert.equal(args[args.indexOf('--request') + 1], 'POST');
  assert.equal(args[args.indexOf('--output') + 1], '/dev/null');
  assert.equal(args[args.indexOf('--header') + 1], '@-');
  assert.equal(f.read('header'), 'authorization: Bearer synthetic-poll-token\n');
  assert.doesNotMatch(f.read('arguments'), /synthetic-poll-token|--location/);
  assert.match(f.read('poll.log'), /ok http=200/);
  assert.doesNotMatch(f.read('poll.log') + result.stdout + result.stderr,
    /synthetic-poll-token|SYNTHETIC_PRIVATE|example.test/);
  assert.equal(statSync(join(f.dir, 'poll.log')).mode & 0o777, 0o600);
});

test('reports failures without echoing unsafe curl output or treating a timeout as success', (t) => {
  const f = fixture(t);
  for (const code of ['401', '500', 'SYNTHETIC_PRIVATE_RESPONSE', '200\nSYNTHETIC_PRIVATE_RESPONSE']) {
    assert.equal(f.run(code).status, 1);
  }
  assert.equal(f.run('200', { TEST_CURL_EXIT: '28' }).status, 1);
  assert.match(f.read('poll.log'), /FAIL http=000/);
  assert.doesNotMatch(f.read('poll.log'), /SYNTHETIC_PRIVATE|synthetic-poll-token|example.test/);
});

test('rejects unsafe URLs and malformed credentials before contacting curl', (t) => {
  const f = fixture(t);
  for (const url of ['http://example.test/poll', 'https://user@example.test/poll',
    'https://example.test/poll?secret=x', 'https://{one,two}.test/poll',
    'https://example.test\n.evil/poll', 'https://<worker>.workers.dev/poll', 'https://example.test/health']) {
    writeFileSync(join(f.dir, 'poll-endpoint'), url);
    assert.equal(f.run().status, 1);
    assert.equal(existsSync(join(f.dir, 'arguments')), false);
  }
  writeFileSync(join(f.dir, 'poll-endpoint'), 'https://example.test/poll');
  for (const secret of ['', 'bad token', 'synthetic\nInjected: header', 'synthetic\rtoken']) {
    writeFileSync(join(f.dir, 'poll-secret'), secret);
    assert.equal(f.run().status, 1);
    assert.equal(existsSync(join(f.dir, 'arguments')), false);
  }
});

test('restricts existing logs and keeps rotated logs private and bounded', (t) => {
  const f = fixture(t);
  const log = join(f.dir, 'poll.log');
  writeFileSync(log, 'old status\n'.repeat(1000));
  chmodSync(log, 0o644);
  assert.equal(f.run().status, 0);
  assert.equal(f.read('poll.log').trim().split('\n').length, 500);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.dir, 'poll.log.tmp')), false);
});

test('refuses to read credentials that other local accounts can access, without contacting curl', (t) => {
  const f = fixture(t);
  const cases = [['poll-secret', 0o644], ['poll-secret', 0o640], ['poll-secret', 0o604],
    ['poll-endpoint', 0o644], ['poll-endpoint', 0o620], ['.', 0o750], ['.', 0o701], ['.', 0o755]];
  for (const [name, mode] of cases) {
    chmodSync(join(f.dir, name), mode);
    const result = f.run();
    chmodSync(join(f.dir, name), name === '.' ? 0o700 : 0o600);
    assert.equal(result.status, 1, `${name} ${mode.toString(8)}`);
    assert.equal(existsSync(join(f.dir, 'arguments')), false);
  }
  // A symlink could point at a readable file elsewhere, whatever its own mode.
  const target = join(f.dir, 'elsewhere');
  writeFileSync(target, 'synthetic-poll-token', { mode: 0o644 });
  unlinkSync(join(f.dir, 'poll-secret'));
  symlinkSync(target, join(f.dir, 'poll-secret'));
  assert.equal(f.run().status, 1);
  assert.equal(existsSync(join(f.dir, 'arguments')), false);
  const lines = f.read('poll.log').trim().split('\n');
  assert.equal(lines.length, cases.length + 1);
  assert.ok(lines.every((line) => / FAIL permissions$/.test(line)));
  assert.doesNotMatch(lines.join('\n'), /synthetic-poll-token|example.test/);
  // Restoring private modes allows polling again.
  unlinkSync(join(f.dir, 'poll-secret'));
  writeFileSync(join(f.dir, 'poll-secret'), 'synthetic-poll-token', { mode: 0o600 });
  assert.equal(f.run().status, 0);
});

test('refuses credentials owned by another account, without contacting curl', (t) => {
  const f = fixture(t);
  // chown needs root, so report a different current user instead.
  writeFileSync(join(f.dir, 'id'), '#!/bin/sh\nprintf \'%s\\n\' "$TEST_UID"\n', { mode: 0o700 });
  const result = f.run('200', { TEST_UID: String(process.getuid() + 1) });
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(f.dir, 'arguments')), false);
  assert.match(f.read('poll.log'), / FAIL permissions$/m);
  assert.equal(f.run('200', { TEST_UID: String(process.getuid()) }).status, 0);
});

test('refuses macOS ACLs that grant other accounts access, without contacting curl',
  { skip: process.platform !== 'darwin' && 'macOS ACLs only' }, (t) => {
    const f = fixture(t);
    for (const name of ['poll-secret', 'poll-endpoint', '.']) {
      const path = join(f.dir, name);
      assert.equal(spawnSync('/bin/chmod', ['+a', 'everyone allow read', path]).status, 0);
      const result = f.run();
      assert.equal(spawnSync('/bin/chmod', ['-N', path]).status, 0);
      assert.equal(result.status, 1, name);
      assert.equal(existsSync(join(f.dir, 'arguments')), false);
    }
    assert.equal(f.read('poll.log').trim().split('\n').length, 3);
    assert.ok(f.read('poll.log').trim().split('\n').every((line) => / FAIL permissions$/.test(line)));
    assert.equal(f.run().status, 0);
  });
