/**
 * Publishes the current build as the one households should be running.
 *
 * `npm run build` stamps dist/Code.gs with a timestamp. That stamp is only
 * informational until it is written here — releasing is deliberate, so that
 * rebuilding locally does not tell five households there is an update.
 *
 *   npm run release -- "What changed, in one sentence."
 *
 * Then commit and push. The in-sheet "Check for updates" dialog reads
 * latest.json and dist/* straight from the repo, so pushing is publishing.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const code = await readFile(join(ROOT, 'dist', 'Code.gs'), 'utf8');

const build = (code.match(/^const BUILD = '([^']+)';$/m) || [])[1];
const commit = (code.match(/^const BUILD_COMMIT = '([^']+)';$/m) || [])[1];

if (!build) {
  console.error('No BUILD stamp in dist/Code.gs. Run `npm run build` first.');
  process.exit(1);
}

const notes = process.argv.slice(2).join(' ').trim();
if (!notes) {
  console.error('Say what changed:  npm run release -- "Fixed the date on backdated bags."');
  process.exit(1);
}

const manifest = { build, commit, notes, published: new Date().toISOString() };
await writeFile(join(ROOT, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`Released ${build} (${commit})`);
console.log(`  "${notes}"`);
console.log('\nNow: git add -A && git commit && git push');
