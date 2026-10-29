import { apiPublicReadUrl } from './config';

// D32: the consent forms and the privacy document are public, so web's server reads them from
// api-public-read like a story, with nothing from the visitor's request. The browser then
// grants consent on exactly that version through api-user (consent-form.tsx).

/** `ConsentForm` in libs/contracts/openapi/components.yaml. */
export type ConsentFormName = 'signup' | 'testimony' | 'social';

/** `ConsentType`: a consent type, which is also a statement (a box) on a form (D84). */
export type ConsentStatement =
  | 'special_category_religious'
  | 'publish'
  | 'share_socials'
  | 'age_18plus'
  | 'account_data';

/** `ConsentFormVersion.boxes` (D114): one box and the exact words shown beside it. */
export interface ConsentBox {
  statement: ConsentStatement;
  label: string;
}

/**
 * `ConsentFormVersion`: the version in force, with its words (Markdown, a document to read) and
 * its boxes as structured data (D114): the boxes never come from the words.
 */
export interface ConsentFormVersion {
  form: ConsentFormName;
  id: string;
  dpaVersion: string;
  text: string;
  statements: ConsentStatement[];
  boxes: ConsentBox[];
}

/** `DpaDocument`: the privacy document a form version links, with its words. */
export interface PrivacyDocument {
  id: string;
  text: string;
}

/** What a consent page shows: the form version in force and the privacy document it links. */
export type LegalResult =
  | { kind: 'ok'; form: ConsentFormVersion; dpa: PrivacyDocument }
  /** No version of the form is published (404), or its privacy document isn't. */
  | { kind: 'not_published' }
  /** api-public-read couldn't be reached or answered unexpectedly. */
  | { kind: 'unavailable' };

const TIMEOUT_MS = 10_000;

async function read(path: string): Promise<unknown> {
  const res = await fetch(`${apiPublicReadUrl()}${path}`, {
    headers: { accept: 'application/json' },
    // Read fresh each time: a new version is in force the moment it's published.
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

const isForm = (v: unknown, form: ConsentFormName): v is ConsentFormVersion => {
  const f = v as Partial<ConsentFormVersion> | null;
  return (
    !!f &&
    f.form === form &&
    typeof f.id === 'string' &&
    typeof f.dpaVersion === 'string' &&
    typeof f.text === 'string' &&
    Array.isArray(f.statements) &&
    Array.isArray(f.boxes) &&
    f.boxes.every(
      (b) =>
        typeof b?.statement === 'string' &&
        typeof b.label === 'string' &&
        b.label.trim() !== '',
    )
  );
};

/**
 * The form `form` in force (`GET /v1/legal/forms/{form}`) and the privacy document that version
 * links (`GET /v1/legal/dpa?version=…`), per request.
 */
export async function getConsentForm(
  form: ConsentFormName,
): Promise<LegalResult> {
  try {
    const version = await read(`/v1/legal/forms/${form}`);
    if (version === null) return { kind: 'not_published' };
    if (!isForm(version, form)) return { kind: 'unavailable' };
    const dpa = (await read(
      `/v1/legal/dpa?version=${encodeURIComponent(version.dpaVersion)}`,
    )) as { current?: Partial<PrivacyDocument> } | null;
    if (dpa === null) return { kind: 'not_published' };
    const current = dpa.current;
    if (
      typeof current?.id !== 'string' ||
      typeof current.text !== 'string' ||
      current.id !== version.dpaVersion
    ) {
      return { kind: 'unavailable' };
    }
    return {
      kind: 'ok',
      form: version,
      dpa: { id: current.id, text: current.text },
    };
  } catch (err) {
    console.error(
      `api-public-read: consent form ${form} unavailable: ${err instanceof Error ? err.message : 'error'}`,
    );
    return { kind: 'unavailable' };
  }
}

// --- The texts' Markdown ---------------------------------------------------------------------
//
// The forms and the privacy document are short, plain Markdown (libs/legal/README.md): headings,
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
