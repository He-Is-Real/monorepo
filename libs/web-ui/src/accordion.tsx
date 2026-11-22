'use client';

import * as React from 'react';
import { cn } from './cn';

export interface AccordionItem {
  /** Unique on the page; used for the element ids. */
  id: string;
  /** The question: the words on the button. */
  title: React.ReactNode;
  /** The answer, shown when open: a paragraph's words (inline content). */
  content: React.ReactNode;
}

/**
 * Questions that open one at a time (MG-2 B, Joel, 21 November 2026: the FAQ page keeps its
 * look): a bordered box per question with a chevron on the right that turns when open. The
 * WAI-ARIA accordion pattern: each question is a button inside a heading (`headingLevel`, 3 by
 * default), controlling a labelled region. Answers start closed but are in the server's HTML
 * (hidden, not left out), so search engines see them. Each opens on its own. Native buttons give
 * Enter, Space and Tab. For a single "show more", use `Disclosure`.
 */
export function Accordion({
  items,
  headingLevel = 3,
  idPrefix = 'accordion',
  className,
}: {
  items: readonly AccordionItem[];
  headingLevel?: 2 | 3 | 4;
  /** Starts every element id: `${idPrefix}-${item.id}` (the button), `…-answer` (the region). */
  idPrefix?: string;
  /** Layout classes for the list. */
  className?: string;
}) {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const Heading = `h${headingLevel}` as const;

  return (
    <ul data-slot="accordion" className={cn('flex flex-col gap-3', className)}>
      {items.map(({ id, title, content }) => {
        const expanded = open.has(id);
        const own = `${idPrefix}-${id}`;
        return (
          <li
            key={id}
            className="rounded-xl border border-border bg-card transition-colors hover:border-border-hover"
          >
            <Heading className="text-base font-semibold">
              <button
                type="button"
                id={own}
                aria-expanded={expanded}
                aria-controls={`${own}-answer`}
                onClick={() => toggle(id)}
                className="flex min-h-11 w-full items-center justify-between gap-4 rounded-xl px-5 py-4 text-left sm:px-6"
              >
                <span>{title}</span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className={`size-5 shrink-0 text-secondary-text transition-transform ${expanded ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </Heading>
            <div
              id={`${own}-answer`}
              role="region"
              aria-labelledby={own}
              hidden={!expanded}
              className="px-5 pb-5 sm:px-6"
            >
              <p className="text-[0.9375rem] leading-relaxed text-secondary-text">
                {content}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
