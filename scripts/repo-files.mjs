import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parse } from 'jsonc-parser';

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
export function jsonc(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object') throw new Error('Invalid JSON configuration');
  return value;
}
export const isMain = (url) => process.argv[1] && fileURLToPath(url) === resolve(process.argv[1]);
