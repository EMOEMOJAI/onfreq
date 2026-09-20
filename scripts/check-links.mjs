import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import { posix } from 'node:path';
import { indexedFiles, isMain, readIndexed } from './repo-files.mjs';

const markdown = new MarkdownIt({ html: true });
const isDocument = (file) => /\.md$/i.test(file) || file === 'llms.txt';

export function documentLinks(text) {
  const links = [];
  const anchors = new Set();
  const slugger = new GithubSlugger();
  const tokens = markdown.parse(text, {});
  function html(content) {
    for (const tag of content.matchAll(/<[a-z][^>]*>/gi)) {
      for (const attr of tag[0].matchAll(/\b(href|src|id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const value = markdown.utils.unescapeAll(attr[2] ?? attr[3] ?? attr[4]);
        if (['href', 'src'].includes(attr[1].toLowerCase())) links.push(value);
        else anchors.add(value);
      }
    }
  }
  function inline(children) {
    for (const token of children ?? []) {
      if (token.type === 'link_open') links.push(token.attrGet('href'));
      if (token.type === 'image') links.push(token.attrGet('src'));
      if (token.type === 'html_inline') html(token.content);
      if (token.children) inline(token.children);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      const content = (tokens[i + 1]?.children ?? [])
        .filter((child) => ['text', 'code_inline', 'image'].includes(child.type))
        .map((child) => child.content).join('');
      anchors.add(slugger.slug(content));
    }
    if (token.type === 'html_block') html(token.content);
    inline(token.children);
  }
  return { links, anchors };
}

export function checkLocalLinks(files, repo) {
  const errors = [];
  const external = new Map();
  const parsed = new Map([...files].filter(([file]) => isDocument(file))
    .map(([file, data]) => [file, documentLinks(data.toString())]));
  for (const [file, { links }] of parsed) {
    links.forEach((link, index) => {
      const label = `${file}: link ${index + 1}`;
      try {
        let destination = link;
        if (/^https?:\/\//i.test(link)) {
          const url = new URL(link);
          if (url.username || url.password) throw new Error('embedded URL credentials');
          const raw = `/${repo}/main/`;
          const github = `/${repo}/`;
          if (url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith(raw)) {
            destination = '/' + url.pathname.slice(raw.length) + url.hash;
          } else if (url.hostname === 'github.com' && url.pathname.startsWith(github) &&
              /^(?:blob|tree)\/main\//.test(url.pathname.slice(github.length))) {
            destination = '/' + url.pathname.slice(github.length).replace(/^(?:blob|tree)\/main\//, '') + url.hash;
          } else {
            url.hash = '';
            if (!external.has(url.href)) external.set(url.href, label);
            return;
          }
        } else if (/^[a-z][a-z\d+.-]*:/i.test(link)) {
          if (!/^mailto:/i.test(link)) throw new Error('unsupported link protocol');
          return;
        } else if (link.startsWith('//')) throw new Error('use explicit HTTPS links');
        const [pathAndQuery, fragment] = destination.split('#');
        const path = decodeURIComponent(pathAndQuery.split('?')[0]);
        const target = path ? posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(file), path)) : file;
        if (target === '..' || target.startsWith('../')) throw new Error('link leaves repository');
        const directory = target === '.' || [...files.keys()].some((name) => name.startsWith(target.replace(/\/$/, '') + '/'));
        if (!files.has(target) && !directory) throw new Error('missing tracked target');
        if (fragment) {
          const targetDoc = directory ? posix.join(target, 'README.md') : target;
          const anchors = parsed.get(targetDoc)?.anchors;
          if (!anchors?.has(decodeURIComponent(fragment))) throw new Error('missing document anchor');
        }
      } catch (error) { errors.push(`${label}: ${error instanceof URIError ? 'invalid URL encoding' : error.message}`); }
    });
  }
  return { errors, external, documents: parsed.size };
}

// Public reachability only: no authentication, cookies, bodies or production requests.
export async function checkExternalLinks(links, fetcher = fetch, pause = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const errors = [];
  const warnings = [];
  for (const [url, label] of links) {
    let status = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let response = await fetcher(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
        status = response.status;
        await response.body?.cancel();
        if ([405, 501].includes(status)) {
          response = await fetcher(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
          status = response.status;
          await response.body?.cancel();
        }
      } catch { status = 0; }
      if (status && status !== 429 && status < 500) break;
      if (attempt < 2) await pause(1000 * (attempt + 1));
    }
    // Authentication / bot blocking cannot establish whether a page is missing.
    if ([401, 403, 429].includes(status)) warnings.push(`${label}: HTTP ${status}; reachability unverified`);
    else if (status < 200 || status >= 400) errors.push(`${label}: ${status ? `HTTP ${status}` : 'network failure'}`);
  }
  return { errors, warnings };
}

if (isMain(import.meta.url)) {
  const files = new Map([...indexedFiles()].map(([file, { mode }]) => {
    if (!['100644', '100755'].includes(mode)) throw new Error('Check privacy before documentation links');
    return [file, isDocument(file) || file === 'package.json' ? readIndexed(file) : Buffer.alloc(0)];
  }));
  const pkg = JSON.parse(files.get('package.json'));
  const repo = new URL(pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')).pathname.slice(1);
  const result = checkLocalLinks(files, repo);
  if (process.argv.includes('--external')) {
    const remote = await checkExternalLinks(result.external);
    result.errors.push(...remote.errors);
    for (const warning of remote.warnings) console.warn(warning);
  }
  for (const error of result.errors) console.error(error);
  console.log(`Documentation links: ${result.errors.length ? 'FAILED' : 'passed'} (${result.documents} documents)`);
  process.exitCode = result.errors.length ? 1 : 0;
}
