'use client';

import {
  type CSSProperties,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { StorySummary } from '@/lib/browse';
import {
  type CardLayout,
  type ColumnHeights,
  GAP,
  layoutFor,
  spanFor,
} from '@/lib/masonry';
import { StoryCard } from './story-card';

/** The column count the stylesheet is using now (`.masonry` in global.css). */
function currentColumns(): 1 | 2 | 3 {
  if (window.matchMedia('(min-width: 1024px)').matches) return 3;
  if (window.matchMedia('(min-width: 640px)').matches) return 2;
  return 1;
}

/**
 * Layouts for `more` cards added after the ones on screen in `ul` (laid out as `layouts`, ending
 * at the predicted `heights`). They continue from the measured bottoms of the columns on screen,
 * predicted ones otherwise, so each new card goes under the column that is really shortest and
 * the cards already there keep their columns. Browse's next pages and favourites' "Show more".
 */
export function continueLayout(
  ul: HTMLUListElement | null,
  layouts: CardLayout[],
  heights: ColumnHeights,
  more: StorySummary[],
): { cards: CardLayout[]; heights: ColumnHeights } {
  const n = currentColumns();
  if (n === 1 || !ul) return layoutFor(more, heights);
  const top = ul.getBoundingClientRect().top;
  const measured = Array(n).fill(0);
  layouts.forEach((layout, i) => {
    const li = ul.children[i] as HTMLElement | undefined;
    if (!li) return;
    const bottom = li.getBoundingClientRect().bottom - top + GAP;
    const col = layout.col[n];
    measured[col] = Math.max(measured[col], bottom);
  });
  return layoutFor(more, { ...heights, [n]: measured });
}

interface Laid {
  cards: StorySummary[];
  layouts: CardLayout[];
  heights: ColumnHeights;
}

function laidFrom(cards: StorySummary[]): Laid {
  const layout = layoutFor(cards);
  return { cards, layouts: layout.cards, heights: layout.heights };
}

/**
 * Story cards in browse's balanced masonry (D55, lib/masonry.ts, `.masonry` in global.css): each
 * card at its media's own clamped shape (D53), a written story without a picture as text only,
 * the list in date order, each card in the column the server predicted. In the browser the
 * measured heights replace the predicted spans. Browse passes the layouts it continues page by
 * page; favourites (Joel, 2026-10-31: the same display as browse) is laid out here, and cards
 * added after the ones on screen continue from them as browse's pages do (`continueLayout`).
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
  const [laid, setLaid] = useState<Laid | null>(() =>
    layouts ? null : laidFrom(cards),
  );
  // Cards added after the ones laid out continue from their measured columns, before paint: the
  // list shows the cards laid out so far until then. Any other change is laid out afresh.
  useLayoutEffect(() => {
    if (layouts || laid?.cards === cards) return;
    const appended =
      laid &&
      laid.cards.length < cards.length &&
      laid.cards.every((c, i) => c.id === cards[i].id);
    if (!appended) {
      setLaid(laidFrom(cards));
      return;
    }
    const next = continueLayout(
      list.current,
      laid.layouts,
      laid.heights,
      cards.slice(laid.cards.length),
    );
    setLaid({
      cards,
      layouts: [...laid.layouts, ...next.cards],
      heights: next.heights,
    });
  }, [cards, layouts, laid, list]);
  const shown = layouts ? cards : (laid?.cards ?? []);
  const placed = layouts ?? laid?.layouts ?? [];

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
  }, [shown, list]);

  return (
    <ul ref={list} className="masonry">
      {shown.map((story, i) => {
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
