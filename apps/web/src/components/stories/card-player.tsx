'use client';

import { type CSSProperties, useEffect, useId, useRef } from 'react';
import { connectPlayer } from '@/lib/player-js';
import { PLAYER_ALLOW } from './story-media';

// A video or audio card's media area (story-card.tsx): Bunny's player itself, as on the story
// page, with Bunny's own thumbnail and play button (Joel, 2026-11-09: no picture or play button of
// our own over it). Its link comes with the card (`playbackUrl`, "Cards A"). Nothing plays on its
// own; one card plays at a time on the whole page: when one starts, Bunny's player control API
// (lib/player-js.ts) pauses the others. Without JavaScript the players still show and play;
// only the one-at-a-time rule needs it.

/** The cards' players on the page now (home's and browse's cards share them). */
const players = new Map<string, { pause: () => void }>();

export function CardPlayer({
  src,
  title,
  format,
  aspect,
}: {
  /** The signed player link with autoplay off (story-media.tsx's playerSrc). */
  src: string;
  title: string;
  format: 'video' | 'audio';
  /** The media box's aspect ratio: the player fills the box. */
  aspect: number;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const player = connectPlayer(el, () => {
      for (const [other, p] of players) if (other !== id) p.pause();
    });
    players.set(id, player);
    return () => {
      players.delete(id);
      player.disconnect();
    };
  }, [id, src]);

  // Hidden while playing (story-view's Related cards are display: none below 1024 px, so a tablet
  // rotating would leave it playing out of sight): pause it. A hidden box has no client rects.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (el.getClientRects().length === 0) players.get(id)?.pause();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [id]);

  // Never shorter than the player's controls need (a 2:1 box on a phone is 144 px), in rem as
  // lib/masonry.ts predicts it (CARD.playerMinHeight).
  const style: CSSProperties = {
    aspectRatio: String(aspect),
    minHeight: 'var(--card-player-min)',
    minWidth: 0, // or aspect-ratio turns the min-height into a wider minimum width
  };
  return (
    <div
      ref={box}
      data-card-media=""
      data-card-player=""
      className="relative w-full shrink-0 overflow-hidden bg-black"
      style={style}
    >
      <iframe
        ref={frame}
        src={src}
        title={`${format === 'video' ? 'Video' : 'Audio'}: ${title}`}
        allow={PLAYER_ALLOW}
        allowFullScreen
        loading="lazy"
        className="absolute inset-0 block h-full w-full border-0"
      />
    </div>
  );
}
