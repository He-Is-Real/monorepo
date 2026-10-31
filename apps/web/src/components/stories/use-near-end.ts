'use client';

import { useEffect, useRef, useState } from 'react';

/** How far before the end of a list the next page starts loading: "near the end". */
const NEAR_END = '0px 0px 800px 0px';

/**
 * Loading more as the reader nears the end of a list (browse and favourites; Joel, 2026-10-31:
 * no page cap). Put `sentinel` on an empty element after the list: while `active`, `onNear`
 * runs when it comes within NEAR_END of the screen. The observer is made again whenever
 * `active` or `round` changes, and a new observer reports at once, so a list that still ends on
 * screen after a load (a short page, a tall screen) goes on loading without a scroll.
 *
 * `auto` is false where the browser has no IntersectionObserver: the list then shows its
 * "Show more" button instead. The caller keeps one request at a time and stops while a load
 * has failed (pass `active` false), so a failure waits for Try again rather than looping.
 */
export function useNearEnd({
  active,
  round,
  onNear,
}: {
  active: boolean;
  /** Changes with each page loaded, e.g. the page count. */
  round: unknown;
  onNear: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [auto, setAuto] = useState(true);
  const near = useRef(onNear);
  useEffect(() => {
    near.current = onNear;
  });

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setAuto(false);
      return;
    }
    const el = sentinel.current;
    if (!el || !active) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) near.current();
      },
      { rootMargin: NEAR_END },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, round]);

  return { sentinel, auto };
}
