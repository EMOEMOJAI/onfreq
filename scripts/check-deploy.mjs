import { lstatSync } from 'node:fs';

// A copied public template must never silently replace an existing deployment.
// The public deploy script runs this directly as well as through predeploy, so
// npm's ignore-scripts setting cannot skip it. lstat also catches symlinks,
// including dangling ones; any error other than "absent" fails closed.
const names = ['wrangler.local.jsonc', 'wrangler.local.json', 'wrangler.local.toml'];
for (const name of names) {
  try {
    lstatSync(new URL(`../${name}`, import.meta.url));
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    console.error('Could not check for private deployment config; refusing public deployment.');
    process.exit(1);
  }
  console.error('Private deployment config detected. Use npm run deploy:local for this installation.');
  process.exit(1);
}
