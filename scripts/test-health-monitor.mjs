import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'onfreq-monitor-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'poll-endpoint'), 'https://example.test/poll');
  writeFileSync(join(dir, 'poll-secret'), 'synthetic-monitor-token');
  writeFileSync(join(dir, 'curl'), `#!/bin/sh
printf '%s\\n' "$@" >> "$ONFREQ_MONITOR_DIR/arguments"
cat > "$ONFREQ_MONITOR_DIR/header"
printf '%s' "$TEST_HTTP_CODE"
exit "$TEST_CURL_EXIT"
`, { mode: 0o700 });
  writeFileSync(join(dir, 'osascript'), `#!/bin/sh
printf '%s\\n' "$*" >> "$ONFREQ_MONITOR_DIR/notices"
exit "$TEST_NOTICE_EXIT"
`, { mode: 0o700 });
  return {
    dir,
    run(code = '200', overrides = {}) {
      return spawnSync('/bin/sh', [resolve('scripts/health-monitor.sh')], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ONFREQ_MONITOR_DIR: dir,
          ONFREQ_MONITOR_LOG: join(dir, 'monitor.log'), TEST_HTTP_CODE: code,
          TEST_CURL_EXIT: '0', TEST_NOTICE_EXIT: '0', ...overrides },
        encoding: 'utf8',
      });
    },
    read(name) { return readFileSync(join(dir, name), 'utf8'); },
  };
}

test('checks health with a stdin secret and no poll; alerts on failure and recovery', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(existsSync(join(f.dir, 'notices')), false);
  assert.match(f.read('arguments'), /https:\/\/example.test\/health/);
  assert.doesNotMatch(f.read('arguments'), /synthetic-monitor-token|\/poll|--location/);
  assert.equal(f.read('header'), 'authorization: Bearer synthetic-monitor-token\n');
  assert.equal(f.run('503').status, 1);
  assert.match(f.read('notices'), /needs attention/);
  const first = f.read('notices');
  assert.equal(f.run('503').status, 1);
  assert.equal(f.read('notices'), first);
  assert.equal(f.run().status, 0);
  assert.match(f.read('notices'), /recovered/);
  assert.doesNotMatch(f.read('monitor.log'), /synthetic-monitor-token|example.test/);
});

test('alerts on network errors and rejected authentication', (t) => {
  const f = fixture(t);
  assert.equal(f.run('200', { TEST_CURL_EXIT: '28' }).status, 1);
  assert.match(f.read('notices'), /needs attention/);
  assert.equal(f.run('401').status, 1);
});

test('rejects unsafe URLs and header values before making any request', (t) => {
  const f = fixture(t);
  for (const url of ['http://example.test/poll', 'https://user@example.test/poll',
    'https://example.test/poll?secret=x', 'https://[example.test]/poll',
    'https://example.test\n.evil/poll', 'https://<worker>.workers.dev/poll']) {
    writeFileSync(join(f.dir, 'poll-endpoint'), url);
    assert.equal(f.run().status, 1);
    assert.equal(existsSync(join(f.dir, 'arguments')), false);
  }
  writeFileSync(join(f.dir, 'poll-endpoint'), 'https://example.test/poll');
  writeFileSync(join(f.dir, 'poll-secret'), 'synthetic\nInjected: header');
  assert.equal(f.run().status, 1);
  assert.equal(existsSync(join(f.dir, 'arguments')), false);
});

test('repeats an outstanding failure hourly and retries failed notifications', (t) => {
  const f = fixture(t);
  f.run('503');
  writeFileSync(join(f.dir, 'health-monitor-state'), `failed ${Math.floor(Date.now() / 1000) - 3601}\n`);
  f.run('503');
  assert.equal(f.read('notices').trim().split('\n').length, 2);
  writeFileSync(join(f.dir, 'health-monitor-state'), 'failed 0\n');
  f.run('503', { TEST_NOTICE_EXIT: '1' });
  assert.equal(f.read('health-monitor-state'), 'failed 0\n');
  f.run('503');
  assert.equal(f.read('notices').trim().split('\n').length, 4);
  f.run('200', { TEST_NOTICE_EXIT: '1' });
  assert.equal(f.read('health-monitor-state'), 'failed 0\n');
  f.run();
  assert.match(f.read('health-monitor-state'), /^healthy /);
});
