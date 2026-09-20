import { git, indexedFiles, isMain, jsonc, readIndexed } from './repo-files.mjs';

export function privatePath(file) {
  const name = file.split('/').at(-1);
  return /(^|\/)(?:\.local|\.wrangler|node_modules)(\/|$)/.test(file) ||
    /^(?:\.env|\.dev\.vars)(?:\..*)?$/.test(name) && !['.env.example', '.dev.vars.example'].includes(name) ||
    /(?:\.local\.(?:sh|jsonc?|md)|\.(?:pem|key|p12|pfx|log)|-secret(?:\.txt)?)$/i.test(name) ||
    /^(?:secrets\.json|poll-secret|poll-endpoint|settings\.local\.json|gitleaks-report\..*)$/.test(name);
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

/** Reject text/EXIF metadata without printing it; preserve rendering color profiles. */
export function imagePrivacy(file, data) {
  if (/\.png$/i.test(file)) {
    if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'invalid PNG';
    for (let offset = 8; offset < data.length;) {
      if (offset + 12 > data.length) return 'invalid PNG chunk';
      const size = data.readUInt32BE(offset);
      const type = data.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + size > data.length) return 'invalid PNG chunk';
      if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) return 'PNG contains metadata';
      offset += 12 + size;
      if (type === 'IEND') return offset === data.length ? null : 'PNG has trailing data';
    }
    return 'incomplete PNG';
  }
  if (/\.jpe?g$/i.test(file)) {
    if (data.length < 2 || data.readUInt16BE(0) !== 0xffd8) return 'invalid JPEG';
    let offset = 2;
    while (offset + 4 <= data.length && data[offset] === 0xff) {
      const type = data[offset + 1];
      if ([0xe1, 0xed, 0xfe].includes(type)) return 'JPEG contains EXIF/XMP/IPTC/comment metadata';
      if (type === 0xda || type === 0xd9) return null;
      const size = data.readUInt16BE(offset + 2);
      if (size < 2 || offset + size + 2 > data.length) return 'invalid JPEG segment';
      offset += size + 2;
    }
    return 'invalid JPEG';
  }
  if (/\.webp$/i.test(file)) {
    if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return 'invalid WebP';
    if (data.length < 12 || data.readUInt32LE(4) + 8 !== data.length) return 'invalid WebP length';
    for (let offset = 12; offset < data.length;) {
      if (offset + 8 > data.length) return 'invalid WebP chunk';
      const type = data.toString('ascii', offset, offset + 4);
      if (['EXIF', 'XMP '].includes(type)) return 'WebP contains metadata';
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
    return [author, committer].every((email) => /^[^\s@]+@users\.noreply\.github\.com$/i.test(email ?? ''))
      ? [] : [`${hash.slice(0, 12)}: commit email must use GitHub noreply`];
  });
}

export function checkPrivacy() {
  const errors = [];
  for (const [file, { mode }] of indexedFiles()) {
    if (privatePath(file)) { errors.push(`${file}: private file is tracked`); continue; }
    if (!['100644', '100755'].includes(mode)) { errors.push(`${file}: symlink or submodule requires review`); continue; }
    const data = readIndexed(file);
    if (/\.png$|\.jpe?g$|\.webp$/i.test(file)) {
      const error = imagePrivacy(file, data);
      if (error) errors.push(`${file}: ${error}`);
    }
    if (/^wrangler.*\.jsonc?$/.test(file)) {
      errors.push(...publicConfig(jsonc(data.toString())).map((error) => `${file}: ${error}`));
    }
  }
  if (git('rev-parse', '--is-shallow-repository').toString().trim() === 'true') {
    errors.push('Full reachable history is required; fetch with depth 0');
  } else {
    errors.push(...privateCommitEmails(git('log', 'HEAD', '--format=%H%x09%ae%x09%ce').toString()));
  }
  return errors;
}

if (isMain(import.meta.url)) {
  const errors = checkPrivacy();
  for (const error of errors) console.error(error);
  console.log(`Privacy checks: ${errors.length ? 'FAILED' : 'passed'} (indexed files and HEAD history)`);
  process.exitCode = errors.length ? 1 : 0;
}
