import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { indexedFiles, isMain, jsonc, readIndexed } from './repo-files.mjs';
import { publicConfig } from './check-privacy.mjs';

// The guard runs inside the deploy script, not predeploy, so npm --ignore-scripts cannot skip it.
// Deploy to Cloudflare and Workers Builds use the detected `npm run deploy`.
// --config pins the public template: Wrangler otherwise prefers a wrangler.json or
// wrangler.toml found in the working directory or its ancestors, or a .wrangler/deploy redirect.
export const PUBLIC_DEPLOY = 'node scripts/check-deploy.mjs && wrangler deploy --config wrangler.jsonc';
export const HOOKS = ['scripts/hooks/pre-commit', 'scripts/hooks/pre-push'];
export const FIRST_RUN = ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_IDS', 'FIR_PREFIXES', 'POLL_SECRET'];
// The only non-empty value config/optional-secrets.example may publish.
export const OPTIONAL_DEFAULTS = ['GCA_DM_ENABLED="false"'];

const settingLines = (text) => text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

/** The OptionalSecrets keys declared in src/env.d.ts. */
export function optionalSecretNames(envTypes) {
  const body = /^type OptionalSecrets = \{\n([^}]*)\n\};$/m.exec(envTypes)?.[1];
  assert.ok(body, 'Missing OptionalSecrets type');
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.ok(lines.every((line) => /^[A-Z][A-Z0-9_]*\?: string;$/.test(line)), 'Unexpected OptionalSecrets member');
  return lines.map((line) => line.slice(0, line.indexOf('?')));
}

/** Optional settings are documented with empty values for exactly the optional secret names. */
export function validateOptionalSecrets(example, envTypes) {
  const lines = settingLines(example);
  assert.ok(lines.every((line) => /^[A-Z][A-Z0-9_]*=(?:""|'')$/.test(line) || OPTIONAL_DEFAULTS.includes(line)),
    'Optional setting examples must be empty');
  assert.deepEqual(lines.map((line) => line.split('=')[0]).sort(),
    optionalSecretNames(envTypes).filter((name) => name !== 'POLL_SECRET').sort());
}

/** Vitest bindings must cover every optional and first-run setting, so tests never read .dev.vars values. */
export function validateTestBindings(vitestConfig, envTypes) {
  const body = /^ {6}bindings: \{\n([\s\S]*?)\n {6}\},$/m.exec(vitestConfig)?.[1];
  assert.ok(body, 'Missing vitest miniflare bindings');
  const names = new Set([...body.matchAll(/^ {8}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]));
  for (const name of [...optionalSecretNames(envTypes), ...FIRST_RUN]) assert.ok(names.has(name), `Missing test binding: ${name}`);
}

// One single-line TOML literal string, which cannot contain ''' or a newline.
const LITERAL = String.raw`'''(?:(?!''')[^\n])*'''`;
const BASIC = String.raw`"[^"\\\n]*"`;
/**
 * The only key = value shapes the Gitleaks configuration may use, per table:
 * bare keys from a fixed list, with values of a fixed form. `regexes` may also
 * open a multi-line array of literal strings, one per line, closed by `]`.
 */
const GITLEAKS_KEYS = {
  top: { title: new RegExp(`^${BASIC}$`) },
  extend: { useDefault: /^true$/ },
  rules: {
    // Only this repository's own ids: a later rule with a default or repeated
    // id would replace that rule in Gitleaks.
    id: /^"onfreq-[a-z0-9-]+"$/,
    description: new RegExp(`^${BASIC}$`),
    regex: new RegExp(`^${LITERAL}$`),
    secretGroup: /^[0-9]$/,
    keywords: /^\["[a-z0-9_]+"(?:, "[a-z0-9_]+")*\]$/,
  },
  allowlists: {
    description: new RegExp(`^${BASIC}$`),
    regexTarget: /^"secret"$/,
    regexes: new RegExp(`^(?:\\[|\\[${LITERAL}(?:, ${LITERAL})*\\])$`),
  },
};
const GITLEAKS_HEADERS = { '[extend]': 'extend', '[[rules]]': 'rules', '[[rules.allowlists]]': 'allowlists' };

/**
 * The Gitleaks configuration must keep the default rules and add only this
 * repository's rules. A strict line grammar fails closed: every line is blank,
 * a full-line comment, one of three exact table headers, or a bare key from a
 * fixed per-table list with a value of a fixed form. Rule ids must be this
 * repository's own (onfreq-*), unique, and each rule needs an id, regex and
 * description. Quoted, escaped or dotted keys, inline tables, other headers
 * (including allowlists outside a rule), duplicate keys, a missing or repeated
 * [extend] and CRLF all fail. Errors are
 * fixed and never quote the file.
 */
export function validateGitleaksConfig(text) {
  const fail = () => assert.fail('Gitleaks configuration does not match the reviewed grammar');
  if (text.includes('\r') || !text.endsWith('\n')) fail();
  let section = 'top';
  let keys = new Set();
  let inArray = false;
  let extend = 0;
  let sawRule = false;
  const ids = new Set();
  // Each [[rules]] block needs its own id, regex and description.
  let rule;
  const closeRule = () => {
    if (rule && !['id', 'regex', 'description'].every((key) => rule.has(key))) fail();
    rule = undefined;
  };
  for (const line of text.slice(0, -1).split('\n')) {
    if (inArray) {
      if (line === ']') inArray = false;
      else if (!new RegExp(`^  ${LITERAL},$`).test(line)) fail();
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    if (Object.hasOwn(GITLEAKS_HEADERS, line)) {
      section = GITLEAKS_HEADERS[line];
      keys = new Set();
      if (section !== 'allowlists') closeRule();
      if (section === 'rules') rule = keys;
      if (section === 'extend' && ++extend > 1) fail();
      if (section === 'rules') sawRule = true;
      if (section === 'allowlists' && !sawRule) fail();
      continue;
    }
    const match = /^([A-Za-z]+) = (.+)$/.exec(line);
    const allowed = GITLEAKS_KEYS[section];
    if (!match || !Object.hasOwn(allowed, match[1]) || keys.has(match[1]) || !allowed[match[1]].test(match[2])) fail();
    keys.add(match[1]);
    if (section === 'rules' && match[1] === 'id') {
      if (ids.has(match[2])) fail();
      ids.add(match[2]);
    }
    if (match[2] === '[') inArray = true;
  }
  closeRule();
  if (inArray || extend !== 1 || !text.includes('\n[extend]\nuseDefault = true\n')) fail();
}

/** The secret-name comment in wrangler.jsonc lists exactly the optional and first-run secrets. */
export function validateWranglerSecretNames(text, envTypes) {
  const lines = text.split('\n').filter((line) => /^ {2}\/\/ {3}[A-Z]/.test(line));
  const listed = lines.flatMap((line) => line.match(/[A-Z][A-Z0-9_]*/g) ?? []);
  assert.equal(new Set(listed).size, listed.length, 'Duplicate secret name in wrangler.jsonc');
  assert.deepEqual([...listed].sort(), [...new Set([...optionalSecretNames(envTypes), ...FIRST_RUN])].sort(),
    'wrangler.jsonc secret-name comment must list exactly the optional and first-run secrets');
}

export function validateSetup(config, pkg, examples) {
  assert.deepEqual(publicConfig(config), [], 'Public configuration contains operator settings');
  assert.deepEqual(config.kv_namespaces, [{ binding: 'ATC_STATE', id: '0'.repeat(32) }]);
  assert.deepEqual(config.durable_objects?.bindings, [{ name: 'POLL_COORDINATOR', class_name: 'PollCoordinator' }]);
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['PollCoordinator'] }]);
  const required = [...FIRST_RUN].sort();
  const lines = settingLines(examples);
  assert.ok(lines.every((line) => /^[A-Z_]+=(?:""|'')$/.test(line)), 'First-run placeholders must be empty');
  assert.deepEqual(lines.map((line) => line.split('=')[0]).sort(), required);
  for (const name of required) assert.ok(pkg.cloudflare?.bindings?.[name]?.description?.trim(), `Missing guided prompt: ${name}`);
  assert.equal(pkg.scripts?.deploy, PUBLIC_DEPLOY);
  assert.equal(pkg.scripts?.['deploy:local'], 'wrangler deploy --config wrangler.local.jsonc');
}

/** Versioned hooks must be tracked as executable, or Git silently skips them. */
export function validateHooks(files) {
  for (const hook of HOOKS) assert.equal(files.get(hook)?.mode, '100755', `Missing executable hook: ${hook}`);
}

/** Hooks and npm may export GIT_DIR and friends; fixtures must not inherit a real repository. */
export function isolatedEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return { ...env, GIT_CEILING_DIRECTORIES: tmpdir(), ...extra };
}

/**
 * Execute npm's real lifecycle with the public deploy script, replacing only its
 * final Wrangler call with a marker that echoes its arguments, never Wrangler.
 * Covers npm ignore-scripts, the pinned public config, every private config name,
 * a dangling symlink and configs Wrangler could prefer or redirect to.
 */
export function testDeployGuard(guard, deploy = PUBLIC_DEPLOY) {
  // Only a script ending in Wrangler can be safely rewritten to a marker.
  const wrangler = /(^|&& )wrangler deploy((?: [\w./=-]+)*)$/;
  assert.match(deploy, wrangler, 'Public deploy must end with wrangler deploy');
  const dir = mkdtempSync(join(tmpdir(), 'onfreq-setup-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/check-deploy.mjs'), guard);
    writeFileSync(join(dir, 'scripts/deploy-marker.mjs'),
      "console.log('DEPLOY_REACHED'); console.log(['ARGS', ...process.argv.slice(2)].join(' '));\n");
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, scripts: {
      deploy: deploy.replace(wrangler, '$1node scripts/deploy-marker.mjs$2'),
    } }));
    const run = (ignoreScripts) => spawnSync('npm', ['run', 'deploy'], { cwd: dir, encoding: 'utf8', timeout: 15_000,
      env: isolatedEnv({ npm_config_ignore_scripts: String(ignoreScripts) }) });
    for (const ignoreScripts of [false, true]) {
      const result = run(ignoreScripts);
      assert.equal(result.status, 0, 'Fresh public installation must allow deployment');
      assert.match(result.stdout, /^DEPLOY_REACHED$/m);
      assert.match(result.stdout, /^ARGS --config wrangler\.jsonc$/m, 'Public deploy must pin --config wrangler.jsonc');
    }
    const refuses = (ignoreScripts, message) => {
      const result = run(ignoreScripts);
      assert.notEqual(result.status, 0, 'Private installation must refuse public deployment');
      assert.doesNotMatch(result.stdout, /^DEPLOY_REACHED$/m);
      assert.match(result.stderr, message);
    };
    for (const name of ['wrangler.local.jsonc', 'wrangler.local.json', 'wrangler.local.toml', 'wrangler.local.yaml',
      'wrangler.local.jsonc.bak', 'wrangler.local.']) {
      writeFileSync(join(dir, name), '{}');
      refuses(false, /Private deployment config detected/);
      refuses(true, /Private deployment config detected/);
      rmSync(join(dir, name));
    }
    mkdirSync(join(dir, 'wrangler.local.d'));
    refuses(true, /Private deployment config detected/);
    rmSync(join(dir, 'wrangler.local.d'), { recursive: true });
    symlinkSync('missing-private-config', join(dir, 'wrangler.local.jsonc'));
    refuses(true, /Private deployment config detected/);
    rmSync(join(dir, 'wrangler.local.jsonc'));
    mkdirSync(join(dir, '.wrangler/deploy'), { recursive: true });
    for (const name of ['wrangler.json', 'wrangler.toml', '.wrangler/deploy/config.json']) {
      writeFileSync(join(dir, name), '{}');
      refuses(false, /Unexpected Wrangler configuration detected/);
      refuses(true, /Unexpected Wrangler configuration detected/);
      rmSync(join(dir, name));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  // Avoid printing assertion values: a failed check may have caught private data.
  try {
    const pkg = JSON.parse(readIndexed('package.json'));
    validateSetup(jsonc(readIndexed('wrangler.jsonc').toString()), pkg, readIndexed('.dev.vars.example').toString());
    validateHooks(indexedFiles());
    const envTypes = readIndexed('src/env.d.ts').toString();
    validateOptionalSecrets(readIndexed('config/optional-secrets.example').toString(), envTypes);
    validateTestBindings(readIndexed('vitest.config.ts').toString(), envTypes);
    validateWranglerSecretNames(readIndexed('wrangler.jsonc').toString(), envTypes);
    validateGitleaksConfig(readIndexed('.gitleaks.toml').toString());
    testDeployGuard(readIndexed('scripts/check-deploy.mjs'), pkg.scripts.deploy);
    console.log('Deployment setup checks passed');
  } catch {
    console.error('Deployment setup check failed; inspect public configuration, prompts, optional settings, test bindings, Gitleaks settings, hooks and deploy guard locally');
    process.exitCode = 1;
  }
}
