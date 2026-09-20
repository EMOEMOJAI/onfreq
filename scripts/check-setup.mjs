import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain, jsonc, readIndexed } from './repo-files.mjs';
import { publicConfig } from './check-privacy.mjs';

export function validateSetup(config, pkg, examples) {
  assert.deepEqual(publicConfig(config), [], 'Public configuration contains operator settings');
  assert.deepEqual(config.kv_namespaces, [{ binding: 'ATC_STATE', id: '0'.repeat(32) }]);
  assert.deepEqual(config.durable_objects?.bindings, [{ name: 'POLL_COORDINATOR', class_name: 'PollCoordinator' }]);
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['PollCoordinator'] }]);
  const required = ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_IDS', 'FIR_PREFIXES', 'POLL_SECRET'].sort();
  const lines = examples.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  assert.ok(lines.every((line) => /^[A-Z_]+=(?:""|'')$/.test(line)), 'First-run placeholders must be empty');
  assert.deepEqual(lines.map((line) => line.split('=')[0]).sort(), required);
  for (const name of required) assert.ok(pkg.cloudflare?.bindings?.[name]?.description?.trim(), `Missing guided prompt: ${name}`);
  assert.equal(pkg.scripts?.deploy, 'wrangler deploy');
  assert.equal(pkg.scripts?.predeploy, 'node scripts/check-deploy.mjs');
  assert.equal(pkg.scripts?.['deploy:local'], 'wrangler deploy --config wrangler.local.jsonc');
}

/** Execute npm's real predeploy lifecycle with a fake deploy command, never Wrangler. */
export function testDeployGuard(guard) {
  const dir = mkdtempSync(join(tmpdir(), 'onfreq-setup-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/check-deploy.mjs'), guard);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, scripts: {
      predeploy: 'node scripts/check-deploy.mjs', deploy: 'node -e "console.log(\'DEPLOY_REACHED\')"',
    } }));
    const run = () => spawnSync('npm', ['run', 'deploy'], { cwd: dir, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, npm_config_ignore_scripts: 'false' } });
    let result = run();
    assert.equal(result.status, 0, 'Fresh public installation must allow deployment');
    assert.match(result.stdout, /DEPLOY_REACHED/);
    writeFileSync(join(dir, 'wrangler.local.jsonc'), '{}');
    result = run();
    assert.notEqual(result.status, 0, 'Private installation must refuse public deployment');
    assert.doesNotMatch(result.stdout, /DEPLOY_REACHED/);
    assert.match(result.stderr, /Private deployment config detected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  // Avoid printing assertion values: a failed check may have caught private data.
  try {
    validateSetup(jsonc(readIndexed('wrangler.jsonc').toString()),
      JSON.parse(readIndexed('package.json')), readIndexed('.dev.vars.example').toString());
    testDeployGuard(readIndexed('scripts/check-deploy.mjs'));
    console.log('Deployment setup checks passed');
  } catch {
    console.error('Deployment setup check failed; inspect public configuration, prompts and predeploy guard locally');
    process.exitCode = 1;
  }
}
