import { diffArrays, diffWords } from 'diff';
import { legalTextBlocks, type TextBlock } from './markdown';

// Plan 4e, "Showing what changed": one word-level redline (jsdiff) from one version of a legal text
// to another, the same for people re-agreeing (from the version they agreed to, to the latest, in
// one go) and for admins before they save (the latest against their new text). Browser-safe.

/** A run of words: unchanged, added in the newer text, or removed from the older one. */
export interface Segment {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export type RedlineItem =
  /** A heading or paragraph, its words marked where they changed. */
  | { type: 'block'; heading: boolean; changed: boolean; segments: Segment[] }
  /** Unchanged sections (a heading and what follows it), or paragraphs in a changed one, folded. */
  | { type: 'fold'; unit: 'section' | 'paragraph'; count: number };

interface Row {
  heading: boolean;
  changed: boolean;
  segments: Segment[];
}

const sameBlock = (a: TextBlock, b: TextBlock) =>
  a.heading === b.heading && a.text === b.text;

/** Two versions of one block, word by word. */
function wordDiff(before: string, after: string): Segment[] {
  const out: Segment[] = [];
  const push = (kind: Segment['kind'], text: string) => {
    if (text) out.push({ kind, text });
  };
  for (const p of diffWords(before, after)) {
    if (!p.added && !p.removed) {
      push('same', p.value);
      continue;
    }
    // Spaces at either end stay outside the marks (the page collapses doubled spaces).
    const [, lead, words, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(p.value) ?? [];
    push('same', lead);
    push(p.added ? 'added' : 'removed', words);
    push('same', trail);
  }
  return out;
}

/** Whether two blocks read as one block changed in place (rather than one removed, one added). */
function similar(a: TextBlock, b: TextBlock): boolean {
  if (a.heading !== b.heading) return false;
  if (a.heading) return true; // a heading where a heading was: renamed
  const kept = diffWords(a.text, b.text)
    .filter((p) => !p.added && !p.removed)
    .reduce((n, p) => n + p.value.replace(/\s/g, '').length, 0);
  const longer = Math.max(
    a.text.replace(/\s/g, '').length,
    b.text.replace(/\s/g, '').length,
  );
  return longer === 0 || kept / longer >= 0.3;
}

/** Every block of `after`, and every block only `before` had, in reading order. */
function rows(before: TextBlock[], after: TextBlock[]): Row[] {
  const out: Row[] = [];
  const whole = (b: TextBlock, kind: 'added' | 'removed') =>
    out.push({
      heading: b.heading,
      changed: true,
      segments: [{ kind, text: b.text }],
    });
  /** A run of removed blocks where a run of added ones now stands. */
  const merge = (removed: TextBlock[], added: TextBlock[]) => {
    let i = 0;
    let j = 0;
    while (i < removed.length && j < added.length) {
      const r = removed[i];
      const a = added[j];
      if (similar(r, a)) {
        out.push({
          heading: a.heading,
          changed: true,
          segments: wordDiff(r.text, a.text),
        });
        i++;
        j++;
      } else if (r.heading && !a.heading) {
        // A removed section comes after what was added to the section before it.
        whole(a, 'added');
        j++;
      } else if (a.heading && !r.heading) {
        // What was removed from this section comes before a section added after it.
        whole(r, 'removed');
        i++;
      } else {
        whole(r, 'removed');
        whole(a, 'added');
        i++;
        j++;
      }
    }
    for (const b of removed.slice(i)) whole(b, 'removed');
    for (const b of added.slice(j)) whole(b, 'added');
  };
  let removed: TextBlock[] = [];
  let added: TextBlock[] = [];
  for (const part of diffArrays(before, after, { comparator: sameBlock })) {
    if (part.removed) removed.push(...part.value);
    else if (part.added) added.push(...part.value);
    else {
      merge(removed, added);
      removed = [];
      added = [];
      for (const b of part.value)
        out.push({
          heading: b.heading,
          changed: false,
          segments: [{ kind: 'same', text: b.text }],
        });
    }
  }
  merge(removed, added);
  return out;
}

/**
 * What changed from `before` to `after` (both Markdown), for reading: each changed paragraph with
 * its words marked, under its section's heading; unchanged sections, and unchanged paragraphs in a
 * changed section, folded into a count. Empty when nothing changed.
 */
export function redline(before: string, after: string): RedlineItem[] {
  const all = rows(legalTextBlocks(before), legalTextBlocks(after));
  // Sections: a heading and everything up to the next one (anything before the first heading is
  // a section of its own).
  const sections: Row[][] = [];
  for (const row of all) {
    if (row.heading || sections.length === 0) sections.push([]);
    sections[sections.length - 1].push(row);
  }
  const items: RedlineItem[] = [];
  const fold = (unit: 'section' | 'paragraph') => {
    const last = items.at(-1);
    if (last?.type === 'fold' && last.unit === unit) last.count += 1;
    else items.push({ type: 'fold', unit, count: 1 });
  };
  for (const section of sections) {
    if (!section.some((r) => r.changed)) {
      fold('section');
      continue;
    }
    for (const row of section) {
      if (row.changed || row.heading) items.push({ type: 'block', ...row });
      else fold('paragraph');
    }
  }
  return items.some((i) => i.type === 'block') ? items : [];
}

/** "⋯ 1 unchanged section ⋯", "⋯ 3 unchanged paragraphs ⋯". */
export const foldLabel = (item: Extract<RedlineItem, { type: 'fold' }>) =>
  `⋯ ${item.count} unchanged ${item.unit}${item.count === 1 ? '' : 's'} ⋯`;
