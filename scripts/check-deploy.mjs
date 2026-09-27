import { lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A copied public template must never silently replace an existing deployment.
// The public deploy script runs this itself rather than as a predeploy hook,
// so npm's ignore-scripts setting cannot skip it. lstat also catches symlinks,
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
// check the main worktree: the first `worktree` line Git lists. Hooks or npm may
// export variables that point Git at another repository, so those are removed;
// GIT_CEILING_DIRECTORIES is kept so callers can still bound repository discovery.
// Without Git, or outside a repository, only this checkout can be checked; with
// a separate Git directory, Git lists that directory instead of the checkout.
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
