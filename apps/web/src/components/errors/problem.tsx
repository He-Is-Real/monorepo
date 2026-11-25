import type { ReactNode } from 'react';
import { RestartingText } from '@/components/restarting/restarting-message';
import { isSystemError, ourSideMessage, plainMessage } from '@/lib/api-user';
import { referenceOf } from '@/lib/reference';
import { ErrorReference } from './error-reference';

/**
 * `text` and, when `err` is one of ours (anything shown only as "Something went wrong. Please try
 * again later."), its reference line under it (LG-1): the failed call's reference, or a fresh one.
 * An input refusal's own message has none: it's about what the person sent.
 */
export function withReference(text: string, err: unknown): ReactNode {
  if (!isSystemError(err)) return text;
  return (
    <>
      {text}
      <ErrorReference
        as="span"
        reference={referenceOf(err)}
        className="mt-1 block"
      />
    </>
  );
}

/**
 * Something on our side or the connection, as `ourSideMessage` (lib/api-user.ts): "We couldn't
 * reach He Is Real…" when the call got no answer, else "Something went wrong. Please try again
 * later." (LG-13c), then `kept` if given, with the reference line.
 */
export function ourSideProblem(err: unknown, kept?: string): ReactNode {
  return withReference(ourSideMessage(err, kept), err);
}

/** `plainMessage` (lib/api-user.ts) with its reference line when it is one of ours. */
export function plainProblem(
  err: unknown,
  fallback: string,
  kept?: string,
): ReactNode {
  return withReference(plainMessage(err, fallback, kept), err);
}

/** The database restarting (named, counted down) after `err`, with its reference line (LG-1). */
export function restartingProblem(
  err: unknown,
  seconds: number,
  kept?: string,
): ReactNode {
  return (
    <>
      <RestartingText seconds={seconds} kept={kept} />
      <ErrorReference
        as="span"
        reference={referenceOf(err)}
        className="mt-1 block"
      />
    </>
  );
}
