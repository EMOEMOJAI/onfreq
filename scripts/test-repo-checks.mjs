import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { diffTreeRows, fileErrors, imagePrivacy, privateCommitEmails, privatePath, publicConfig, rangeArgs,
  wranglerConfigErrors } from './check-privacy.mjs';
import { checkExternalLinks, checkLocalLinks, documentLinks } from './check-links.mjs';
import { isolatedEnv, optionalSecretNames, testDeployGuard, validateGitleaksConfig, validateHooks, validateOptionalSecrets,
  validateSetup, validateTestBindings, validateWranglerSecretNames } from './check-setup.mjs';
import { isMain, jsonc } from './repo-files.mjs';
import { CONFIG, lintDocs } from './lint-docs.mjs';

test('rejects private paths independently of gitignore, allowing public templates', () => {
  for (const file of ['.dev.vars', '.env.production', 'nested/.dev.vars.preview', 'wrangler.local.jsonc',
    'wrangler.local.json', 'wrangler.local.toml', 'nested/wrangler.local.yaml', '.npmrc', 'nested/.npmrc',
    'set-secrets.local.sh', '.local/report.txt', '.wrangler/state.db', 'poll-secret', 'poll-endpoint',
    'key.pem', 'private.key', 'trace.log', '.claude/settings.local.json', '.DS_Store', 'assets/.DS_Store',
    'docs/pr-audit-2026-09.md', 'docs/pr-audit-.md', 'config/optional-secrets', 'config/production.env',
    'config/optional-secrets.example.bak', 'config/nested/settings.example', 'config/.example', 'config/other.example',
    '.envrc', 'nested/.envrc', '.envrc.local', '.envrc.d/x', '.envrc/x', '.envrc.example/x']) assert.equal(privatePath(file), true, file);
  for (const file of ['.dev.vars.example', '.env.example', '.envrc.example', 'nested/.envrc.example', 'wrangler.jsonc', 'config/optional-secrets.example',
    'nested/config/settings.json', 'docs/setup.md', 'docs/pr-audit.md',
    'nested/docs/pr-audit-notes.md', 'docs/pr-audit-notes.txt']) {
    assert.equal(privatePath(file), false, file);
  }
});

test('.gitignore ignores the config/ and local-settings paths exactly as privatePath treats them', (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-ignore-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repo, env }).status, 0);
  copyFileSync(new URL('../.gitignore', import.meta.url), join(repo, '.gitignore'));
  for (const [file, ignored] of [['config/.example', true], ['config/optional-secrets.example', false],
    ['config/x.example', true], ['config/a.example/file', true], ['config/optional-secrets.example/file', true],
    ['config/optional-secrets.example.bak', true], ['.envrc', true], ['nested/.envrc', true], ['.envrc.local', true],
    ['.envrc.example', false], ['nested/.envrc.example', false], ['.envrc.d/x', true], ['.envrc/x', true],
    ['.envrc.example/x', true], ['CLAUDE.local.md', true], ['notes.local.md', true], ['nested/x.local.md', true],
    ['settings.local.json', true], ['.claude/settings.local.json', true], ['nested/settings.local.json', true],
    ['x.local.json', true], ['x.local.jsonc', true], ['nested/x.local.jsonc', true],
    ['x.local.json.bak', false], ['local.json', false], ['x.local.txt', false]]) {
    const status = spawnSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: repo, env }).status;
    assert.equal(status, ignored ? 0 : 1, file);
    assert.equal(privatePath(file), ignored, file);
  }
});

test('checks every tracked Wrangler config, including nested and JSON files, and refuses TOML', () => {
  const safe = Buffer.from(JSON.stringify({ kv_namespaces: [{ id: '0'.repeat(32) }] }));
  const leaked = Buffer.from('{ "account_id": "synthetic-private-value" }');
  for (const file of ['wrangler.jsonc', 'wrangler.json', 'wrangler.staging.jsonc', 'nested/wrangler.jsonc']) {
    assert.deepEqual(wranglerConfigErrors(file, safe), [], file);
    const errors = wranglerConfigErrors(file, leaked);
    assert.ok(errors.length > 0 && errors.every((error) => error.startsWith(`${file}: `)), file);
    assert.doesNotMatch(errors.join(' '), /synthetic-private-value/);
  }
  for (const file of ['wrangler.toml', 'nested/wrangler.production.toml']) {
    assert.match(wranglerConfigErrors(file, Buffer.from('name = "synthetic"'))[0], /TOML configuration is not allowed/);
  }
  assert.match(wranglerConfigErrors('wrangler.json', Buffer.from('{ synthetic-private-value'))[0], /invalid/);
  assert.doesNotMatch(wranglerConfigErrors('wrangler.json', Buffer.from('{ synthetic-private-value'))[0], /synthetic/);
  assert.deepEqual(wranglerConfigErrors('docs/not-wrangler.json', leaked), []);
});

test('JSON configuration refuses __proto__ keys at any depth, so tracked Wrangler configs fail closed', (t) => {
  for (const text of ['{ "__proto__": { "account_id": "synthetic-private-value" } }',
    '{ "kv_namespaces": [{ "binding": "ATC_STATE", "__proto__": { "id": "synthetic-private-value" } }] }',
    '{ "\\u005f_proto__": { "routes": [] }, }']) {
    assert.throws(() => jsonc(text), /__proto__ keys are not allowed/, text);
    const errors = wranglerConfigErrors('wrangler.jsonc', Buffer.from(text));
    assert.deepEqual(errors, ['wrangler.jsonc: invalid Wrangler configuration'], text);
    assert.deepEqual(fileErrors('nested/wrangler.json', '100644', () => Buffer.from(text)),
      ['nested/wrangler.json: invalid Wrangler configuration'], text);
  }
  assert.deepEqual(jsonc('{ "proto": { "__proto": 1 }, }'), { proto: { __proto: 1 } });

  // End to end: a tracked wrangler.jsonc whose prototype hides an operator ID fails the privacy check.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-proto-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'scripts'));
  for (const name of ['check-privacy.mjs', 'repo-files.mjs']) copyFileSync(new URL(`./${name}`, import.meta.url), join(repo, 'scripts', name));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(repo, 'node_modules'));
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repo, 'wrangler.jsonc'), '{ "__proto__": { "account_id": "synthetic-private-value" } }\n');
  const env = isolatedEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const git = (...args) => assert.equal(spawnSync('git', ['-c', 'user.name=Synthetic',
    '-c', 'user.email=synthetic@users.noreply.github.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    ...args], { cwd: repo, env }).status, 0, `git ${args[0]} failed`);
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '--no-verify', '-m', 'synthetic');
  const result = spawnSync(process.execPath, ['scripts/check-privacy.mjs'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^wrangler\.jsonc: invalid Wrangler configuration$/m);
  assert.doesNotMatch(result.stderr + result.stdout, /synthetic-private-value/);
  writeFileSync(join(repo, 'wrangler.jsonc'), '{ "kv_namespaces": [] }\n');
  git('commit', '--quiet', '--no-verify', '-am', 'clean');
  assert.equal(spawnSync(process.execPath, ['scripts/check-privacy.mjs'], { cwd: repo, env }).status, 0);
});

test('requires versioned hooks tracked as executable under scripts/hooks', () => {
  const hooks = new Map([['scripts/hooks/pre-commit', { mode: '100755' }], ['scripts/hooks/pre-push', { mode: '100755' }]]);
  validateHooks(hooks);
  assert.throws(() => validateHooks(new Map([...hooks, ['scripts/hooks/pre-push', { mode: '100644' }]])));
  assert.throws(() => validateHooks(new Map([['scripts/pre-commit', { mode: '100755' }]])));
});

test('rejects operator IDs and variables without revealing their values', () => {
  const safe = { kv_namespaces: [{ id: '0'.repeat(32) }], vars: { OFFLINE_GRACE_POLLS: '2' } };
  assert.deepEqual(publicConfig(safe), []);
  const failures = publicConfig({ ...safe, account_id: 'synthetic-private-value',
    vars: { DISCORD_CHANNEL_IDS: 'synthetic-private-value' }, env: { production: {} } });
  assert.ok(failures.length >= 3);
  assert.doesNotMatch(failures.join(' '), /synthetic-private-value/);
});

test('pushed ranges exclude only known commits and the pushed remote; others check more history', () => {
  const [local, known, unknown, zero] = ['a', 'b', 'c', '0'].map((c) => c.repeat(40));
  const hasCommit = (hash) => hash === known;
  assert.deepEqual(rangeArgs(local, [known, 'origin'], ['origin', 'private-history'], hasCommit),
    [local, '--not', known, '--remotes=origin']);
  assert.deepEqual(rangeArgs(local, [zero, unknown, 'https://example.test/x.git', '', '--all'], ['origin'], hasCommit), [local]);
  for (const bad of [zero, 'HEAD', '--all', undefined]) assert.throws(() => rangeArgs(bad, [], [], hasCommit));
});

test('range mode parses diff-tree rows and fails closed on unparseable output (S19-27)', () => {
  const [a, b] = ['a', 'b'].map((c) => c.repeat(40));
  const row = `:100644 100755 ${a} ${b} M\0nested/file name.txt\0`;
  assert.deepEqual(diffTreeRows(''), []);
  assert.deepEqual(diffTreeRows(row + `:000000 120000 ${'0'.repeat(40)} ${a} A\0link\0`), [
    { mode: '100755', blob: b, file: 'nested/file name.txt' },
    { mode: '120000', blob: a, file: 'link' },
  ]);
  for (const bad of [row.slice(0, -1), `${row}extra`, `${row}${row.split('\0')[0]}\0`, `${a}\0${row}`,
    `:100644 100644 ${a} ${b}\0file\0`, `:100644 100644 ${a} short M\0file\0`, `:100644 100644 ${a} ${b} M\0\0`]) {
    assert.throws(() => diffTreeRows(bad), /Unparseable/, JSON.stringify(bad));
  }
});

test('checks commit trailer emails, allowing only noreply identities, and redacts them (T1-5)', () => {
  const row = (trailers) => ['c'.repeat(40), '1+example@users.noreply.github.com', 'noreply@github.com', trailers].join('\t');
  const allowed = ['Co-Authored-By: Synthetic Model <noreply@anthropic.com>',
    'Co-authored-by: Example <2+example@users.noreply.github.com>', 'Signed-off-by: GitHub <noreply@github.com>'];
  assert.deepEqual(privateCommitEmails([row(''), row(allowed.join('\x1f')), ''].join('\0')), []);
  for (const trailer of ['Co-authored-by: Person <person@example.test>', 'Signed-off-by: person@example.test',
    'Reviewed-by: Person <person@example.test>, Model <noreply@anthropic.com>',
    // The Anthropic identity is allowed only in trailers, never as author or committer.
    'Co-authored-by: Person <noreply@anthropic.com.example.test>']) {
    const failures = privateCommitEmails([row(allowed[0]), row(`${allowed[1]}\x1f${trailer}`)].join('\0'));
    assert.deepEqual(failures, [`${'c'.repeat(12)}: commit trailer email must use a noreply address`], trailer);
  }
  // URL handle paths are not addresses; an address anywhere else in a URL still is.
  for (const trailer of ['Reviewed-on: https://social.example/@person', 'Link: https://example.test/a/@b/c',
    'Reviewed-on: HTTPS://Social.example/@Person']) {
    assert.deepEqual(privateCommitEmails(row(`${allowed[0]}\x1f${trailer}`)), [], trailer);
  }
  for (const trailer of ['Link: https://a.test/x;person@private.example',
    'Co-authored-by: X <https://a.test/>,<person@private.example>', 'Link: https://tracker.test/u/person@private.example',
    'Link: https://a.test/@person@private.example', 'Link: https://person@example.test/x', 'Co-authored-by: X <person@localhost>',
    'Co-authored-by: noreply@github.com@person.example', 'Signed-off-by: person@example.test.',
    // `/@` is ignored only inside a scheme:// URL.
    'Signed-off-by: person/@private.example', 'Co-authored-by: X <person/@private.example>',
    'Link: mailto:person@private.example', 'Link: person@private.example://x',
    'Link: https://a.test/x person/@private.example', 'Link: https:/@private.example',
    'Reviewed-on: https://social.example/@person\x1fSigned-off-by: person/@private.example']) {
    const failures = privateCommitEmails(row(trailer));
    assert.deepEqual(failures, [`${'c'.repeat(12)}: commit trailer email must use a noreply address`], trailer);
    assert.doesNotMatch(failures.join(' '), /person|private\.example|example\.test|localhost/, trailer);
  }
  assert.equal(privateCommitEmails(['d'.repeat(40), 'noreply@anthropic.com', 'noreply@anthropic.com', ''].join('\t')).length, 1);
  // Author and trailer failures are reported separately.
  assert.equal(privateCommitEmails(['e'.repeat(40), 'person@example.test', 'noreply@github.com',
    'Co-authored-by: Person <person@example.test>'].join('\t')).length, 2);
});

test('checks both raw commit emails and redacts rejected identities', () => {
  const safe = 'a'.repeat(40) + '\t123+example@users.noreply.github.com\texample@users.noreply.github.com';
  assert.deepEqual(privateCommitEmails(safe), []);
  assert.deepEqual(privateCommitEmails('b'.repeat(40) + '\t123+example@users.noreply.github.com\tnoreply@github.com'), []);
  for (const value of [safe.replace('123+example@users.noreply.github.com', 'person@example.test'),
    safe.replace('\texample@users.noreply.github.com', '\tperson@example.test')]) {
    const failures = privateCommitEmails(value);
    assert.equal(failures.length, 1);
    assert.doesNotMatch(failures[0], /person|example\.test/);
  }
});

test('checks every address in the commit message, allowing only noreply identities, and redacts them (NX-2a)', () => {
  // The flagged addresses are assembled at runtime; noreply identities are written out.
  const at = (local, domain) => [local, domain].join('@');
  const person = at('person', 'example.invalid');
  const hash = 'c'.repeat(40);
  const row = (message, trailers = '', author = '1+example@users.noreply.github.com') =>
    `${[hash, author, 'noreply@github.com', trailers].join('\t')}\x1e${message}`;
  const messageError = `${'c'.repeat(12)}: commit message email must use a noreply address`;
  const trailerError = `${'c'.repeat(12)}: commit trailer email must use a noreply address`;
  const authorError = `${'c'.repeat(12)}: commit email must use GitHub noreply`;
  const redacted = (failures, label) => assert.doesNotMatch(failures.join(' '), /person|example\.invalid|private/, label);
  // 1. An address in the body, outside any trailer, is flagged.
  let failures = privateCommitEmails(row(`synthetic subject\n\nContact ${person} for access\n`));
  assert.deepEqual(failures, [messageError]);
  redacted(failures);
  // 2. Subject lines, other address shapes and addresses inside URLs are flagged too.
  for (const message of [`${person} subject`, `subject\n\n${person.toUpperCase()}`, `subject\n\n<${person}>.`,
    `subject\n\n${at('noreply', 'anthropic.com.example.invalid')}`, `subject\n\n${at('x.noreply', 'anthropic.com')}`,
    `subject\n\nmailto:${person}`, `subject\n\nhttps://a.example/u/${person}`, `subject\n\nhttps://a.example/@${person}`,
    `subject\n\n${at('first.last+tag', 'mail.private.example.org')}`]) {
    failures = privateCommitEmails(row(message));
    assert.deepEqual(failures, [messageError], message);
    redacted(failures, message);
  }
  // URL handle paths, person/@domain text, versions and noreply identities are not flagged.
  for (const message of ['subject\n\nSee https://x.example/@person', 'subject\n\nperson/@domain and `/@`',
    'subject\n\nBump pkg@1.2.3 and actions/checkout@v4.2.2', 'Thanks noreply@anthropic.com',
    'subject\n\nCo-authored-by: Example <123+name@users.noreply.github.com>',
    'subject\n\nCo-Authored-By: Synthetic Model <noreply@anthropic.com>\nMerged-by: noreply@github.com\n', '']) {
    assert.deepEqual(privateCommitEmails(row(message)), [], message);
  }
  // A private trailer is part of the message, so it is reported by both checks.
  const trailer = `Co-authored-by: Person <${person}>`;
  failures = privateCommitEmails(row(`subject\n\n${trailer}\n`, trailer));
  assert.deepEqual(failures, [trailerError, messageError]);
  redacted(failures);
  // 3. Tabs, \x1f and \x1e in the message do not break parsing; author and trailer checks still apply.
  const odd = `subject\t\x1f\x1e\n\nbody\twith\x1fseparators\x1e and more\n`;
  assert.deepEqual(privateCommitEmails(row(odd)), []);
  assert.deepEqual(privateCommitEmails([row(odd), row(`${odd}${person}`)].join('\0')), [messageError]);
  assert.deepEqual(privateCommitEmails(row(odd, '', at('person', 'users.noreply.github.com.example.invalid'))), [authorError]);
  assert.deepEqual(privateCommitEmails(row(odd, trailer)), [trailerError]);
  // A trailer value holding \x1e: the trailer check covers the part before it, the message check the rest.
  assert.deepEqual(privateCommitEmails(row('subject', `Link: x\x1e${person}`)), [messageError]);
  assert.deepEqual(privateCommitEmails(row('subject', `Signed-off-by: ${person}\x1ex`)), [trailerError]);
  // Rows without a commit hash fail closed without echoing the log text.
  for (const bad of [`${person}\tx\ty`, `${'c'.repeat(39)}\t${person}`, `${'C'.repeat(40)}\tx`, `${'c'.repeat(41)}\x1e${person}`]) {
    failures = privateCommitEmails(bad);
    assert.deepEqual(failures, ['commit log could not be parsed'], JSON.stringify(bad));
    redacted(failures);
  }
  assert.deepEqual(privateCommitEmails(row('subject').replace(hash, 'd'.repeat(64))), []);
});

test('address checks start only at a token, so a long token is checked in linear time (RA)', () => {
  const at = (local, domain) => [local, domain].join('@');
  const hash = 'c'.repeat(40);
  const row = (message, trailers = '') => `${[hash, '1+example@users.noreply.github.com', 'noreply@github.com', trailers].join('\t')}\x1e${message}`;
  for (const token of ['a'.repeat(200000), 'a.'.repeat(100000), '1-'.repeat(100000), 'h'.repeat(199997) + '://x',
    `${'a'.repeat(199990)}@x`, `@${'a.'.repeat(99999)}`, 'a/'.repeat(100000)]) {
    for (const [message, trailers] of [[token, ''], ['subject', `Link: ${token}`]]) {
      const start = performance.now();
      privateCommitEmails(row(message, trailers));
      assert.ok(performance.now() - start < 1000, `${token.slice(0, 8)}: ${performance.now() - start} ms`);
    }
  }
  // Every address is still found, including one right after another or after a URL handle.
  const person = at('person', 'private.example');
  const messageError = `${'c'.repeat(12)}: commit message email must use a noreply address`;
  const trailerError = `${'c'.repeat(12)}: commit trailer email must use a noreply address`;
  for (const message of [`${at('noreply', 'github.com')}-${person}`, `${at('noreply', 'github.com')}.${person}`,
    `x${person}`, `pkg@1.2.3${person}`, `see ${'a'.repeat(5000)}${person}`]) {
    assert.deepEqual(privateCommitEmails(row(message)), [messageError], message);
  }
  for (const trailer of [`Link: 1https://a.example/x@${person}`, `Link: -https://a.example/${person}`]) {
    assert.deepEqual(privateCommitEmails(row('subject', trailer)), [trailerError], trailer);
  }
  // A URL handle path after a non-letter prefix is still not an address.
  for (const trailer of ['Reviewed-on: 1https://social.example/@person', 'Reviewed-on: -https://social.example/@person']) {
    assert.deepEqual(privateCommitEmails(row('subject', trailer)), [], trailer);
  }
});

function pngChunk(type, payload = Buffer.alloc(0)) {
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length); chunk.write(type, 4); payload.copy(chunk, 8);
  return chunk;
}
test('rejects PNG text/EXIF and JPEG/WebP metadata without exposing it', () => {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  assert.equal(imagePrivacy('image.png', Buffer.concat([signature, pngChunk('IEND')])), null);
  for (const kind of ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']) {
    const result = imagePrivacy('image.png', Buffer.concat([signature, pngChunk(kind, Buffer.from('private-fixture')), pngChunk('IEND')]));
    assert.match(result, /metadata/); assert.doesNotMatch(result, /private-fixture/);
  }
  assert.match(imagePrivacy('image.png', Buffer.concat([signature, pngChunk('IEND'), Buffer.from('extra')])), /trailing/);
  assert.match(imagePrivacy('image.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 2])), /metadata/);
  assert.match(imagePrivacy('image.jpg', Buffer.alloc(0)), /invalid/);
  const webp = Buffer.alloc(20);
  webp.write('RIFF'); webp.writeUInt32LE(12, 4); webp.write('WEBPEXIF', 8);
  assert.match(imagePrivacy('image.webp', webp), /metadata/);
});

// A generated one-pixel black JPEG, containing no external image or member data.
const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJUAB//Z', 'base64');
function jpegSegment(type, payload = Buffer.alloc(0)) {
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff; segment[1] = type;
  segment.writeUInt16BE(payload.length + 2, 2); payload.copy(segment, 4);
  return segment;
}

test('checks JPEG metadata before and after scan data, including between later scans', () => {
  assert.equal(imagePrivacy('fixture.jpg', jpeg), null);
  for (const type of [0xe1, 0xed, 0xfe]) {
    const metadata = jpegSegment(type, Buffer.from('Synthetic private author: person@example.test'));
    for (const offset of [2, jpeg.length - 2]) {
      const image = Buffer.concat([jpeg.subarray(0, offset), metadata, jpeg.subarray(offset)]);
      const result = imagePrivacy('fixture.jpg', image);
      assert.match(result, /metadata/);
      assert.doesNotMatch(result, /person|example\.test/);
    }
  }
  // Marker-level progressive framing: scans are separated by table segments.
  const scan = jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
  const between = [jpeg.subarray(0, -2), jpegSegment(0xc4), scan, Buffer.from([1, 2, 3])];
  assert.equal(imagePrivacy('fixture.jpg', Buffer.concat([...between, Buffer.from([0xff, 0xd9])])), null);
  assert.match(imagePrivacy('fixture.jpg', Buffer.concat([...between, jpegSegment(0xfe), Buffer.from([0xff, 0xd9])])), /metadata/);
});

test('walks stuffed bytes, restart/fill markers and in-scan DNL without hiding later metadata', () => {
  const entropy = Buffer.from([1, 0xff, 0, 2, 0xff, 0xd0, 3, 0xff, 0xff, 0xd7, 4]);
  const parts = [jpeg.subarray(0, -2), entropy, jpegSegment(0xdc, Buffer.from([0, 1])), Buffer.from([5])];
  assert.equal(imagePrivacy('fixture.jpg', Buffer.concat([...parts, Buffer.from([0xff, 0xd9])])), null);
  assert.match(imagePrivacy('fixture.jpg', Buffer.concat([...parts, jpegSegment(0xe1), Buffer.from([0xff, 0xd9])])), /metadata/);
});

test('fails closed on truncated JPEGs, malformed segments and trailing payloads', () => {
  for (const image of [jpeg.subarray(0, -2), jpeg.subarray(0, -1),
    Buffer.concat([jpeg, Buffer.from('extra')]),
    Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 1]),
    Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 20, 1]),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    Buffer.from([0xff, 0xd8, 0xff, 0xd0]),
    Buffer.from([0xff, 0xd8, 0xff, 0x00])]) {
    assert.ok(imagePrivacy('fixture.jpg', image));
  }
});

test('rejects C2PA provenance, SVG editor metadata and unreviewed image formats (S20-6)', () => {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const png = imagePrivacy('image.png', Buffer.concat([signature, pngChunk('caBX', Buffer.from('private-fixture')), pngChunk('IEND')]));
  assert.match(png, /metadata/); assert.doesNotMatch(png, /private-fixture/);
  const jpg = imagePrivacy('image.jpg', Buffer.concat([jpeg.subarray(0, 2),
    jpegSegment(0xeb, Buffer.from('JP synthetic c2pa manifest')), jpeg.subarray(2)]));
  assert.match(jpg, /C2PA/); assert.doesNotMatch(jpg, /manifest/);
  const payload = Buffer.from('private-fixture!');
  const webp = Buffer.alloc(20 + payload.length);
  webp.write('RIFF'); webp.writeUInt32LE(webp.length - 8, 4); webp.write('WEBPC2PA', 8);
  webp.writeUInt32LE(payload.length, 16); payload.copy(webp, 20);
  assert.match(imagePrivacy('image.webp', webp), /metadata/);
  webp.write('VP8X', 12);
  assert.equal(imagePrivacy('image.webp', webp), null);

  const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
  assert.equal(imagePrivacy('image.svg', svg('<title>Synthetic</title><path d="M0 0h1"/>')), null);
  for (const body of ['<metadata><rdf:RDF/></metadata>', '<g inkscape:label="layer"/>', '<sodipodi:namedview/>',
    '<image href="/Users/person/private.png"/>', '<image href="file:///home/person/private.png"/>']) {
    const result = imagePrivacy('Image.SVG', svg(body));
    assert.match(result, /SVG contains/, body); assert.doesNotMatch(result, /person|private/);
  }
  for (const file of ['image.gif', 'image.avif', 'image.heic', 'image.heif', 'image.tif', 'image.TIFF', 'image.bmp']) {
    assert.deepEqual(fileErrors(file, '100644', () => Buffer.alloc(0)), [`${file}: image format requires review`]);
  }
  assert.deepEqual(fileErrors('docs/notes.txt', '100644', () => Buffer.from('/Users/synthetic')), []);
});

test('reads file contents only for images and Wrangler configs (C46)', () => {
  const unread = () => { throw new Error('read an uninspected blob'); };
  for (const file of ['src/index.ts', 'docs/setup.md', 'large.bin', 'notwrangler.jsonc']) {
    assert.deepEqual(fileErrors(file, '100644', unread), [], file);
  }
  assert.deepEqual(fileErrors('.dev.vars', '100644', unread), ['.dev.vars: private file is tracked']);
  assert.deepEqual(fileErrors('link', '120000', unread), ['link: symlink or submodule requires review']);
  let reads = 0;
  const read = (data) => () => { reads++; return Buffer.from(data); };
  assert.deepEqual(fileErrors('nested/wrangler.jsonc', '100644', read('{ "routes": [] }')),
    ['nested/wrangler.jsonc: operator deployment setting']);
  assert.deepEqual(fileErrors('icon.svg', '100644', read('<svg><metadata/></svg>')),
    ['icon.svg: SVG contains editor metadata or a local path']);
  assert.equal(reads, 2);
});

test('validates guided setup and rejects changed prompts, values and deployment identities', () => {
  const config = jsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const example = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
  validateSetup(config, pkg, example);
  assert.throws(() => validateSetup(config, pkg, example + '\nEXTRA_SECRET=""'));
  assert.throws(() => validateSetup(config, pkg, example.replace('POLL_SECRET=""', 'POLL_SECRET="synthetic"')));
  assert.throws(() => validateSetup({ ...config, kv_namespaces: [{ binding: 'ATC_STATE', id: '1'.repeat(32) }] }, pkg, example));
  assert.throws(() => validateSetup(config, { ...pkg, cloudflare: { bindings: {} } }, example));
  // Relying on predeploy alone is bypassed by npm --ignore-scripts.
  assert.throws(() => validateSetup(config, { ...pkg, scripts: { ...pkg.scripts, deploy: 'wrangler deploy' } }, example));
});

test('optional setting examples are empty and name exactly the optional secrets (T1-5)', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const example = read('../config/optional-secrets.example');
  const envTypes = read('../src/env.d.ts');
  assert.ok(optionalSecretNames(envTypes).includes('POLL_SECRET'));
  validateOptionalSecrets(example, envTypes);
  for (const changed of [
    example.replace('HISTORY_SECRET=""', 'HISTORY_SECRET="synthetic-value"'),
    example.replace('GCA_REGIONS=""', "GCA_REGIONS='{}'"),
    example.replace('GCA_DM_ENABLED="false"', 'GCA_DM_ENABLED="true"'),
    example.replace('COORDINATOR_NAME=""', 'COORDINATOR_NAME=synthetic'),
    example.replace('MENTION_ROLE_ID=""\n', ''),
    `${example}\nEXTRA_SETTING=""\n`,
    `${example}\nPOLL_SECRET=""\n`,
    `${example}\nFIR_LABELS=""\n`,
  ]) assert.throws(() => validateOptionalSecrets(changed, envTypes));
  assert.throws(() => validateOptionalSecrets(example, envTypes.replace('  COORDINATOR_NAME?: string;\n', '')));
  assert.throws(() => optionalSecretNames(envTypes.replace('  GCA_REGIONS?: string;', '  GCA_REGIONS: string;')));
  assert.throws(() => optionalSecretNames('type Env = {};'));
});

test('vitest bindings cover every optional and first-run setting (T2-4)', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const vitest = read('../vitest.config.ts');
  const envTypes = read('../src/env.d.ts');
  validateTestBindings(vitest, envTypes);
  for (const name of ['GCA_VERIFIED_ROLE_ID', 'MENTION_COOLDOWN_MINUTES', 'IVAO_WEBHOOK_SECRET', 'FIR_PREFIXES']) {
    const removed = vitest.replace(new RegExp(`^ {8}${name}: .*\n`, 'm'), '');
    assert.notEqual(removed, vitest, name);
    assert.throws(() => validateTestBindings(removed, envTypes), new RegExp(`Missing test binding: ${name}`));
  }
  assert.throws(() => validateTestBindings(vitest, envTypes.replace('  COORDINATOR_NAME?: string;',
    '  COORDINATOR_NAME?: string;\n  SYNTHETIC_SETTING?: string;')), /SYNTHETIC_SETTING/);
  assert.throws(() => validateTestBindings('export default {};', envTypes), /Missing vitest miniflare bindings/);
});

test('public deploy permits a fresh template and blocks private configuration, even with ignore-scripts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  testDeployGuard(readFileSync(new URL('./check-deploy.mjs', import.meta.url)), pkg.scripts.deploy);
  // Regression: the former predeploy-only script reached deployment under ignore-scripts.
  assert.throws(() => testDeployGuard(readFileSync(new URL('./check-deploy.mjs', import.meta.url)),
    'wrangler deploy --config wrangler.jsonc'), /Private installation must refuse public deployment/);
  // Regression (S19-13): without --config, Wrangler may prefer wrangler.json/toml or a redirect.
  assert.throws(() => testDeployGuard(readFileSync(new URL('./check-deploy.mjs', import.meta.url)),
    'node scripts/check-deploy.mjs && wrangler deploy'), /pin --config wrangler\.jsonc/);
  assert.throws(() => validateSetup(
    jsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')),
    { ...pkg, scripts: { ...pkg.scripts, deploy: 'node scripts/check-deploy.mjs && wrangler deploy' } },
    readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8')));
});

test('public deploy guard also sees private config in the main checkout of a Git worktree', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-worktree-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = join(base, 'main');
  const linked = join(base, 'linked');
  const env = isolatedEnv();
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args[0]} failed`);
  };
  mkdirSync(join(main, 'scripts'), { recursive: true });
  copyFileSync(new URL('./check-deploy.mjs', import.meta.url), join(main, 'scripts/check-deploy.mjs'));
  git(main, 'init', '--quiet');
  git(main, 'add', 'scripts/check-deploy.mjs');
  git(main, 'commit', '--quiet', '--no-verify', '-m', 'synthetic');
  git(main, 'worktree', 'add', '--quiet', '--detach', linked);
  const guard = (cwd) => spawnSync(process.execPath, ['scripts/check-deploy.mjs'], { cwd, env, encoding: 'utf8' });
  assert.equal(guard(linked).status, 0);
  for (const name of ['wrangler.local.jsonc', 'wrangler.local.json', 'wrangler.local.toml']) {
    writeFileSync(join(main, name), '{}');
    for (const cwd of [main, linked]) {
      const result = guard(cwd);
      assert.equal(result.status, 1, `${name} from ${cwd === main ? 'main' : 'linked'}`);
      assert.match(result.stderr, /Private deployment config detected/);
    }
    rmSync(join(main, name));
  }
  // Removing the private config allows the public deployment again.
  assert.equal(guard(linked).status, 0);
  // T2-4: any wrangler.local.* entry in this checkout or the main worktree is private config.
  for (const name of ['wrangler.local.yaml', 'wrangler.local.jsonc.bak', 'wrangler.local.d']) {
    for (const dir of [main, linked]) {
      if (name.endsWith('.d')) mkdirSync(join(dir, name)); else writeFileSync(join(dir, name), '{}');
      for (const cwd of dir === main ? [main, linked] : [linked]) {
        const result = guard(cwd);
        assert.equal(result.status, 1, `${name} in ${dir === main ? 'main' : 'linked'} from ${cwd === main ? 'main' : 'linked'}`);
        assert.match(result.stderr, /Private deployment config detected/);
      }
      rmSync(join(dir, name), { recursive: true });
    }
  }
  // T2-4: a linked worktree whose main worktree Git cannot report fails closed.
  const withoutGit = (cwd) => spawnSync(process.execPath, ['scripts/check-deploy.mjs'],
    { cwd, env: { ...env, PATH: join(base, 'no-tools') }, encoding: 'utf8' });
  const blind = withoutGit(linked);
  assert.equal(blind.status, 1);
  assert.match(blind.stderr, /Could not find the main Git worktree/);
  assert.equal(withoutGit(main).status, 0, 'a main checkout is checked directly');
  const detached = join(base, 'detached');
  mkdirSync(join(detached, 'scripts'), { recursive: true });
  copyFileSync(new URL('./check-deploy.mjs', import.meta.url), join(detached, 'scripts/check-deploy.mjs'));
  writeFileSync(join(detached, '.git'), `gitdir: ${join(base, 'missing-git-dir')}\n`);
  const missing = guard(detached);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not find the main Git worktree/);

  // Inherited GIT_* variables must not redirect the lookup to another repository.
  writeFileSync(join(main, 'wrangler.local.jsonc'), '{}');
  const other = join(base, 'other');
  mkdirSync(other);
  git(other, 'init', '--quiet');
  for (const redirect of [{ GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other }, { GIT_COMMON_DIR: join(other, '.git') }]) {
    const redirected = spawnSync(process.execPath, ['scripts/check-deploy.mjs'],
      { cwd: linked, env: { ...env, ...redirect }, encoding: 'utf8' });
    assert.equal(redirected.status, 1, Object.keys(redirect).join());
    assert.match(redirected.stderr, /Private deployment config detected/);
  }
  rmSync(join(main, 'wrangler.local.jsonc'));
});

test('public deploy guard honours GIT_CEILING_DIRECTORIES around an enclosing private checkout (S19-26)', (t) => {
  // A fresh public template (not a repository) inside a private checkout: with a
  // ceiling at the private checkout, Git must not discover it; the test isolation
  // and fixtures under a TMPDIR inside a private checkout rely on this.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-ceiling-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const outer = join(base, 'private');
  const inner = join(outer, 'public');
  mkdirSync(join(inner, 'scripts'), { recursive: true });
  copyFileSync(new URL('./check-deploy.mjs', import.meta.url), join(inner, 'scripts/check-deploy.mjs'));
  const env = isolatedEnv();
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: outer, env }).status, 0);
  writeFileSync(join(outer, 'wrangler.local.jsonc'), '{}');
  const guard = (ceiling) => spawnSync(process.execPath, ['scripts/check-deploy.mjs'],
    { cwd: inner, env: { ...env, GIT_CEILING_DIRECTORIES: ceiling }, encoding: 'utf8' });
  assert.equal(guard(outer).status, 0, 'the ceiling hides the enclosing checkout');
  const discovered = guard(base);
  assert.equal(discovered.status, 1, 'without that ceiling the enclosing checkout is still checked');
  assert.match(discovered.stderr, /Private deployment config detected/);
});

test('parses Markdown references, nested badge images, HTML and duplicate heading anchors', () => {
  const doc = documentLinks('# Hello, `world`!\n\n# Hello, world!\n\n[![badge](badge.png)](guide.md)\n\n[setup][ref]\n\n[ref]: guide.md#setup\n\n<a id="custom" href="other.md?a=1&amp;b=2"><img src="image.png"></a>\n\n```md\n[ignored](missing.md)\n```');
  assert.deepEqual(doc.links, ['guide.md', 'badge.png', 'guide.md#setup', 'other.md?a=1&b=2', 'image.png']);
  assert.ok(doc.anchors.has('hello-world'));
  assert.ok(doc.anchors.has('hello-world-1'));
  assert.ok(doc.anchors.has('custom'));
});

test('resolves local and own-repository links against tracked files, including llms.txt', () => {
  const files = new Map([
    ['README.md', '# Start\n\n[Guide](docs/guide.md#setup) ![Icon](assets/icon.png)'],
    ['docs/guide.md', '# Setup\n\n[Home](../README.md#start)'],
    ['assets/icon.png', ''],
    ['llms.txt', '[Guide](https://raw.githubusercontent.com/example/project/main/docs/guide.md#setup)\n[Source](https://github.com/example/project/tree/main/src)'],
    ['src/index.ts', ''],
  ]);
  assert.deepEqual(checkLocalLinks(files, 'example/project').errors, []);
  files.set('README.md', '# Start\n\n[Missing](missing.md) [Wrong anchor](docs/guide.md#missing) [Outside](../private.md) [Ignored local](.dev.vars)');
  assert.equal(checkLocalLinks(files, 'example/project').errors.length, 4);
  files.delete('docs/guide.md');
  assert.ok(checkLocalLinks(files, 'example/project').errors.some((error) => error.startsWith('llms.txt:')));
});

test('external checks retry transient errors, fall back to GET and distinguish unverified links', async () => {
  const calls = [];
  const replies = [503, 200, 405, 200, 404, 403, 429, 429, 429];
  const fake = async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: replies.shift() });
  };
  const result = await checkExternalLinks(new Map(['retry', 'get', 'gone', 'blocked', 'limited']
    .map((name) => [`https://example.test/${name}`, name])), fake, async () => {});
  assert.deepEqual(result.errors, ['gone: HTTP 404']);
  assert.equal(result.warnings.length, 2);
  assert.equal(calls[3].options.method, 'GET');
  assert.ok(calls.every(({ options }) => !options.headers));
  assert.equal(replies.length, 0);
});

test('docs lint expands only supported globs, applies the config and refuses unsafe paths', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-lint-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-lint-outside-')));
  t.after(() => [base, outside].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const root = join(base, 'repo');
  mkdirSync(join(root, 'docs/nested'), { recursive: true });
  const config = (value) => writeFileSync(join(root, 'config.jsonc'), JSON.stringify(value));
  const lintWith = (argv) => lintDocs(argv, { root, cwd: root });
  writeFileSync(join(root, CONFIG), JSON.stringify({ globs: ['*.md', 'docs/*.md', 'llms.txt'], config: { MD013: false } }));
  for (const file of ['README.md', '.hidden.md', 'docs/setup.md', 'docs/nested/deep.md', 'llms.txt', 'notes.txt']) {
    writeFileSync(join(root, file), `# Title\n\n${'long '.repeat(30).trim()}\n`);
  }
  assert.deepEqual(await lintWith([]), { files: ['.hidden.md', 'README.md', 'docs/setup.md', 'llms.txt'], violations: [] });
  writeFileSync(join(root, 'bad.md'), '# Title\n\n### Jump\n');
  assert.deepEqual((await lintWith(['bad.md'])).violations,
    ['bad.md:3 error MD001/heading-increment Heading levels should only increment by one level at a time [Expected: h2; Actual: h3]']);
  writeFileSync(join(root, 'config.jsonc'), '{ "globs": ["*.md", }');
  await assert.rejects(lintWith(['--config', 'config.jsonc']), /config\.jsonc: Invalid JSON configuration/);
  config({ globs: ['*.md'], ignores: [] });
  await assert.rejects(lintWith(['--config', 'config.jsonc']), /unsupported top-level keys: ignores/);
  config({ globs: ['*.md', 'missing/*.md'] });
  await assert.rejects(lintWith(['--config', 'config.jsonc']), /Glob matched no files: missing\/\*\.md/);
  config({ globs: ['absent.md'] });
  await assert.rejects(lintWith(['--config', 'config.jsonc']), /Glob matched no files: absent\.md/);
  for (const glob of ['**/*.md', '{a,b}.md', '?.md', '[ab].md', '!README.md', 'docs/*', '../*.md', 'docs/../x.md', '/etc/x.md']) {
    config({ globs: [glob] });
    await assert.rejects(lintWith(['--config', 'config.jsonc']), /Unsupported glob/, glob);
  }
  writeFileSync(join(outside, 'escape.md'), '# Outside\n');
  symlinkSync('README.md', join(root, 'link.md'));
  await assert.rejects(lintWith([]), /link\.md: symlink; refusing/);
  await assert.rejects(lintWith(['link.md']), /symlink; refusing/);
  rmSync(join(root, 'link.md'));
  await assert.rejects(lintWith(['missing.md']), /missing\.md: missing file/);
  await assert.rejects(lintWith(['docs']), /not a regular file/);
  await assert.rejects(lintWith([join(outside, 'escape.md')]), /outside the repository/);
  await assert.rejects(lintWith(['../../outside.md']), /outside the repository/);
  symlinkSync(outside, join(root, 'escaped'));
  await assert.rejects(lintWith(['escaped/escape.md']), /resolves outside the repository/);
  await assert.rejects(lintWith(['--config', join(outside, 'escape.md')]), /outside the repository/);
  await assert.rejects(lintWith(['--unknown']), /Unknown option/);
});

test('docs lint refuses __proto__ keys that would hide globs or rules from its checks (T2-5)', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-lint-proto-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'README.md'), '# Title\n');
  for (const text of ['{ "__proto__": { "globs": ["README.md"] } }',
    '{ "globs": ["README.md"], "config": { "__proto__": { "MD013": true } } }',
    '{ "globs": ["README.md"], "\\u005f_proto__": {} }']) {
    writeFileSync(join(root, CONFIG), text);
    await assert.rejects(lintDocs([], { root, cwd: root }), /__proto__ keys are not allowed/, text);
  }
  writeFileSync(join(root, CONFIG), '{ "globs": ["README.md"], "config": { "MD041": false } }');
  assert.deepEqual(await lintDocs([], { root, cwd: root }), { files: ['README.md'], violations: [] });
});

test('scripts run as the main module through a symlinked path (T2-5)', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'onfreq-main-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, 'lint-docs.mjs');
  symlinkSync(fileURLToPath(new URL('./lint-docs.mjs', import.meta.url)), link);
  const run = spawnSync(process.execPath, [link, 'missing-lint-docs-fixture.md'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^Markdown lint: missing-lint-docs-fixture\.md: missing file$/m);
  const argv = process.argv[1];
  t.after(() => { process.argv[1] = argv; });
  process.argv[1] = link;
  assert.equal(isMain(new URL('./lint-docs.mjs', import.meta.url).href), true);
  assert.equal(isMain(new URL('./check-links.mjs', import.meta.url).href), false);
  for (const missing of [join(dir, 'missing.mjs'), '', undefined]) {
    process.argv[1] = missing;
    assert.equal(isMain(new URL('./lint-docs.mjs', import.meta.url).href), false, String(missing));
  }
});

test('docs lint CLI exits 1 with a message on refusals', () => {
  const run = spawnSync(process.execPath, ['scripts/lint-docs.mjs', 'missing-lint-docs-fixture.md'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^Markdown lint: missing-lint-docs-fixture\.md: missing file$/m);
});

test('the Gitleaks configuration keeps the default rules and cannot be bypassed (ROT-1)', () => {
  const canonical = readFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8');
  validateGitleaksConfig(canonical);
  const block = '[extend]\nuseDefault = true\n';
  for (const [label, changed] of [
    ['missing block', canonical.replace(block, '')],
    ['useDefault false', canonical.replace(block, '[extend]\nuseDefault = false\n')],
    ['spaced header', canonical.replace(block, '[ extend ]\nuseDefault = true\n')],
    ['quoted header', canonical.replace(block, '["extend"]\nuseDefault = true\n')],
    ['duplicate block', `${canonical}\n${block}`],
    ['dotted key', `${canonical}\nextend.useDefault = false\n`],
    ['inline table', canonical.replace(block, 'extend = { useDefault = true }\n')],
    ['extend path', canonical.replace(block, `${block}path = "other.toml"\n`)],
    ['disabled rules', canonical.replace(block, `${block}disabledRules = ["generic-api-key"]\n`)],
    ['rule path', `${canonical}\n[[rules]]\nid = "x"\npath = '''x'''\n`],
    ['CRLF', canonical.replace(/\n/g, '\r\n')],
    ['top-level allowlist', `${canonical}\n[allowlist]\nregexes = ['''.*''']\n`],
    ['top-level allowlists', `${canonical}\n[[allowlists]]\nregexes = ['''.*''']\n`],
    // Accepted by an earlier denylist check and honoured by Gitleaks 8.30.1.
    ['dotted allowlist before the first table', canonical.replace('title = "onfreq"\n', `title = "onfreq"\nallowlist.regexes = ['''.*''']\n`)],
    ['inline allowlist', `${canonical}allowlist = { regexes = ['''.*'''] }\n`],
    ['quoted escaped header', `${canonical}\n["\\u0061llowlist"]\nregexes = ['''.*''']\n`],
    ['escaped key in [extend]', canonical.replace(block, `${block}# note\n"disabled\\u0052ules" = ["generic-api-key"]\n`)],
    // Other shapes outside the grammar.
    ['unknown rule key', canonical.replace('secretGroup = 1\n', 'secretGroup = 1\nentropy = 3.5\n')],
    ['duplicate key', canonical.replace('secretGroup = 1\n', 'secretGroup = 1\nsecretGroup = 1\n')],
    ['multi-line literal string', canonical.replace(/^regex = '''/m, "regex = '''\n")],
    ['other regexTarget', canonical.replace('regexTarget = "secret"', 'regexTarget = "line"')],
    ['trailing comment', canonical.replace('useDefault = true\n', 'useDefault = true # note\n')],
    ['allowlist before any rule', canonical.replace('[[rules]]', '[[rules.allowlists]]\n\n[[rules]]')],
    ['unterminated array', `${canonical}\n[[rules]]\nid = "x"\n[[rules.allowlists]]\nregexes = [\n`],
    ['missing final newline', canonical.trimEnd()],
    // A later rule with an existing id replaces that rule in Gitleaks 8.30.1.
    ['default rule replaced', `${canonical}\n[[rules]]\nid = "generic-api-key"\ndescription = "x"\nregex = '''a^'''\n\n[[rules.allowlists]]\nregexes = ['''.*''']\n`],
    ['repository and default rules replaced', `${canonical}\n[[rules]]\nid = "onfreq-discord-id-assignment"\ndescription = "x"\nregex = '''a^'''\n\n[[rules]]\nid = "discord-client-id"\ndescription = "x"\nregex = '''a^'''\n`],
    ['duplicate onfreq- id', `${canonical}\n[[rules]]\nid = "onfreq-secret-assignment"\ndescription = "x"\nregex = '''a^'''\n`],
    ['rule without an id', `${canonical}\n[[rules]]\ndescription = "x"\nregex = '''a^'''\n`],
    ['rule without a regex', `${canonical}\n[[rules]]\nid = "onfreq-extra"\ndescription = "x"\n`],
  ]) assert.throws(() => validateGitleaksConfig(changed), undefined, label);
});

test('the wrangler.jsonc secret-name comment lists exactly the optional and first-run secrets (ROT-1)', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const wrangler = read('../wrangler.jsonc');
  const envTypes = read('../src/env.d.ts');
  validateWranglerSecretNames(wrangler, envTypes);
  assert.throws(() => validateWranglerSecretNames(wrangler.replace('SHORT_SESSION_DM_ENABLED, ', ''), envTypes));
  assert.throws(() => validateWranglerSecretNames(wrangler.replace('COORDINATOR_NAME', 'COORDINATOR_NAME, EXTRA_NAME'), envTypes));
  assert.throws(() => validateWranglerSecretNames(wrangler.replace('COORDINATOR_NAME', 'COORDINATOR_NAME, POLL_SECRET'), envTypes));
  assert.throws(() => validateWranglerSecretNames(wrangler, envTypes.replace('  COORDINATOR_NAME?: string;',
    '  COORDINATOR_NAME?: string;\n  SYNTHETIC_SETTING?: string;')));
});
