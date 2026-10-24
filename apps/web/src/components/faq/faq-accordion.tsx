'use client';

import { useState } from 'react';

export interface FaqItem {
  /** Unique on the page; used for the element ids. */
  id: string;
  question: string;
  answer: string;
}

/**
 * The WAI-ARIA accordion pattern: each question is a button inside a heading, controlling a
 * labelled region. Answers start collapsed but are always in the server's HTML (hidden, not
 * left out), so search engines see them (and the FAQPage JSON-LD repeats them). Each opens
 * independently. Native buttons give Enter, Space and Tab.
 */
export function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ul className="flex flex-col gap-3">
      {items.map(({ id, question, answer }) => {
        const expanded = open.has(id);
        return (
          <li
            key={id}
            className="rounded-xl border border-border bg-card transition-colors hover:border-border-hover"
          >
            <h3 className="text-base font-semibold">
              <button
                type="button"
                id={`faq-${id}`}
                aria-expanded={expanded}
                aria-controls={`faq-${id}-answer`}
                onClick={() => toggle(id)}
                className="flex min-h-11 w-full items-center justify-between gap-4 rounded-xl px-5 py-4 text-left sm:px-6"
              >
                <span>{question}</span>
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
            </h3>
            <div
              id={`faq-${id}-answer`}
              role="region"
              aria-labelledby={`faq-${id}`}
              hidden={!expanded}
              className="px-5 pb-5 sm:px-6"
            >
              <p className="max-w-measure text-[0.9375rem] leading-relaxed text-secondary-text">
                {answer}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
