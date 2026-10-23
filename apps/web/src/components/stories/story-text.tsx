'use client';

import { useEffect, useRef, useState } from 'react';
import { previewCut } from '@/lib/story-preview';

/**
 * A story's text. Long text opens as a preview of about 600 characters, cut at a word, with a
 * "Continue reading" button that expands it in place and "Show less" to collapse it (Joel,
 * 2026-10-23, from the POC). The whole text is always in the HTML (search engines, find in
 * page once expanded, and without JavaScript: the noscript style shows it all). The server
 * renders the collapsed state, so hydration doesn't move anything.
 */
export function StoryText({
  id,
  paragraphs,
}: {
  id: string;
  paragraphs: string[];
}) {
  const cut = previewCut(paragraphs);
  const [expanded, setExpanded] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const collapsed = cut !== null && !expanded;
  const toggled = useRef(false);

  // After "Show less" the text above the button shrinks: keep the button (which keeps focus)
  // in view, so the reader isn't left further down the page.
  useEffect(() => {
    if (toggled.current && !expanded) {
      button.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [expanded]);

  // `hidden` (Tailwind's display: none, not the attribute) so the noscript style can override it.
  const rest = collapsed ? 'hidden' : undefined;
  return (
    <>
      <div
        id={id}
        className="mt-6 space-y-4 text-base leading-relaxed"
        data-collapsed={collapsed ? '' : undefined}
      >
        {paragraphs.map((p, i) => {
          if (!cut || i < cut.paragraph) return <p key={i}>{p}</p>;
          if (i === cut.paragraph && cut.offset > 0) {
            return (
              <p key={i}>
                {p.slice(0, cut.offset)}
                {collapsed && (
                  <span aria-hidden="true" data-story-toggle="">
                    …
                  </span>
                )}
                <span className={rest} data-story-rest="">
                  {p.slice(cut.offset)}
                </span>
              </p>
            );
          }
          return (
            <p key={i} className={rest} data-story-rest="">
              {p}
            </p>
          );
        })}
      </div>
      {cut && (
        <>
          <noscript>
            <style>
              {
                '[data-story-rest]{display:revert!important}[data-story-toggle]{display:none!important}'
              }
            </style>
          </noscript>
          <button
            ref={button}
            type="button"
            aria-expanded={expanded}
            aria-controls={id}
            data-story-toggle=""
            onClick={() => {
              toggled.current = true;
              setExpanded((e) => !e);
            }}
            className="mt-2 inline-flex min-h-11 min-w-11 items-center rounded-md px-1 -mx-1 font-medium text-link underline-offset-4 transition-colors outline-none hover:text-link-hover hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {expanded ? 'Show less' : 'Continue reading'}
          </button>
        </>
      )}
    </>
  );
}
