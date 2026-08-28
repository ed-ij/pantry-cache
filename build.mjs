/**
 * Builds the Apps Script project into ./dist.
 *
 * Apps Script wants one .gs of server code and .html files for everything the
 * browser sees, so the CSS and JS get wrapped in <style>/<script> tags and
 * pulled into Index.html via include().
 *
 * Every build is stamped. Each household runs its own copy of this code, pasted
 * in by hand, and until now nothing recorded which copy was which — so a bug
 * report could not be tied to a version, and nobody could be told whether they
 * were out of date. `npm run release` then publishes that stamp to latest.json,
 * which is what the in-sheet update check reads.
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const read = (...p) => readFile(join(...p), 'utf8');

/**
 * ISO timestamps compare correctly as plain strings, which is the whole of the
 * "is there a newer version?" logic and needs no version bookkeeping. The
 * commit is carried alongside for the times you need to know exactly what a
 * household is running.
 */
const BUILD = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
let COMMIT = 'unknown';
try {
  COMMIT = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  // Building outside a checkout is fine; the stamp just says so.
}

const stamp = `/** Stamped by build.mjs. Shown in the setup dialog and compared against latest.json. */
const BUILD = '${BUILD}';
const BUILD_COMMIT = '${COMMIT}';
const RELEASE_BASE = 'https://raw.githubusercontent.com/ed-ij/pantry-cache/main/';
`;

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

/* Code.gs — the stamp, then the host adapter, then the shared logic. */
const host = await read(ROOT, 'apps-script', 'host.js');
const backend = await read(SRC, 'backend.js');
await writeFile(
  join(DIST, 'Code.gs'),
  `${'/'.repeat(3)} Built by build.mjs from apps-script/host.js + src/backend.js — do not edit here.\n\n${stamp}\n${host}\n\n${backend}`,
);

/* Css.html / Js.html — plain includes. */
await writeFile(join(DIST, 'Css.html'), `<style>\n${await read(SRC, 'styles.css')}\n</style>\n`);
await writeFile(join(DIST, 'Js.html'), `<script>\n${await read(SRC, 'app.js')}\n</script>\n`);

/* Setup.html / Update.html — the in-spreadsheet dialogs, served as-is. */
await writeFile(join(DIST, 'Setup.html'), await read(SRC, 'setup.html'));
await writeFile(join(DIST, 'Update.html'), await read(SRC, 'update.html'));

/* Index.html — swap the dev placeholders for Apps Script scriptlets. */
const index = (await read(SRC, 'index.html'))
  .replace('<!--CSS-->', "<?!= include('Css'); ?>")
  .replace('<!--JS-->', "<?!= include('Js'); ?>");
await writeFile(join(DIST, 'Index.html'), index);

/**
 * Manifest. Two lines worth thinking about:
 *
 * `access` — see README. ANYONE_ANONYMOUS is deliberate; the link is the key.
 *
 * `oauthScopes` — declared rather than inferred. Left to itself Apps Script
 * infers the broad `spreadsheets` scope, so the consent screen asks for every
 * spreadsheet the user owns, at exactly the moment the setup dialog is telling
 * a non-technical person the warning is nothing to worry about.
 * `spreadsheets.currentonly` is what a bound script actually needs, and it
 * names this sheet in the prompt instead.
 */
await writeFile(join(DIST, 'appsscript.json'), JSON.stringify({
  timeZone: 'Europe/London',
  exceptionLogging: 'STACKDRIVER',
  runtimeVersion: 'V8',
  oauthScopes: [
    'https://www.googleapis.com/auth/spreadsheets.currentonly',
    'https://www.googleapis.com/auth/script.container.ui',
    'https://www.googleapis.com/auth/script.external_request',
  ],
  webapp: {
    executeAs: 'USER_DEPLOYING',
    access: 'ANYONE_ANONYMOUS',
  },
}, null, 2) + '\n');

console.log(`Built dist/ at ${BUILD} (${COMMIT})`);
console.log('  Code.gs, Index.html, Css.html, Js.html, Setup.html, Update.html, appsscript.json');
