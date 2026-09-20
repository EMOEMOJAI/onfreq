import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imagePrivacy, privateCommitEmails, privatePath, publicConfig } from './check-privacy.mjs';
import { checkExternalLinks, checkLocalLinks, documentLinks } from './check-links.mjs';
import { testDeployGuard, validateSetup } from './check-setup.mjs';
import { jsonc } from './repo-files.mjs';

test('rejects private paths independently of gitignore, allowing public templates', () => {
  for (const file of ['.dev.vars', '.env.production', 'nested/.dev.vars.preview', 'wrangler.local.jsonc',
    'set-secrets.local.sh', '.local/report.txt', '.wrangler/state.db', 'poll-secret', 'poll-endpoint',
    'key.pem', 'private.key', 'trace.log', '.claude/settings.local.json']) assert.equal(privatePath(file), true, file);
  for (const file of ['.dev.vars.example', '.env.example', 'wrangler.jsonc', 'config/optional-secrets.example']) {
    assert.equal(privatePath(file), false, file);
  }
});

test('rejects operator IDs and variables without revealing their values', () => {
  const safe = { kv_namespaces: [{ id: '0'.repeat(32) }], vars: { OFFLINE_GRACE_POLLS: '2' } };
  assert.deepEqual(publicConfig(safe), []);
  const failures = publicConfig({ ...safe, account_id: 'synthetic-private-value',
    vars: { DISCORD_CHANNEL_IDS: 'synthetic-private-value' }, env: { production: {} } });
  assert.ok(failures.length >= 3);
  assert.doesNotMatch(failures.join(' '), /synthetic-private-value/);
});

test('checks both raw commit emails and redacts rejected identities', () => {
  const safe = 'a'.repeat(40) + '\t123+example@users.noreply.github.com\texample@users.noreply.github.com';
  assert.deepEqual(privateCommitEmails(safe), []);
  for (const value of [safe.replace('123+example@users.noreply.github.com', 'person@example.test'),
    safe.replace('\texample@users.noreply.github.com', '\tperson@example.test')]) {
    const failures = privateCommitEmails(value);
    assert.equal(failures.length, 1);
    assert.doesNotMatch(failures[0], /person|example\.test/);
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

test('validates guided setup and rejects changed prompts, values and deployment identities', () => {
  const config = jsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const example = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
  validateSetup(config, pkg, example);
  assert.throws(() => validateSetup(config, pkg, example + '\nEXTRA_SECRET=""'));
  assert.throws(() => validateSetup(config, pkg, example.replace('POLL_SECRET=""', 'POLL_SECRET="synthetic"')));
  assert.throws(() => validateSetup({ ...config, kv_namespaces: [{ binding: 'ATC_STATE', id: '1'.repeat(32) }] }, pkg, example));
  assert.throws(() => validateSetup(config, { ...pkg, cloudflare: { bindings: {} } }, example));
  assert.throws(() => validateSetup(config, { ...pkg, scripts: { ...pkg.scripts, predeploy: 'echo skipped' } }, example));
});

test('npm predeploy permits a fresh template and blocks private configuration before deployment', () => {
  testDeployGuard(readFileSync(new URL('./check-deploy.mjs', import.meta.url)));
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
