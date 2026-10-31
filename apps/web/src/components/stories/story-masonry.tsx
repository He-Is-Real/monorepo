'use client';

import {
  type CSSProperties,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { StorySummary } from '@/lib/browse';
import { type CardLayout, layoutFor, spanFor } from '@/lib/masonry';
import { StoryCard } from './story-card';

/**
 * Story cards in browse's balanced masonry (D55, lib/masonry.ts, `.masonry` in global.css): each
 * card at its media's own clamped shape (D53), a written story without a picture as text only,
 * the list in date order, each card in the column the server predicted. In the browser the
 * measured heights replace the predicted spans. Browse passes the layouts it continues page by
 * page; favourites (Joel, 2026-10-31: the same display as browse) is laid out here in one go.
 */
export function StoryMasonry({
  cards,
  layouts,
  listRef,
  headingLevel,
}: {
  cards: StorySummary[];
  /** Each card's column and span; laid out from `cards` when not given. */
  layouts?: CardLayout[];
  listRef?: RefObject<HTMLUListElement | null>;
  headingLevel?: 2 | 3;
}) {
  const own = useRef<HTMLUListElement>(null);
  const list = listRef ?? own;
  // Each card goes into the shortest column in turn, so the cards already on screen keep their
  // columns when more are added after them.
  const computed = useMemo(
    () => (layouts ? null : layoutFor(cards).cards),
    [cards, layouts],
  );
  const placed = layouts ?? computed ?? [];

  // Measured heights replace the predicted spans (multi-column layouts only use them).
  useLayoutEffect(() => {
    const ul = list.current;
    if (!ul || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const li = (entry.target as HTMLElement).parentElement;
        li?.style.setProperty(
          '--m',
          String(spanFor(entry.target.getBoundingClientRect().height)),
        );
      }
    });
    for (const li of Array.from(ul.children))
      if (li.firstElementChild) observer.observe(li.firstElementChild);
    return () => observer.disconnect();
  }, [cards, list]);

  return (
    <ul ref={list} className="masonry">
      {cards.map((story, i) => {
        const { col, span } = placed[i];
        const style = {
          '--c2': col[2] + 1,
          '--s2': span[2],
          '--c3': col[3] + 1,
          '--s3': span[3],
        } as CSSProperties;
        return (
          <li key={story.id} style={style}>
            <StoryCard
              story={story}
              headingLevel={headingLevel}
              eager={i < 3}
            />
          </li>
        );
      })}
    </ul>
  );
}
