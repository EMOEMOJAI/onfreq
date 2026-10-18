import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, visit } from 'jsonc-parser';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
// Read the index, never ignored operator files or symlink targets.
export function indexedFiles() {
  return new Map(git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean).map((row) => {
    const [mode, hash, stage] = row.slice(0, row.indexOf('\t')).split(' ');
    if (stage !== '0') throw new Error('Resolve the index conflict before running repository checks');
    return [row.slice(row.indexOf('\t') + 1), { mode, hash }];
  }));
}
export const readIndexed = (file) => git('show', `:${file}`);
// A parsed `__proto__` key, escaped or not, becomes the object's prototype: its
// settings would still be read but hidden from key checks, so it is refused.
export function jsonc(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object') throw new Error('Invalid JSON configuration');
  let proto = false;
  visit(text, { onObjectProperty: (name) => { if (name === '__proto__') proto = true; } }, { allowTrailingComma: true });
  if (proto) throw new Error('__proto__ keys are not allowed');
  return value;
}
// Node runs a symlinked script from its real path, so compare real paths.
export function isMain(url) {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
