import { lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A copied public template must never silently replace an existing deployment.
// The public deploy script runs this directly as well as through predeploy, so
// npm's ignore-scripts setting cannot skip it. lstat also catches symlinks,
// including dangling ones; any error other than "absent" fails closed.
const root = fileURLToPath(new URL('../', import.meta.url));
const privateNames = ['wrangler.local.jsonc', 'wrangler.local.json', 'wrangler.local.toml'];
// Public deploy pins --config wrangler.jsonc; refuse other configs Wrangler could
// prefer or redirect to, so only the reviewed public template can be deployed.
const unexpectedNames = ['wrangler.json', 'wrangler.toml', '.wrangler/deploy/config.json'];

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    console.error('Could not check for private deployment config; refusing public deployment.');
    process.exit(1);
  }
}

// A Git worktree of a private checkout lacks the ignored private config, so also
// check the main worktree (parent of the common Git directory). Without Git, or
// outside a repository, only this checkout can be checked.
function mainWorktree() {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return common ? dirname(resolve(root, common)) : null;
  } catch {
    return null;
  }
}

const roots = [...new Set([resolve(root), mainWorktree()].filter(Boolean))];
for (const dir of roots) {
  if (privateNames.some((name) => exists(join(dir, name)))) {
    console.error('Private deployment config detected. Use npm run deploy:local for this installation.');
    process.exit(1);
  }
}
if (unexpectedNames.some((name) => exists(join(root, name)))) {
  console.error('Unexpected Wrangler configuration detected; public deployment uses wrangler.jsonc only.');
  process.exit(1);
}
