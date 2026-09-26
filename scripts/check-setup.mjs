import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { indexedFiles, isMain, jsonc, readIndexed } from './repo-files.mjs';
import { publicConfig } from './check-privacy.mjs';

// The guard runs inside the deploy script too, so npm --ignore-scripts cannot skip it.
// Deploy to Cloudflare and Workers Builds use the detected `npm run deploy`.
export const PUBLIC_DEPLOY = 'node scripts/check-deploy.mjs && wrangler deploy';
export const HOOKS = ['scripts/hooks/pre-commit', 'scripts/hooks/pre-push'];

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
  assert.equal(pkg.scripts?.deploy, PUBLIC_DEPLOY);
  assert.equal(pkg.scripts?.predeploy, 'node scripts/check-deploy.mjs');
  assert.equal(pkg.scripts?.['deploy:local'], 'wrangler deploy --config wrangler.local.jsonc');
}

/** Versioned hooks must be tracked as executable, or Git silently skips them. */
export function validateHooks(files) {
  for (const hook of HOOKS) assert.equal(files.get(hook)?.mode, '100755', `Missing executable hook: ${hook}`);
}

/**
 * Execute npm's real lifecycle with the public deploy script, replacing only its
 * final Wrangler call with a marker, never Wrangler. Covers npm ignore-scripts,
 * every private config name and a dangling symlink.
 */
export function testDeployGuard(guard, deploy = PUBLIC_DEPLOY) {
  // Only a script ending in Wrangler can be safely rewritten to a marker.
  assert.match(deploy, /(?:^|&& )wrangler deploy$/, 'Public deploy must end with wrangler deploy');
  const dir = mkdtempSync(join(tmpdir(), 'onfreq-setup-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/check-deploy.mjs'), guard);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, scripts: {
      predeploy: 'node scripts/check-deploy.mjs',
      deploy: deploy.replace(/wrangler deploy$/, 'node -e "console.log(\'DEPLOY_REACHED\')"'),
    } }));
    const run = (ignoreScripts) => spawnSync('npm', ['run', 'deploy'], { cwd: dir, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, npm_config_ignore_scripts: String(ignoreScripts) } });
    for (const ignoreScripts of [false, true]) {
      const result = run(ignoreScripts);
      assert.equal(result.status, 0, 'Fresh public installation must allow deployment');
      assert.match(result.stdout, /^DEPLOY_REACHED$/m);
    }
    const refuses = (ignoreScripts) => {
      const result = run(ignoreScripts);
      assert.notEqual(result.status, 0, 'Private installation must refuse public deployment');
      assert.doesNotMatch(result.stdout, /^DEPLOY_REACHED$/m);
      assert.match(result.stderr, /Private deployment config detected/);
    };
    for (const name of ['wrangler.local.jsonc', 'wrangler.local.json', 'wrangler.local.toml']) {
      writeFileSync(join(dir, name), '{}');
      refuses(false);
      refuses(true);
      rmSync(join(dir, name));
    }
    symlinkSync('missing-private-config', join(dir, 'wrangler.local.jsonc'));
    refuses(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  // Avoid printing assertion values: a failed check may have caught private data.
  try {
    const pkg = JSON.parse(readIndexed('package.json'));
    validateSetup(jsonc(readIndexed('wrangler.jsonc').toString()), pkg, readIndexed('.dev.vars.example').toString());
    validateHooks(indexedFiles());
    testDeployGuard(readIndexed('scripts/check-deploy.mjs'), pkg.scripts.deploy);
    console.log('Deployment setup checks passed');
  } catch {
    console.error('Deployment setup check failed; inspect public configuration, prompts, hooks and deploy guard locally');
    process.exitCode = 1;
  }
}
