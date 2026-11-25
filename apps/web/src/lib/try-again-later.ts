// People never see error codes or backend state (Joel, 2026-11-09: "dont reveal to the users the
// error code from the backed or its error type/ state, just say try again later"). Whatever went
// wrong on our side (a server error, a technical refusal, a rate limit), web says only this; the
// logs keep the detail. Three things differ: messages about the person's own input (too long, a
// limit reached); the database restarting, which web names with when to try again (Joel,
// 2026-11-09: "reveal when compute is restarting with a count down but for any other error it
// should be generic"; components/restarting/restarting-message.tsx); and a call that got no answer
// at all, `NO_ANSWER` below (LG-13c, Joel 25 Nov 2026).

/** The one message for anything that went wrong on our side. */
export const TRY_AGAIN_LATER = 'Something went wrong. Please try again later.';

/**
 * A call from the browser that got no answer (offline, a timeout; LG-9a). Not sensitive, so it
 * says what happened (LG-13c, Joel 25 Nov 2026: "use conditional messages based on what the error
 * is if non sensitive, if the error is sensitive then output a generic error").
 */
export const NO_ANSWER =
  'We couldn’t reach He Is Real. Check your internet connection and try again.';

/** `NO_ANSWER` or `TRY_AGAIN_LATER`, then `kept` if given ("Your story is saved."). */
export function problemText(
  noAnswer: boolean | undefined,
  kept?: string,
): string {
  const text = noAnswer ? NO_ANSWER : TRY_AGAIN_LATER;
  return kept ? `${text} ${kept}` : text;
}
