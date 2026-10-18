import { lstatSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A copied public template must never silently replace an existing deployment.
// The public deploy script runs this itself rather than as a predeploy hook,
// so npm's ignore-scripts setting cannot skip it. lstat also catches symlinks,
// including dangling ones; any error other than "absent" fails closed.
const root = fileURLToPath(new URL('../', import.meta.url));
// Any wrangler.local.* entry, whatever its extension or type, is private config.
const privateName = /^wrangler\.local\./;
// Public deploy pins --config wrangler.jsonc; refuse other configs Wrangler could
// prefer or redirect to, so only the reviewed public template can be deployed.
const unexpectedNames = ['wrangler.json', 'wrangler.toml', '.wrangler/deploy/config.json'];

function refuseUnchecked() {
  console.error('Could not check for private deployment config; refusing public deployment.');
  process.exit(1);
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return refuseUnchecked();
  }
}

function entries(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    return refuseUnchecked();
  }
}

// A Git worktree of a private checkout lacks the ignored private config, so also
// check the main worktree: the first `worktree` line Git lists. Hooks or npm may
// export variables that point Git at another repository, so those are removed;
// GIT_CEILING_DIRECTORIES is kept so callers can still bound repository discovery.
// Without Git, or outside a repository, only this checkout can be checked, which
// is refused for a linked worktree (below); with a separate Git directory, Git
// lists that directory instead of the checkout.
const repositoryVariable = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG.*)$/;
function mainWorktree() {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !repositoryVariable.test(name)));
    const [first = ''] = execFileSync('git', ['worktree', 'list', '--porcelain'],
      { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).split('\n');
    return first.startsWith('worktree ') ? first.slice('worktree '.length) : null;
  } catch {
    return null;
  }
}

const main = mainWorktree();
// A .git file marks a linked worktree (or separate Git directory): its main
// worktree may hold the private config, so it must be found to be checked.
let linked = false;
try { linked = lstatSync(join(root, '.git')).isFile(); } catch (error) { if (error?.code !== 'ENOENT') refuseUnchecked(); }
if (linked && !main) {
  console.error('Could not find the main Git worktree to check for private deployment config; refusing public deployment.');
  process.exit(1);
}
const roots = [...new Set([resolve(root), main].filter(Boolean))];
for (const dir of roots) {
  if (entries(dir).some((name) => privateName.test(name))) {
    console.error('Private deployment config detected. Use npm run deploy:local for this installation.');
    process.exit(1);
  }
}
if (unexpectedNames.some((name) => exists(join(root, name)))) {
  console.error('Unexpected Wrangler configuration detected; public deployment uses wrangler.jsonc only.');
  process.exit(1);
}
