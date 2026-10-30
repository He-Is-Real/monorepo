#!/usr/bin/env node
// Dev's placeholder PDFs of record for the two legal documents (libs/legal/README.md, "The
// documents of record", D121): the privacy policy (libs/legal/dpa/dev_placeholder.md, dev's
// privacy document since D75) and the terms of use (libs/legal/terms/dev_placeholder.md), each
// rendered from the same words to <id>.pdf beside it. The PDFs are committed: OpenTofu's gcp root
// uploads them to the legal documents bucket (legal/<document>/<id>/<sha256>.pdf) and the
// db-migration module passes their sha256 and size to the migration (data 0007). Deterministic
// (fixed dates, no random ID), so running it again on unchanged words changes nothing. A
// published version's PDF is frozen: new words need a new version (an admin upload).
//
//   node tools/scripts/legal-placeholder-pdfs.mjs           # write the PDFs
//   node tools/scripts/legal-placeholder-pdfs.mjs --check   # fail if a PDF is missing or out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const LEGAL = resolve(import.meta.dirname, '../../libs/legal');
const DOCUMENTS = [
  { md: 'dpa/dev_placeholder.md' },
  { md: 'terms/dev_placeholder.md' },
];
const FIXED_DATE = new Date('2026-10-29T00:00:00Z');

const A4 = [595.28, 841.89];
const MARGIN = 64;
const WIDTH = A4[0] - 2 * MARGIN;

/** Markdown blocks: the same small subset the site renders (apps/web/src/lib/legal.ts). */
function blocks(markdown) {
  const out = [];
  let open = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t) {
      open = null;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      out.push({ kind: 'heading', level: h[1].length, text: h[2] });
      open = null;
    } else if (t.startsWith('>')) {
      const text = t.replace(/^>\s?/, '');
      if (open?.kind !== 'note') out.push((open = { kind: 'note', text: '' }));
      open.text = `${open.text} ${text}`.trim();
    } else if (/^[-*]\s+/.test(t) && !line.startsWith(' ')) {
      out.push((open = { kind: 'item', text: t.replace(/^[-*]\s+/, '') }));
    } else if (open && open.kind !== 'heading') {
      open.text += ` ${t}`;
    } else {
      out.push((open = { kind: 'paragraph', text: t }));
    }
  }
  return out;
}

/** Words with their font: `**bold**` runs bold, `code` and the rest regular. */
function words(text, regular, bold) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|([^*`]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const font = m[1] !== undefined ? bold : regular;
    for (const w of (m[1] ?? m[2] ?? m[3]).split(/\s+/).filter(Boolean)) {
      out.push({ w, font });
    }
  }
  return out;
}

async function render(markdown, title) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor('He Is Real Today');
  pdf.setCreator('tools/scripts/legal-placeholder-pdfs.mjs');
  pdf.setProducer('pdf-lib');
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage(A4);
  let y = A4[1] - MARGIN;

  const write = (
    text,
    { size = 11, indent = 0, font = regular, colour = rgb(0.1, 0.1, 0.1) },
  ) => {
    const lead = size * 1.45;
    let line = [];
    let width = 0;
    const flush = () => {
      if (y - lead < MARGIN) {
        page = pdf.addPage(A4);
        y = A4[1] - MARGIN;
      }
      let x = MARGIN + indent;
      for (const { w, font: f } of line) {
        page.drawText(w, { x, y: y - size, size, font: f, color: colour });
        x += f.widthOfTextAtSize(`${w} `, size);
      }
      y -= lead;
      line = [];
      width = 0;
    };
    for (const word of words(text, font, bold)) {
      const ww = word.font.widthOfTextAtSize(`${word.w} `, size);
      if (width + ww > WIDTH - indent && line.length) flush();
      line.push(word);
      width += ww;
    }
    if (line.length) flush();
  };

  for (const b of blocks(markdown)) {
    if (b.kind === 'heading') {
      y -= 6;
      write(b.text, { size: b.level === 1 ? 17 : 13, font: bold });
      y -= 4;
    } else if (b.kind === 'note') {
      write(b.text, { size: 10, indent: 12, colour: rgb(0.3, 0.3, 0.3) });
      y -= 8;
    } else if (b.kind === 'item') {
      write(`•  ${b.text}`, { indent: 12 });
      y -= 2;
    } else {
      write(b.text, {});
      y -= 8;
    }
  }
  return pdf.save({ useObjectStreams: false });
}

const check = process.argv.includes('--check');
let stale = false;
for (const { md } of DOCUMENTS) {
  const out = resolve(LEGAL, md.replace(/\.md$/, '.pdf'));
  const markdown = readFileSync(resolve(LEGAL, md), 'utf8');
  const title = /^#\s+(.*)$/m.exec(markdown)?.[1] ?? md;
  const bytes = Buffer.from(await render(markdown, title));
  if (check) {
    let current = null;
    try {
      current = readFileSync(out);
    } catch {
      // missing: stale
    }
    if (!current?.equals(bytes)) {
      console.error(
        `${out} is out of date: run tools/scripts/legal-placeholder-pdfs.mjs`,
      );
      stale = true;
    }
  } else {
    writeFileSync(out, bytes);
    console.log(`wrote ${out} (${bytes.length} bytes)`);
  }
}
if (stale) process.exit(1);
