'use client';

import { type HeartState, useHeart } from '@/lib/favourites';

// The heart (M2): a person's own favourite, private to them (founder, 2026-10-25): no counts,
// nobody else sees it. It shows for everyone, in the same place and size before and after the
// browser knows who is looking (D83), so nothing moves when it fills in. Signed out, pressing it
// opens sign-in and the heart is applied after (lib/favourites.ts). A toggle button: its name
// stays the same and `aria-pressed` says whether it's on. Without JavaScript it does nothing:
// personal parts need JavaScript (D83).

const FAILED = 'Your heart couldn’t be saved. Try again.';

function HeartIcon({ on, className }: { on: boolean; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`${className} stroke-current ${on ? 'fill-current' : 'fill-none'}`}
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.7 3.8 4.5 7.2 4.5c2 0 3.6 1.1 4.8 2.8 1.2-1.7 2.8-2.8 4.8-2.8 3.4 0 5.6 3.2 4.4 6.6-1.7 4.8-9.2 9.4-9.2 9.4z" />
    </svg>
  );
}

const pressed = (state: HeartState) => state === 'on';

/**
 * A card's heart, at the end of the card's top line (story-card.tsx), in the room the line keeps
 * for it, above the stretched title link; never over the picture or the player (Joel,
 * 2026-11-09). A quiet icon button in the card's colours, centred on the line: its 44 px target
 * reaches past the line's 20 px, into the card's padding, so the card's height doesn't change.
 */
export function CardHeart({
  storyId,
  title,
}: {
  storyId: string;
  title: string;
}) {
  const { state, failed, busy, press } = useHeart(storyId);
  const on = pressed(state);
  return (
    <>
      <button
        type="button"
        data-heart=""
        data-heart-state={state}
        aria-pressed={on}
        aria-busy={busy}
        aria-label={`Favourite: ${title}`}
        title={failed ? FAILED : undefined}
        onClick={press}
        className={`absolute top-[calc(0.5rem-var(--card-pad))] right-[calc(0.5rem-var(--card-pad))] z-10 flex size-11 items-center justify-center rounded-full bg-card transition-colors hover:bg-accent motion-reduce:transition-none ${
          on ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        } ${failed ? 'ring-2 ring-destructive' : ''}`}
      >
        <HeartIcon on={on} className="size-5" />
      </button>
      <span role="status" className="sr-only">
        {failed ? FAILED : ''}
      </span>
    </>
  );
}

/** The story page's heart, beside Share (mockups: "♡ Favourite"). */
export function StoryHeart({ storyId }: { storyId: string }) {
  const { state, failed, busy, press } = useHeart(storyId);
  const on = pressed(state);
  return (
    <>
      <button
        type="button"
        data-heart=""
        data-heart-state={state}
        aria-pressed={on}
        aria-busy={busy}
        title={failed ? FAILED : undefined}
        onClick={press}
        className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors hover:border-teal hover:bg-accent hover:text-foreground motion-reduce:transition-none ${
          on
            ? 'border-teal text-foreground'
            : 'border-border-hover text-secondary-text'
        } ${failed ? 'ring-2 ring-destructive' : ''}`}
      >
        <HeartIcon on={on} className={`size-4 ${on ? 'text-primary' : ''}`} />
        Favourite
      </button>
      <span role="status" className="sr-only">
        {failed ? FAILED : ''}
      </span>
    </>
  );
}
