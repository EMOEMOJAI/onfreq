import { git, indexedFiles, isMain, jsonc, readIndexed } from './repo-files.mjs';

export function privatePath(file) {
  const name = file.split('/').at(-1);
  return /(^|\/)(?:\.local|\.wrangler|node_modules)(\/|$)/.test(file) ||
    /^(?:\.env|\.dev\.vars)(?:\..*)?$/.test(name) && !['.env.example', '.dev.vars.example'].includes(name) ||
    /(?:\.local\.(?:sh|jsonc?|md)|\.(?:pem|key|p12|pfx|log)|-secret(?:\.txt)?)$/i.test(name) ||
    /^(?:secrets\.json|poll-secret|poll-endpoint|settings\.local\.json|gitleaks-report\..*)$/.test(name) ||
    /^(?:wrangler\.local\..*|\.npmrc|\.DS_Store)$/.test(name) ||
    /^docs\/pr-audit-[^/]*\.md$/.test(file);
}

/** Validate every tracked Wrangler config without printing its values; TOML cannot be checked. */
export const wranglerFile = (file) => /(^|\/)wrangler[^/]*\.(?:jsonc?|toml)$/.test(file);
export function wranglerConfigErrors(file, data) {
  if (!wranglerFile(file)) return [];
  if (file.endsWith('.toml')) return [`${file}: Wrangler TOML configuration is not allowed; use wrangler.jsonc`];
  let config;
  try { config = jsonc(data.toString()); } catch { return [`${file}: invalid Wrangler configuration`]; }
  return publicConfig(config).map((error) => `${file}: ${error}`);
}

export function publicConfig(config) {
  const errors = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'id' || key.endsWith('_id')) && child !== '0'.repeat(32)) errors.push('non-placeholder deployment ID');
      if (['routes', 'route', 'account_id', 'zone_id'].includes(key)) errors.push('operator deployment setting');
      visit(child);
    }
  }
  visit(config);
  if (Object.keys(config.vars ?? {}).some((name) => name !== 'OFFLINE_GRACE_POLLS')) errors.push('operator variable');
  if (config.env) errors.push('public template contains environment-specific configuration');
  return [...new Set(errors)];
}

// Formats whose metadata this check cannot parse; publishing them needs manual review.
const reviewedImages = /\.(?:gif|avif|heic|heif|tiff?|bmp)$/i;
export const imageFile = (file) => /\.(?:png|jpe?g|webp|svg)$/i.test(file) || reviewedImages.test(file);

/** Reject text/EXIF/C2PA metadata without printing it; preserve rendering color profiles. */
export function imagePrivacy(file, data) {
  if (reviewedImages.test(file)) return 'image format requires review';
  if (/\.svg$/i.test(file)) {
    return /<metadata\b|inkscape:|sodipodi:|\/Users\/|\/home\//i.test(data.toString('utf8'))
      ? 'SVG contains editor metadata or a local path' : null;
  }
  if (/\.png$/i.test(file)) {
    if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'invalid PNG';
    for (let offset = 8; offset < data.length;) {
      if (offset + 12 > data.length) return 'invalid PNG chunk';
      const size = data.readUInt32BE(offset);
      const type = data.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + size > data.length) return 'invalid PNG chunk';
      if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'caBX'].includes(type)) return 'PNG contains metadata';
      offset += 12 + size;
      if (type === 'IEND') return offset === data.length ? null : 'PNG has trailing data';
    }
    return 'incomplete PNG';
  }
  if (/\.jpe?g$/i.test(file)) {
    if (data.length < 2 || data.readUInt16BE(0) !== 0xffd8) return 'invalid JPEG';
    let offset = 2;
    let inScan = false;
    let sawScan = false;
    while (offset < data.length) {
      // Scan data escapes literal FF bytes as FF00. Restart markers do not
      // end the scan; other markers resume ordinary segment parsing.
      if (inScan) while (offset < data.length && data[offset] !== 0xff) offset++;
      if (data[offset] !== 0xff) return 'invalid JPEG marker';
      while (data[offset] === 0xff) offset++; // optional marker fill bytes
      if (offset >= data.length) return 'incomplete JPEG marker';
      const type = data[offset++];
      if (inScan && (type === 0 || (type >= 0xd0 && type <= 0xd7))) continue;
      if (type === 0 || type === 0xd8 || (type >= 0xd0 && type <= 0xd7)) return 'invalid JPEG marker';
      if (type === 0xd9) {
        if (!sawScan) return 'JPEG has no image scan';
        return offset === data.length ? null : 'JPEG has trailing data';
      }
      if (type === 0x01) continue; // standalone arithmetic-coding TEM marker
      // APP1 EXIF/XMP, APP11 C2PA/JUMBF, APP13 IPTC and comments.
      if ([0xe1, 0xeb, 0xed, 0xfe].includes(type)) return 'JPEG contains EXIF/XMP/C2PA/IPTC/comment metadata';
      if (offset + 2 > data.length) return 'incomplete JPEG segment';
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) return 'invalid JPEG segment';
      offset += size;
      // DNL may occur inside a scan; SOS starts each progressive scan.
      inScan = type === 0xda || (inScan && type === 0xdc);
      if (type === 0xda) sawScan = true;
    }
    return 'incomplete JPEG';
  }
  if (/\.webp$/i.test(file)) {
    if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return 'invalid WebP';
    if (data.length < 12 || data.readUInt32LE(4) + 8 !== data.length) return 'invalid WebP length';
    for (let offset = 12; offset < data.length;) {
      if (offset + 8 > data.length) return 'invalid WebP chunk';
      const type = data.toString('ascii', offset, offset + 4);
      if (['EXIF', 'XMP ', 'C2PA'].includes(type)) return 'WebP contains metadata';
      const size = data.readUInt32LE(offset + 4);
      offset += 8 + size + size % 2;
      if (offset > data.length) return 'invalid WebP chunk';
    }
  }
  return null;
}

export function privateCommitEmails(log) {
  return log.trim().split('\n').filter(Boolean).flatMap((row) => {
    const [hash, author, committer] = row.split('\t');
    // GitHub creates merge commits with noreply@github.com as the committer;
    // it is a public service identity, unlike a maintainer's private address.
    const allowed = (email) => /^(?:[^\s@]+@users\.noreply\.github\.com|noreply@github\.com)$/i.test(email ?? '');
    return [author, committer].every(allowed)
      ? [] : [`${hash.slice(0, 12)}: commit email must use GitHub noreply`];
  });
}

/** Checks one file version by path, mode and blob; never prints its contents. */
export function fileErrors(file, mode, read) {
  if (privatePath(file)) return [`${file}: private file is tracked`];
  if (!['100644', '100755'].includes(mode)) return [`${file}: symlink or submodule requires review`];
  // Only images and Wrangler configs are inspected, so other blobs are never read.
  if (imageFile(file)) {
    const error = imagePrivacy(file, read());
    return error ? [`${file}: ${error}`] : [];
  }
  return wranglerFile(file) ? wranglerConfigErrors(file, read()) : [];
}

export function checkPrivacy() {
  const errors = [];
  for (const [file, { mode }] of indexedFiles()) errors.push(...fileErrors(file, mode, () => readIndexed(file)));
  if (git('rev-parse', '--is-shallow-repository').toString().trim() === 'true') {
    errors.push('Full reachable history is required; fetch with depth 0');
  } else {
    errors.push(...privateCommitEmails(git('log', '--no-show-signature', '--format=%H%x09%ae%x09%ce', 'HEAD').toString()));
  }
  return errors;
}

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const rawRow = /^:[0-7]{6} ([0-7]{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) [A-Z][0-9]*$/;

/** Parse `git diff-tree -r -z` raw output; any unexpected row fails closed. */
export function diffTreeRows(output) {
  const raw = output.split('\0');
  if (raw.pop() !== '' || raw.length % 2) throw new Error('Unparseable diff-tree output');
  const rows = [];
  for (let i = 0; i < raw.length; i += 2) {
    const match = rawRow.exec(raw[i]);
    if (!match || !raw[i + 1]) throw new Error('Unparseable diff-tree output');
    rows.push({ mode: match[1], blob: match[2], file: raw[i + 1] });
  }
  return rows;
}

/**
 * Revision arguments for the commits a push publishes: <local> minus the remote
 * ref's old commit and the pushed remote's tracking refs. Only the named remote
 * counts as public (another remote may hold private history); anything else,
 * such as a URL or an unknown commit, is ignored, so more history is checked.
 */
export function rangeArgs(local, excludes, remotes, hasCommit) {
  if (!oid.test(local ?? '') || /^0+$/.test(local)) throw new Error('Pushed commit must be a full object ID');
  const not = [];
  for (const exclude of excludes) {
    if (oid.test(exclude)) { if (!/^0+$/.test(exclude) && hasCommit(exclude)) not.push(exclude); }
    else if (remotes.includes(exclude)) not.push(`--remotes=${exclude}`);
  }
  return not.length ? [local, '--not', ...not] : [local];
}

/** The pushed range in this repository; the pre-push secret scan reads it via --range-args. */
export function pushedRange(local, excludes) {
  const hasCommit = (hash) => {
    try { git('cat-file', '-e', `${hash}^{commit}`); return true; } catch { return false; }
  };
  const remotes = git('remote').toString().split('\n').filter(Boolean);
  return rangeArgs(local, excludes, remotes, hasCommit);
}

/** Check every file version added or modified, and every commit email, in a pushed range. */
export function checkRange(local, excludes) {
  const range = pushedRange(local, excludes);
  const commits = git('rev-list', ...range).toString().split('\n').filter(Boolean);
  const errors = [];
  const seen = new Set();
  for (const commit of commits) {
    // -m compares merges with each parent, so content introduced by a merge is checked too.
    const output = git('diff-tree', '-r', '-m', '--root', '--no-commit-id', '--no-renames', '--diff-filter=d', '-z', commit);
    for (const { mode, blob, file } of diffTreeRows(output.toString())) {
      if (seen.has(`${mode} ${blob} ${file}`)) continue;
      seen.add(`${mode} ${blob} ${file}`);
      for (const error of fileErrors(file, mode, () => git('cat-file', 'blob', blob))) {
        errors.push(`${commit.slice(0, 12)} ${error}`);
      }
    }
  }
  // log.showSignature would add signature lines that parse as commits.
  errors.push(...privateCommitEmails(git('log', '--no-show-signature', '--format=%H%x09%ae%x09%ce', ...range).toString()));
  return [...new Set(errors)];
}

function main(args) {
  if (args[0] === '--range-args') {
    // One revision argument per line for scripts/secret-scan.sh; remote names cannot contain newlines.
    try {
      process.stdout.write(`${pushedRange(args[1], args.slice(2)).join('\n')}\n`);
    } catch {
      console.error('Could not list the pushed commits; refusing to continue');
      process.exitCode = 1;
    }
    return;
  }
  let errors;
  let scope = 'indexed files and HEAD history';
  if (args[0] === '--range') {
    scope = 'pushed commits';
    try { errors = checkRange(args[1], args.slice(2)); } catch { errors = ['Could not list the pushed commits; refusing to continue']; }
  } else if (args.length) {
    errors = ['Usage: check-privacy.mjs [--range | --range-args <local-oid> [<remote-oid-or-name>...]]'];
  } else {
    errors = checkPrivacy();
  }
  for (const error of errors) console.error(error);
  console.log(`Privacy checks: ${errors.length ? 'FAILED' : 'passed'} (${scope})`);
  process.exitCode = errors.length ? 1 : 0;
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
