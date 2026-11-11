'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { tryAgainIn } from '@/lib/restarting';

// While the database restarts (SurrealDB on Spot; Joel, 2026-11-07), web says so, with when to
// try again: the one error web names (Joel, 2026-11-09: "reveal when compute is restarting with a
// count down but for any other error it should be generic").

export const RESTARTING_HEADING = 'Our compute is currently restarting';

/**
 * "Please try again in about N minutes.", counted down in the browser from `seconds` (the API's
 * estimate, read by web's server or by api-user's client), then "Please try again later." once it
 * has run out. The server's HTML has the estimate as it was, so it reads right without JavaScript.
 */
function useTryAgainIn(seconds: number): string {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const deadline = Date.now() + seconds * 1000;
    setLeft(seconds);
    const timer = setInterval(() => {
      const now = Math.max(0, (deadline - Date.now()) / 1000);
      setLeft(now);
      if (now === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [seconds]);
  return tryAgainIn(left);
}

/**
 * The calm message while the database restarts, as a page's whole content (`page`) or as a short
 * note in place of a section (`inline`).
 */
export function RestartingMessage({
  seconds,
  variant,
}: {
  seconds: number;
  variant: 'page' | 'inline';
}) {
  const when = useTryAgainIn(seconds);
  if (variant === 'inline') {
    return (
      <p
        role="status"
        data-restarting=""
        className="mx-auto max-w-measure rounded-xl bg-raised px-4 py-6 text-center text-secondary-text"
      >
        {RESTARTING_HEADING}. <span data-restarting-estimate="">{when}</span>
      </p>
    );
  }
  return (
    <main
      id="main"
      data-restarting=""
      className="mx-auto flex w-full max-w-measure flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      <h1 className="text-3xl font-semibold">{RESTARTING_HEADING}</h1>
      <p role="status" className="text-secondary-text">
        <span data-restarting-estimate="">{when}</span>
      </p>
    </main>
  );
}

// The browser's own calls (api-user, api-admin) report a restart here; RestartingNotice shows it.
let reported: { seconds: number; at: number } | null = null;
const listeners = new Set<() => void>();

/** Called by api-user's client when an answer is `503 service_restarting`. */
export function reportRestarting(seconds: number): void {
  reported = { seconds, at: Date.now() };
  for (const listener of listeners) listener();
}

/**
 * Called by api-user's client on any successful answer (from api-user or api-admin): the
 * database is back, so the notice goes. It lives in the root layout, so it stays across client
 * navigation until then.
 */
export function clearRestarting(): void {
  if (!reported) return;
  reported = null;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * After an action (a save, a submit, an upload) was answered "restarting": the same message,
 * fixed at the bottom of the screen, so nothing on the page moves and nothing the person typed
 * is lost. They can try again when it says. It goes after the next successful answer.
 */
export function RestartingNotice() {
  const restart = useSyncExternalStore(
    subscribe,
    () => reported,
    () => null,
  );
  if (!restart) return null;
  return (
    <div
      data-restarting-notice=""
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div className="pointer-events-auto mx-auto w-full max-w-[32rem] rounded-2xl border border-border-hover bg-card p-4 text-card-foreground shadow-2xl">
        <NoticeText key={restart.at} seconds={restart.seconds} />
      </div>
    </div>
  );
}

function NoticeText({ seconds }: { seconds: number }) {
  return (
    <p role="status" className="text-[0.9375rem]">
      <RestartingText seconds={seconds} />
    </p>
  );
}

/**
 * The restart in one sentence, counted down from `seconds`, for a message of its own (the notice
 * at the bottom of the screen, a share step's problem after a submit or an upload): "Our compute
 * is currently restarting. Please try again in about N minutes.", then "… Please try again
 * later." once it has run out, followed by `kept` if given (e.g. "Your story is saved.").
 */
export function RestartingText({
  seconds,
  kept,
}: {
  seconds: number;
  kept?: string;
}) {
  const when = useTryAgainIn(seconds);
  return (
    <>
      {RESTARTING_HEADING}. <span data-restarting-estimate="">{when}</span>
      {kept ? ` ${kept}` : null}
    </>
  );
}
