import { existsSync } from 'node:fs';

// A copied public template must never silently replace an existing deployment.
if (existsSync(new URL('../wrangler.local.jsonc', import.meta.url))) {
  console.error('Private deployment config detected. Use npm run deploy:local for this installation.');
  process.exit(1);
}
