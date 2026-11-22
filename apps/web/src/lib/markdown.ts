import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { proseClasses } from '@heisreal/web-ui';

// D125 (Joel, 2026-10-30; plan 4e): the one Markdown renderer for the legal texts: the privacy
// notice and terms of use on /privacy and /terms (and their earlier versions), the testimony and
// social media sharing consents where people agree to them, and the admin's live preview at
// /admin/consent, so what an admin previews is exactly what everyone reads. markdown-it with raw HTML off: headings, paragraphs, **bold**,
// *italic*, lists, "> " notes, links, tables and `code`. No images, and links only to https:,
// mailto: and this site. Admins are trusted (vetted staff), so nothing else is scanned.
// Browser-safe: the admin's preview renders in the browser, the pages on the server.

/** https:, mailto:, a path on this site, or a #fragment: nothing else becomes a link. */
const SAFE_LINK = /^(https:\/\/|mailto:|\/(?!\/)|#)/i;

// The site's looks for each element: the library's prose (TX-7 A keeps them out of page code).
const CLASS = proseClasses;

/** The words of an inline token, without marks. */
const plain = (inline: Token | undefined): string =>
  (inline?.children ?? [])
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content)
    .join('');

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export interface RenderOptions {
  /**
   * The level the text's top headings take: 2 under a page's own h1 (the default), 3 under a
   * section's h2 (the submit flow's steps).
   */
  topLevel?: number;
}

function create(): MarkdownIt {
  const md = new MarkdownIt('default', {
    html: false,
    linkify: false,
    typographer: false,
  });
  md.disable(['image']);
  md.validateLink = (url) => SAFE_LINK.test(url.trim());

  // Ids for headings ("## Cookies {#cookies}" names its anchor; else a slug of its words),
  // levels from the page's, and each table's caption from the heading above it.
  md.core.ruler.push('legal_structure', (state) => {
    const tokens = state.tokens;
    const top = Math.min(
      ...tokens
        .filter((t) => t.type === 'heading_open')
        .map((t) => Number(t.tag.slice(1))),
    );
    const topLevel = (state.env as RenderOptions).topLevel ?? 2;
    const used = new Set<string>();
    let lastHeading = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'heading_open' || t.type === 'heading_close') {
        const level = Math.min(Number(t.tag.slice(1)) - top + topLevel, 6);
        t.tag = `h${level}`;
      }
      if (t.type === 'heading_open') {
        const inline = tokens[i + 1];
        const last = inline.children?.at(-1);
        let id = '';
        const named =
          last?.type === 'text' && /\s*\{#([\w-]+)\}\s*$/.exec(last.content);
        if (named && last) {
          id = named[1];
          last.content = last.content.slice(0, named.index);
        }
        lastHeading = plain(inline).trim();
        id ||= slug(lastHeading);
        if (id && !used.has(id)) {
          used.add(id);
          t.attrSet('id', id);
        }
        t.attrSet('class', CLASS[t.tag as 'h2' | 'h3'] ?? CLASS.h4);
        if (Number(t.tag.slice(1)) >= 2) t.attrJoin('class', 'scroll-mt-6');
      }
      if (t.type === 'table_open') t.meta = { caption: lastHeading };
    }
    // Tables: each body cell names its column (data-label), and a row's first cell is its header.
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'table_open') continue;
      const labels: string[] = [];
      let body = false;
      let row = -1;
      let cell = 0;
      for (
        let j = i + 1;
        j < tokens.length && tokens[j].type !== 'table_close';
        j++
      ) {
        const t = tokens[j];
        if (t.type === 'th_open') labels.push(plain(tokens[j + 1]).trim());
        if (t.type === 'tbody_open') body = true;
        if (t.type === 'tr_open') {
          cell = 0;
          if (body) row++;
          t.attrSet('role', 'row');
          if (body) {
            t.attrSet(
              'class',
              `${CLASS.tr} ${row ? CLASS.trBorder : CLASS.trFirst}`,
            );
          }
        }
        if (t.type === 'thead_open') {
          t.attrSet('role', 'rowgroup');
          t.attrSet('class', CLASS.thead);
        }
        if (t.type === 'tbody_open') {
          t.attrSet('role', 'rowgroup');
          t.attrSet('class', CLASS.tbody);
        }
        if (t.type === 'th_open' && !body) {
          t.attrs = [];
          t.attrSet('role', 'columnheader');
          t.attrSet('scope', 'col');
          t.attrSet('class', CLASS.th);
        }
        if (t.type === 'td_open' && body) {
          t.attrs = [];
          if (cell === 0) {
            t.tag = 'th';
            t.attrSet('role', 'rowheader');
            t.attrSet('scope', 'row');
            t.attrSet('class', CLASS.rowheader);
          } else {
            t.attrSet('role', 'cell');
            t.attrSet('data-label', labels[cell] ?? '');
            t.attrSet('class', CLASS.cell);
          }
          cell++;
        }
        if (t.type === 'td_close' && body && cell === 1) t.tag = 'th';
      }
    }
    for (const t of tokens) {
      const cls =
        t.type === 'bullet_list_open'
          ? CLASS.ul
          : t.type === 'ordered_list_open'
            ? CLASS.ol
            : t.type === 'list_item_open'
              ? CLASS.li
              : t.type === 'blockquote_open'
                ? CLASS.blockquote
                : null;
      if (cls) t.attrSet('class', cls);
      for (const c of t.children ?? []) {
        if (c.type === 'strong_open') c.attrSet('class', CLASS.strong);
        if (c.type === 'code_inline') c.attrSet('class', CLASS.code);
        if (c.type === 'link_open') {
          c.attrSet('class', CLASS.a);
          if (/^https:/i.test(c.attrGet('href') ?? ''))
            c.attrSet('rel', 'noreferrer');
        }
      }
    }
  });

  const escape = md.utils.escapeHtml;
  md.renderer.rules.table_open = (tokens, idx) => {
    const caption = (tokens[idx].meta as { caption?: string } | null)?.caption;
    // A focusable, named region, so keyboard users can scroll a table too wide for its box.
    return `<div role="region" tabindex="0" aria-label="${escape(caption || 'Table')}" class="${CLASS.tableWrap}" data-legal-table=""><table role="table" class="${CLASS.table}">${
      caption ? `<caption class="sr-only">${escape(caption)}</caption>` : ''
    }\n`;
  };
  md.renderer.rules.table_close = () => '</table></div>\n';
  // Code blocks: the words, escaped, in the site's block style; no language classes.
  const block = (content: string) =>
    `<pre class="${CLASS.pre}"><code>${escape(content)}</code></pre>\n`;
  md.renderer.rules.fence = (tokens, idx) => block(tokens[idx].content);
  md.renderer.rules.code_block = (tokens, idx) => block(tokens[idx].content);
  return md;
}

let instance: MarkdownIt | undefined;

/**
 * A legal text's Markdown as HTML: markdown-it escapes any HTML in it (`html: false`) and keeps
 * only safe links, so the result can be set as a page's HTML.
 */
export function renderLegalMarkdown(
  markdown: string,
  options: RenderOptions = {},
): string {
  instance ??= create();
  return instance.render(markdown, { ...options });
}

/** One block of a legal text as plain words (lib/redline.ts compares these). */
export interface TextBlock {
  /** A heading (a section starts here). */
  heading: boolean;
  text: string;
}

/**
 * A legal text's Markdown as plain blocks, in order: each heading, paragraph, list item (with its
 * bullet or number) and table row (its cells joined), without marks, links' addresses or heading
 * anchors. What "what changed" compares, so a moved link or a bold word reads as words.
 */
export function legalTextBlocks(markdown: string): TextBlock[] {
  instance ??= create();
  const tokens = instance.parse(markdown, {});
  const blocks: TextBlock[] = [];
  const words = (t: Token) =>
    (t.children ?? [])
      .map((c) =>
        c.type === 'text' || c.type === 'code_inline'
          ? c.content
          : c.type === 'softbreak' || c.type === 'hardbreak'
            ? ' '
            : '',
      )
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  let heading = false;
  /** Open lists: the next item's number (null for bullets). */
  const lists: (number | null)[] = [];
  let bullet = '';
  let row: string[] | null = null;
  for (const t of tokens) {
    switch (t.type) {
      case 'heading_open':
        heading = true;
        break;
      case 'heading_close':
        heading = false;
        break;
      case 'bullet_list_open':
        lists.push(null);
        break;
      case 'ordered_list_open':
        lists.push(Number(t.attrGet('start') ?? 1));
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop();
        break;
      case 'list_item_open': {
        const n = lists.at(-1);
        bullet = n == null ? '• ' : `${n}. `;
        if (n != null) lists[lists.length - 1] = n + 1;
        break;
      }
      case 'tr_open':
        row = [];
        break;
      case 'tr_close':
        if (row?.some(Boolean))
          blocks.push({ heading: false, text: row.join(' · ') });
        row = null;
        break;
      case 'inline': {
        const text = words(t);
        if (row) row.push(text);
        else if (text) {
          blocks.push({ heading, text: `${bullet}${text}` });
          bullet = '';
        }
        break;
      }
      case 'fence':
      case 'code_block':
        if (t.content.trim())
          blocks.push({ heading: false, text: t.content.trim() });
        break;
    }
  }
  return blocks;
}
