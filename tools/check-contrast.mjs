/**
 * Fails the build if any text/background pairing drops below WCAG AA.
 *
 * Constraint 4 gives a testable number for touch targets and an adjective for
 * type — "large" — and the adjective is the half that failed. In the light
 * theme --ink-3 sat at 2.7:1 on every surface it was used on, and the
 * "use first" badge, which is the app's whole answer to "what has been in
 * there longest", was at 3.96:1. Twenty lines here would have caught all of it.
 *
 * Run by `npm test`. Pairings are listed explicitly rather than derived, so
 * adding a token means deciding what it sits on.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = await readFile(join(ROOT, 'src', 'styles.css'), 'utf8');

/** The `:root` block is light; the one inside the dark media query is dark. */
function tokens(block) {
  const out = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[name] = value;
  }
  return out;
}

const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
const dark = tokens(darkBlock.slice(0, darkBlock.indexOf('* { box-sizing')));

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** [foreground token, background token, what it is, minimum]. */
const PAIRS = [
  ['ink', 'surface', 'body text'],
  ['ink', 'bg', 'body text on the page'],
  ['ink-2', 'surface', 'labels and secondary text'],
  ['ink-2', 'surface-2', 'secondary text on tinted cards'],
  ['ink-2', 'surface-3', 'stepper button labels'],
  ['ink-3', 'surface', 'captions, placeholders, chevrons'],
  ['ink-3', 'surface-2', 'card hints and group headings'],
  ['ink-3', 'surface-3', 'the faintest text on the busiest ground'],
  ['ink-3', 'bg', 'category headings on the page'],
  ['accent', 'surface', 'links and ghost buttons'],
  ['accent', 'accent-soft', 'the fine stepper buttons'],
  ['accent-ink', 'accent', 'text on the primary button'],
  ['warm', 'warm-soft', 'the "use first" badge'],
  ['warm-ink', 'warm', 'text on the take-out button'],
  ['good', 'good-soft', 'the "something new" tile'],
  ['danger', 'surface', 'error text'],
];

const MIN = 4.5;
const failures = [];

for (const [theme, set] of [['light', light], ['dark', dark]]) {
  for (const [fg, bg, what] of PAIRS) {
    if (!set[fg] || !set[bg]) {
      failures.push(`${theme}: --${fg} or --${bg} is not defined`);
      continue;
    }
    const r = ratio(set[fg], set[bg]);
    if (r < MIN) {
      failures.push(
        `${theme}: --${fg} on --${bg} is ${r.toFixed(2)}:1, needs ${MIN} — ${what}`,
      );
    }
  }
}

if (failures.length) {
  console.error('Contrast check failed:\n  ' + failures.join('\n  '));
  process.exit(1);
}

console.log(`Contrast: ${PAIRS.length * 2} pairings clear ${MIN}:1 in both themes.`);
