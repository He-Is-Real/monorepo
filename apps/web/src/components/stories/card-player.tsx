'use client';

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { cardPlayer } from '@/app/stories/actions';
import { PLAYER_ALLOW } from './story-media';

// A video or audio card's media area (story-card.tsx): pressing it plays the story in place, in
// Bunny's player, in the same box (D55's measured spans stay right). The player link is signed
// on demand by a server action (cards never carry one). Playback starts from that press, never
// on its own. One card plays at a time, on the whole page. Without JavaScript the area is a
// plain link to the story, like the rest of the card.

// The card playing now, page-wide (home's and browse's cards share it).
let playing: string | null = null;
const listeners = new Set<() => void>();
function setPlaying(id: string | null) {
  playing = id;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const noSubscribe = () => () => undefined;

type State =
  | { status: 'idle' | 'loading' }
  | { status: 'playing'; src: string }
  | { status: 'error'; reason: 'gone' | 'unavailable' };

const MESSAGES = {
  gone: 'This story isn’t available any more.',
  unavailable: 'The player couldn’t load. Try again in a moment.',
} as const;

export function CardPlayer({
  slug,
  title,
  format,
  aspect,
  children,
}: {
  slug: string;
  title: string;
  format: 'video' | 'audio';
  /** The media box's aspect ratio: the player fills the same box. */
  aspect: number;
  /** The thumbnail or placeholder, with its play badge. */
  children: ReactNode;
}) {
  const id = useId();
  // False on the server and while hydrating: the no-JavaScript link until then.
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const active = useSyncExternalStore(
    subscribe,
    () => playing === id,
    () => false,
  );
  const [state, setState] = useState<State>({ status: 'idle' });
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const shown = active && state.status === 'playing' ? state.src : null;

  async function play() {
    if (state.status === 'loading') return;
    setPlaying(id);
    setState({ status: 'loading' });
    let result: Awaited<ReturnType<typeof cardPlayer>>;
    try {
      result = await cardPlayer(slug);
    } catch {
      result = { ok: false, reason: 'unavailable' }; // offline, server unreachable
    }
    setState(
      result.ok
        ? { status: 'playing', src: result.src }
        : { status: 'error', reason: result.reason },
    );
  }

  function stop() {
    returnFocus.current = true;
    if (playing === id) setPlaying(null);
    setState({ status: 'idle' });
  }

  // Into the player once it's there; back to the play button once it's closed.
  useEffect(() => {
    if (shown) frame.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      button.current?.focus();
    }
  }, [shown]);

  // Escape closes the player while focus is in this card (not inside the player's own frame:
  // its keys stay there). Closing is the only way out besides another card.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      const card = box.current?.closest('article');
      if (e.key === 'Escape' && card?.contains(document.activeElement)) stop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Unmounting (a new list) stops it for good.
  useEffect(
    () => () => {
      if (playing === id) setPlaying(null);
    },
    [id],
  );

  const kind = format === 'video' ? 'Video' : 'Audio';
  const style: CSSProperties = { aspectRatio: String(aspect) };
  const boxClass = 'relative w-full shrink-0 overflow-hidden bg-surface';

  if (!hydrated)
    return (
      <div data-card-media="" className={boxClass} style={style}>
        <a
          href={`/stories/${slug}`}
          tabIndex={-1}
          aria-hidden="true"
          className="block h-full w-full"
        >
          {children}
        </a>
      </div>
    );

  if (shown)
    return (
      <div
        ref={box}
        data-card-media=""
        className={`${boxClass} bg-black`}
        style={style}
      >
        <button
          type="button"
          onClick={stop}
          aria-label="Close player"
          className="absolute top-2 right-2 z-10 flex size-11 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white backdrop-blur-sm hover:bg-black/80"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="size-5 fill-none stroke-current"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <iframe
          ref={frame}
          src={shown}
          title={`${kind}: ${title}`}
          allow={`autoplay; ${PLAYER_ALLOW}`}
          allowFullScreen
          className="block h-full w-full border-0"
        />
      </div>
    );

  // Shown while this card is the one last pressed.
  const error =
    active && state.status === 'error' ? MESSAGES[state.reason] : null;
  return (
    <div ref={box} data-card-media="" className={boxClass} style={style}>
      <button
        ref={button}
        type="button"
        onClick={() => void play()}
        aria-label={`Play ${title}`}
        aria-busy={state.status === 'loading'}
        aria-describedby={error ? `${id}-error` : undefined}
        className="group/play block h-full w-full cursor-pointer outline-none focus-visible:outline-none"
      >
        {children}
        {/* A quiet scrim says “this plays” on hover and keyboard focus. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover/play:bg-black/15 group-focus-visible/play:bg-black/15 motion-reduce:transition-none"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-t-2xl ring-ring ring-inset group-focus-visible/play:ring-[3px]"
        />
        {state.status === 'loading' && (
          <span
            aria-hidden="true"
            className="absolute right-3 bottom-3 size-11 animate-spin rounded-full border-2 border-white/25 border-t-white motion-reduce:animate-none"
          />
        )}
      </button>
      {/* Always present, so screen readers hear the message when it appears. */}
      <p
        id={`${id}-error`}
        role="status"
        className={
          error
            ? 'pointer-events-none absolute inset-x-3 top-3 rounded-lg bg-black/75 px-3 py-2 text-sm leading-5 text-white backdrop-blur-sm'
            : 'sr-only'
        }
      >
        {error}
      </p>
    </div>
  );
}
