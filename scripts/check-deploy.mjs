import { lstatSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A copied public template must never silently replace an existing deployment.
// The public deploy script runs this itself rather than as a predeploy hook,
// so npm's ignore-scripts setting cannot skip it. lstat also catches symlinks,
// including dangling ones; any error other than "absent" fails closed.
const root = fileURLToPath(new URL('../', import.meta.url));
// Any wrangler.local.* entry, whatever its extension, type or letter case, is private config.
const privateName = /^wrangler\.local\./i;
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

// A directory that holds private config if any entry has a private name. This
// checkout and every listed worktree must be readable: any error, including a
// listed worktree that is missing, fails closed.
function hasPrivateConfig(dir) {
  try {
    return readdirSync(dir).some((name) => privateName.test(name));
  } catch {
    return refuseUnchecked();
  }
}

// A Git worktree of a private checkout lacks the ignored private config, which
// may sit in any other worktree of the same repository: the main checkout, a
// sibling linked worktree or, in a bare layout, any worktree of the bare
// repository. So every worktree Git lists is checked, except those Git reports
// as prunable (their directory is gone). Hooks or npm may export
// variables that point Git at another repository, so those are removed;
// GIT_CEILING_DIRECTORIES is kept so callers can still bound repository discovery.
const repositoryVariable = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG.*)$/;
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !repositoryVariable.test(name)));
function listing(args) {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain', ...args],
      { cwd: root, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch {
    return null;
  }
}

// One porcelain record, in the order Git writes it: worktree <path>, then bare,
// or HEAD <object> and detached or branch <ref>; then optional locked and
// prunable lines. Anything else, including an unknown line, fails the parse.
const OBJECT = /^HEAD [0-9a-f]{40}(?:[0-9a-f]{24})?$/;
function parseRecord(fields) {
  const [first = '', ...rest] = fields;
  const path = first.startsWith('worktree ') ? first.slice('worktree '.length) : '';
  if (!isAbsolute(path)) return null;
  let next = 0;
  if (rest[next] === 'bare') next += 1;
  else if (OBJECT.test(rest[next] ?? '') && /^(?:detached|branch refs\/\S+)$/.test(rest[next + 1] ?? '')) next += 2;
  else return null;
  if (/^locked(?: |$)/.test(rest[next] ?? '')) next += 1;
  const prunable = /^prunable(?: |$)/.test(rest[next] ?? '');
  if (prunable) next += 1;
  return next === rest.length ? { path, prunable } : null;
}

// Fields end with the terminator and each record with an empty field. Returns
// the worktrees to check, or null when the output does not parse cleanly.
function parseWorktrees(output, terminator) {
  if (!output.endsWith(terminator + terminator)) return null;
  const records = output.slice(0, -2 * terminator.length).split(terminator + terminator);
  const worktrees = records.map((record) => parseRecord(record.split(terminator)));
  return worktrees.every(Boolean) ? worktrees.filter((worktree) => !worktree.prunable).map((worktree) => worktree.path) : null;
}

// Git 2.36 and later separate fields with NUL (-z), so any path parses. Older
// Git rejects -z; its newline listing is parsed strictly instead, so a path
// with a newline fails the parse unless it is itself shaped as whole records.
// Without a listing (no Git, or not a
// repository) only this checkout can be checked, which is refused when it has
// a .git entry: a main checkout, linked worktree or separate Git directory may
// have worktrees elsewhere.
function worktrees() {
  const nul = listing(['-z']);
  const output = nul ?? listing([]);
  if (output !== null) return parseWorktrees(output, nul === null ? '\n' : '\0') ?? refuseUnlisted();
  let checkout = true;
  try { lstatSync(join(root, '.git')); } catch (error) { if (error?.code === 'ENOENT') checkout = false; else refuseUnchecked(); }
  return checkout ? refuseUnlisted() : [];
}

function refuseUnlisted() {
  console.error('Could not list the Git worktrees to check for private deployment config; refusing public deployment.');
  process.exit(1);
}

if (hasPrivateConfig(root) || worktrees().some(hasPrivateConfig)) {
  console.error('Private deployment config detected. Use npm run deploy:local for this installation.');
  process.exit(1);
}
if (unexpectedNames.some((name) => exists(join(root, name)))) {
  console.error('Unexpected Wrangler configuration detected; public deployment uses wrangler.jsonc only.');
  process.exit(1);
}
