// Browser-safe parts of the legal texts: their Markdown and where a legal document version's
// PDF is served. lib/legal.ts (server reads from api-public-read) re-exports them.

/** D121: the two legal documents (`LegalDocumentName`). */
export type LegalDocumentName = 'privacy' | 'terms';

/** Where web serves a legal document version's PDF of record (app/legal/[document]/[file]). */
export const documentPdfHref = (
  document: LegalDocumentName,
  version: string,
): string => `/legal/${document}/${encodeURIComponent(version)}.pdf`;

// --- The texts' Markdown ---------------------------------------------------------------------
//
// The forms' introductions and the legal documents' web text are short, plain Markdown (libs/legal/README.md): headings,
// paragraphs, "> " notes, "- " lists, **bold** and `code`. They are documents to read only: the
// boxes come from the version's statements data (D114), never from these words.

/** A run of text: plain, **bold** or `code`. */
export type Inline = { kind: 'text' | 'bold' | 'code'; text: string };

export type LegalBlock =
  | { kind: 'heading'; level: number; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'note'; paragraphs: Inline[][] }
  | { kind: 'list'; items: LegalListItem[] };

export interface LegalListItem {
  content: Inline[];
}

/** `**bold**` and `` `code` `` runs; anything else is text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last)
      out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push(
      m[1] !== undefined
        ? { kind: 'bold', text: m[1] }
        : { kind: 'code', text: m[2] },
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** The text's blocks. Lines that continue a paragraph, note or list item are joined to it. */
export function parseLegalText(markdown: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  // Each block's raw lines first, then their inline runs.
  type Raw =
    | { kind: 'heading'; level: number; text: string }
    | { kind: 'paragraph'; text: string }
    | { kind: 'note'; paragraphs: string[] }
    | { kind: 'list'; items: string[] };
  const raws: Raw[] = [];
  let open: Raw | null = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (open?.kind === 'note') open.paragraphs.push('');
      else open = null;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      raws.push({
        kind: 'heading',
        level: heading[1].length,
        text: heading[2],
      });
      open = null;
      continue;
    }
    if (trimmed.startsWith('>')) {
      const text = trimmed.replace(/^>\s?/, '');
      if (open?.kind !== 'note') {
        open = { kind: 'note', paragraphs: [''] };
        raws.push(open);
      }
      const paragraphs = open.paragraphs;
      if (!text) paragraphs.push('');
      else
        paragraphs[paragraphs.length - 1] =
          `${paragraphs[paragraphs.length - 1]} ${text}`.trim();
      continue;
    }
    if (open?.kind === 'note') open = null;
    const item = /^[-*]\s+(.*)$/.exec(trimmed);
    if (item && !line.startsWith(' ')) {
      if (open?.kind !== 'list') {
        open = { kind: 'list', items: [] };
        raws.push(open);
      }
      open.items.push(item[1]);
      continue;
    }
    if (open?.kind === 'list') {
      open.items[open.items.length - 1] += ` ${trimmed}`;
    } else if (open?.kind === 'paragraph') {
      open.text += ` ${trimmed}`;
    } else {
      open = { kind: 'paragraph', text: trimmed };
      raws.push(open);
    }
  }
  for (const raw of raws) {
    if (raw.kind === 'heading') {
      blocks.push({
        kind: 'heading',
        level: raw.level,
        content: parseInline(raw.text),
      });
    } else if (raw.kind === 'paragraph') {
      blocks.push({ kind: 'paragraph', content: parseInline(raw.text) });
    } else if (raw.kind === 'note') {
      blocks.push({
        kind: 'note',
        paragraphs: raw.paragraphs.filter(Boolean).map(parseInline),
      });
    } else {
      blocks.push({
        kind: 'list',
        items: raw.items.map((text) => ({ content: parseInline(text) })),
      });
    }
  }
  return blocks;
}
