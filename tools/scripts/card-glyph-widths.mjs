#!/usr/bin/env node
// Writes apps/web/src/lib/card-glyphs.ts: how wide each character is in DM Sans as the site
// serves it, so lib/masonry.ts can wrap the story card's text as a browser does (D55), and the
// pairs of characters the font kerns closer or apart (`Te` closer; DM Sans spaces `/` from a
// capital after it): a text's widths plus its pairs' add up to at least what a browser draws. The card draws its text without hinting (`text-rendering: geometricPrecision`, which
// Chromium on Linux would otherwise use to round each letter to whole pixels: `t` at 15 px is 7
// px where the font says 5.9, Codex review of #163), so these are the font's own widths in every
// browser, at every text size. Measured from the built site's latin DM Sans (next/font downloads
// it at build), in Chromium and Firefox, at each of the card's text styles (lib/card-metrics.ts)
// at 1 to 2 times its size, in thousandths of an em, the widest of all, rounded up.
// Run after `pnpm nx run web:prune` whenever the font or a text style changes:
//   node tools/scripts/card-glyph-widths.mjs
// The table records the font file's SHA-256 and what it was measured with; an e2e test
// (masonry.e2e.ts) fails once the site serves a different font, so it gets regenerated.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { chromium, firefox } from '@playwright/test';
import { CARD } from '../../apps/web/src/lib/card-metrics.ts';

const root = resolve(import.meta.dirname, '../..');
const statics = join(root, 'apps/web/dist/apps/web/.next/static');
const out = join(root, 'apps/web/src/lib/card-glyphs.ts');

/** story-card.tsx's text styles; the excerpt is italic (the browser slants the upright face). */
const STYLES = Object.fromEntries(
  ['meta', 'badge', 'title', 'excerpt', 'quote', 'tags'].map((name) => [
    name,
    {
      font: CARD[name].font,
      weight: CARD[name].weight,
      italic: name === 'excerpt',
    },
  ]),
);
const WEIGHTS = [...new Set(Object.values(STYLES).map((s) => s.weight))];
/** Each style is measured at its size times each of these (a reader's text size). */
const SCALES = [1, 1.25, 1.5, 2];
/** Printable ASCII, Latin-1 and the usual typographic punctuation. */
const CHARS = [
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0xa1 + i)),
  ...'‐‑‒–—―‘’‚“”„†‡•…‰′″‹›€™',
];

// The latin face: the @font-face whose unicode-range starts with U+0000-00FF (U+??).
function latinFont() {
  const dir = join(statics, 'chunks');
  for (const file of readdirSync(dir, { recursive: true })) {
    if (!String(file).endsWith('.css')) continue;
    const css = readFileSync(join(dir, String(file)), 'utf8');
    for (const face of css.match(/@font-face\{[^}]*\}/g) ?? []) {
      const src =
        /family:DM Sans;.*url\(\.\.\/media\/([^)]+)\).*unicode-range:U\+\?\?/.exec(
          face,
        );
      if (src) return join(statics, 'media', src[1]);
    }
  }
  throw new Error(
    'No latin DM Sans in the build: run `pnpm nx run web:prune` first.',
  );
}

const fontFile = latinFont();
const fontBytes = readFileSync(fontFile);
const font = fontBytes.toString('base64');
const fontSha256 = createHash('sha256').update(fontBytes).digest('hex');
const versions = {};

/**
 * In one browser, at each [size, weight, italic]: each character's width in px, and the pairs
 * whose width is more than their two characters' (positive kerning), by how much.
 */
async function measure(type, settings) {
  const browser = await type.launch();
  versions[type.name()] = browser.version();
  const page = await browser.newPage();
  const result = await page.evaluate(
    async ({ font, settings, chars }) => {
      const bytes = Uint8Array.from(atob(font), (c) => c.charCodeAt(0));
      const face = new FontFace('Card', bytes.buffer, { weight: '100 1000' });
      await face.load();
      document.fonts.add(face);
      // Every character, then every pair, each in its own box as wide as its text.
      const texts = [
        ...chars,
        ...chars.flatMap((a) => chars.map((b) => a + b)),
      ];
      return settings.map(([size, weight, italic]) => {
        const box = document.createElement('div');
        box.style.cssText = `font-family:Card,system-ui,sans-serif;font-size:${size}px;font-weight:${weight};font-style:${italic ? 'italic' : 'normal'};text-rendering:geometricPrecision;white-space:pre;position:absolute;display:flex;flex-direction:column;align-items:flex-start`;
        for (const text of texts) {
          const span = document.createElement('span');
          span.textContent = text;
          box.append(span);
        }
        document.body.append(box);
        const widths = Array.from(
          box.children,
          (span) => span.getBoundingClientRect().width,
        );
        box.remove();
        const n = chars.length;
        const kerns = {};
        chars.forEach((a, i) =>
          chars.forEach((b, j) => {
            const kern = widths[n + i * n + j] - widths[i] - widths[j];
            if (Math.abs(kern) > 0.001) kerns[a + b] = kern;
          }),
        );
        return { widths: widths.slice(0, n), kerns };
      });
    },
    { font, settings, chars: CHARS },
  );
  await browser.close();
  return result;
}

const settings = Object.values(STYLES).flatMap((s) =>
  SCALES.map((scale) => [s.font * scale, s.weight, s.italic]),
);
const measured = [
  ...(await measure(chromium, settings)),
  ...(await measure(firefox, settings)),
].map((m, i) => {
  const [size, weight] = settings[i % settings.length];
  return { ...m, size, weight };
});

/** Thousandths of an em, rounded up, the most of any measurement at this weight. */
const thousandths = (px, size) => Math.ceil((px / size) * 1000 - 1e-6);
const ems = WEIGHTS.map((weight) => {
  const own = measured.filter((m) => m.weight === weight);
  return [
    weight,
    CHARS.map((_, c) =>
      Math.max(...own.map((m) => thousandths(m.widths[c], m.size))),
    ),
  ];
});
// A pair's kerning is the most of any measurement (0 where one didn't kern it): it can pull a
// pair closer (most do) only by as little as the browser that pulls it least. Every pair the font
// spaces apart is kept; of those it pulls closer, only pairs of letters, digits, spaces and
// everyday punctuation (any other pair counts as not kerned, so it errs wide).
const EVERYDAY = /^[A-Za-z0-9 .,:;!?'’"“”()-]{2}$/;
const kerns = WEIGHTS.map((weight) => {
  const own = measured.filter((m) => m.weight === weight);
  const pairs = new Set(own.flatMap((m) => Object.keys(m.kerns)));
  const kerning = [...pairs]
    .sort()
    .map((pair) => [
      pair,
      Math.max(
        ...own.map((m) =>
          m.kerns[pair] === undefined ? 0 : thousandths(m.kerns[pair], m.size),
        ),
      ),
    ])
    .filter(([pair, kern]) => kern > 0 || (kern < 0 && EVERYDAY.test(pair)))
    .map(([pair, kern]) => `${pair}${kern}`);
  return [weight, kerning];
});

const rows = (entries) =>
  entries
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
    .join('\n');
writeFileSync(
  out,
  `// Generated by tools/scripts/card-glyph-widths.mjs: don't edit by hand.
// DM Sans's widths by weight, in thousandths of an em, rounded up (lib/masonry.ts wraps card text
// with them): each of GLYPH_CHARS in turn (GLYPH_EMS), and how much wider or narrower than its two
// characters a pair is drawn (KERN_EMS).

/** What the table was measured from and with: regenerate it when the served font changes. */
export const GLYPH_SOURCE = ${JSON.stringify(
    {
      font: basename(fontFile),
      fontSha256,
      browsers: versions,
      styles: STYLES,
      scales: SCALES,
    },
    null,
    2,
  )} as const;

export const GLYPH_CHARS = ${JSON.stringify(CHARS.join(''))};

export const GLYPH_EMS = {
${rows(ems)}
} as const;

// Each pair, then its kerning (\`Te-35\`).
// prettier-ignore
export const KERN_EMS: Record<number, string[]> = {
${rows(kerns)}
};
`,
);
console.log(`Wrote ${out}`);
