/**
 * Builds the Apps Script project into ./dist.
 *
 * Apps Script wants one .gs of server code and .html files for everything the
 * browser sees, so the CSS and JS get wrapped in <style>/<script> tags and
 * pulled into Index.html via include().
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const read = (...p) => readFile(join(...p), 'utf8');

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

/* Code.gs — host adapter first, then the shared logic. */
const host = await read(ROOT, 'apps-script', 'host.js');
const backend = await read(SRC, 'backend.js');
await writeFile(
  join(DIST, 'Code.gs'),
  `${'/'.repeat(3)} Built by build.mjs from apps-script/host.js + src/backend.js — do not edit here.\n\n${host}\n\n${backend}`,
);

/* Css.html / Js.html — plain includes. */
await writeFile(join(DIST, 'Css.html'), `<style>\n${await read(SRC, 'styles.css')}\n</style>\n`);
await writeFile(join(DIST, 'Js.html'), `<script>\n${await read(SRC, 'app.js')}\n</script>\n`);

/* Setup.html — the in-spreadsheet dialog, served as-is. */
await writeFile(join(DIST, 'Setup.html'), await read(SRC, 'setup.html'));

/* Index.html — swap the dev placeholders for Apps Script scriptlets. */
const index = (await read(SRC, 'index.html'))
  .replace('<!--CSS-->', "<?!= include('Css'); ?>")
  .replace('<!--JS-->', "<?!= include('Js'); ?>");
await writeFile(join(DIST, 'Index.html'), index);

/* Manifest. `access` is the one line worth thinking about — see README. */
await writeFile(join(DIST, 'appsscript.json'), JSON.stringify({
  timeZone: 'Europe/London',
  exceptionLogging: 'STACKDRIVER',
  runtimeVersion: 'V8',
  webapp: {
    executeAs: 'USER_DEPLOYING',
    access: 'ANYONE_ANONYMOUS',
  },
}, null, 2) + '\n');

console.log('Built dist/: Code.gs, Index.html, Css.html, Js.html, Setup.html, appsscript.json');
