import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lint } from 'markdownlint/promise';
import { isMain, jsonc, root as repoRoot } from './repo-files.mjs';

// Lints documentation with markdownlint itself, without markdownlint-cli2 and its glob
// dependencies. Only the glob forms the config uses are supported: `*.md` and `<dir>/*.md`
// (non-recursive) and exact paths. Other glob syntax, unknown config keys, globs matching
// nothing, symlinks, non-regular files and paths outside the repository all fail closed.
export const CONFIG = '.markdownlint-cli2.jsonc';
const KEYS = ['globs', 'config'];
// One literal path segment: no glob syntax, `.` or `..`.
const segment = /^(?!\.\.?$)[\w@.-]+$/;
const literal = (path) => path.split('/').every((part) => segment.test(part));
const inside = (base, path) => {
  const rel = relative(base, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function expand(glob, root) {
  if (typeof glob !== 'string') throw new Error(`Unsupported glob: ${JSON.stringify(glob)}`);
  const slash = glob.lastIndexOf('/');
  const dir = glob.slice(0, Math.max(slash, 0));
  if (glob.slice(slash + 1) === '*.md' && (!dir || literal(dir))) {
    const stat = lstatSync(join(root, dir), { throwIfNoEntry: false });
    const names = stat?.isDirectory() ? readdirSync(join(root, dir)) : [];
    return names.filter((name) => name.endsWith('.md')).sort().map((name) => (dir ? `${dir}/${name}` : name));
  }
  if (!literal(glob)) throw new Error(`Unsupported glob: ${glob}`);
  return lstatSync(join(root, glob), { throwIfNoEntry: false }) ? [glob] : [];
}

/** Read a regular file inside the repository; returns its repository-relative path and text. */
function readSafely(path, base, root, realRoot) {
  const absolute = resolve(base, path);
  if (!inside(root, absolute)) throw new Error(`${path}: outside the repository`);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) throw new Error(`${path}: missing file`);
  if (!stat.isFile()) throw new Error(`${path}: ${stat.isSymbolicLink() ? 'symlink' : 'not a regular file'}; refusing`);
  const real = realpathSync(absolute);
  if (!inside(realRoot, real)) throw new Error(`${path}: resolves outside the repository`);
  return [relative(realRoot, real).split(sep).join('/'), readFileSync(real, 'utf8')];
}

/** Formats a markdownlint error like markdownlint-cli2's default formatter. */
export function format(file, { lineNumber, ruleNames, ruleDescription, errorDetail, errorContext, errorRange, severity }) {
  const column = errorRange?.[0] ? `:${errorRange[0]}` : '';
  return `${file}:${lineNumber}${column}${severity ? ` ${severity}` : ''} ${ruleNames.join('/')} ${ruleDescription}`
    + `${errorDetail ? ` [${errorDetail}]` : ''}${errorContext ? ` [Context: "${errorContext}"]` : ''}`;
}

/**
 * Lint the config's globs, or the given file arguments instead. `--config <path>` overrides
 * the config file. Throws on any refusal; returns the linted files and formatted violations.
 */
export async function lintDocs(argv, { root = repoRoot, cwd = process.cwd() } = {}) {
  const base = resolve(root);
  const realRoot = realpathSync(base);
  let configPath = join(base, CONFIG);
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') {
      if (argv[i + 1] === undefined) throw new Error('--config needs a path');
      configPath = resolve(cwd, argv[++i]);
    } else if (argv[i].startsWith('-')) throw new Error(`Unknown option: ${argv[i]}`);
    else args.push(argv[i]);
  }
  const configName = inside(base, configPath) ? relative(base, configPath) : configPath;
  const [, text] = readSafely(configName, base, base, realRoot);
  let settings;
  try {
    settings = jsonc(text);
  } catch (error) {
    throw new Error(`${configName}: ${error.message}`);
  }
  const unknown = Array.isArray(settings) ? ['(array)'] : Object.keys(settings).filter((key) => !KEYS.includes(key));
  if (unknown.length) throw new Error(`${configName}: unsupported top-level keys: ${unknown.join(', ')}`);
  const { globs = [], config } = settings;
  if (!Array.isArray(globs)) throw new Error(`${configName}: globs must be an array`);
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) {
    throw new Error(`${configName}: config must be an object`);
  }
  const expanded = globs.map((glob) => [glob, expand(glob, base)]);
  let paths = args;
  if (!args.length) {
    if (!globs.length) throw new Error(`${configName}: no globs`);
    for (const [glob, matches] of expanded) if (!matches.length) throw new Error(`Glob matched no files: ${glob}`);
    paths = expanded.flatMap(([, matches]) => matches);
  }
  const strings = {};
  for (const path of paths) {
    const [file, contents] = readSafely(path, args.length ? cwd : base, base, realRoot);
    strings[file] = contents;
  }
  const results = await lint({ strings, config, handleRuleFailures: true });
  const files = Object.keys(strings).sort();
  const violations = files.flatMap((file) => [...results[file]]
    .sort((a, b) => a.lineNumber - b.lineNumber).map((error) => format(file, error)));
  return { files, violations };
}

if (isMain(import.meta.url)) {
  try {
    const { files, violations } = await lintDocs(process.argv.slice(2));
    for (const violation of violations) console.error(violation);
    console.log(`Markdown lint: ${violations.length ? 'FAILED' : 'passed'} (${files.length} files, ${violations.length} issues)`);
    process.exitCode = violations.length ? 1 : 0;
  } catch (error) {
    console.error(`Markdown lint: ${error.message}`);
    process.exitCode = 1;
  }
}
