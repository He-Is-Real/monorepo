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
  layoutStyle,
  MASONRY_CSS,
  spanFor,
} from '@/lib/masonry';
import { StoryCard } from './story-card';

/** The column count the stylesheet is using now (MASONRY_CSS): the list's grid tracks. */
const columnsOf = (ul: HTMLUListElement) =>
  getComputedStyle(ul).gridTemplateColumns.split(' ').length;

/**
 * px on screen as px at the default 16 px text size, the masonry's own units (lib/masonry.ts):
 * the stylesheet sizes it in rem, so it scales with the reader's text size.
 */
const basePx = (px: number) =>
  (px * 16) / parseFloat(getComputedStyle(document.documentElement).fontSize);

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
  const n = ul ? columnsOf(ul) : 1;
  if ((n !== 2 && n !== 3) || !ul) return layoutFor(more, heights);
  const top = ul.getBoundingClientRect().top;
  const measured = Array(n).fill(0);
  layouts.forEach((layout, i) => {
    // The card, not its list item: the item fills its predicted rows (MASONRY_CSS).
    const card = ul.children[i]?.firstElementChild;
    if (!card) return;
    const bottom = basePx(card.getBoundingClientRect().bottom - top) + GAP;
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
 * Story cards in browse's balanced masonry (D55, lib/masonry.ts and its MASONRY_CSS): each
 * card at its media's own clamped shape (D53), a written story without a picture as text only,
 * the list in date order, each card in the column the server predicted, spanning the rows
 * predicted for the band of widths the list is in. In the browser the measured heights replace
 * the predicted spans. Browse passes the layouts it continues page by page; favourites (Joel,
 * 2026-10-31: the same display as browse) is laid out here, and cards added after the ones on
 * screen continue from them as browse's pages do (`continueLayout`).
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
          String(spanFor(basePx(entry.target.getBoundingClientRect().height))),
        );
      }
    });
    for (const li of Array.from(ul.children))
      if (li.firstElementChild) observer.observe(li.firstElementChild);
    return () => observer.disconnect();
  }, [shown, list]);

  return (
    <>
      {/* React puts it in the page's head, once however many lists render it. */}
      <style href="story-masonry" precedence="default">
        {MASONRY_CSS}
      </style>
      {/* Without JavaScript nothing is measured, so no predicted spans and nothing clipped:
          no size container, so the list stays one column in normal flow (MASONRY_CSS). */}
      <noscript>
        <style>{'.masonry-box{container-type:normal}'}</style>
      </noscript>
      <div className="masonry-box">
        <ul ref={list} className="masonry">
          {shown.map((story, i) => (
            <li key={story.id} style={layoutStyle(placed[i]) as CSSProperties}>
              <StoryCard
                story={story}
                headingLevel={headingLevel}
                eager={i < 3}
              />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
