import type { ComponentProps } from 'react';
import { Button, Notice } from '@heisreal/web-ui';
import { problemText } from '@/lib/try-again-later';
import { ErrorReference } from './error-reference';

/**
 * "Something went wrong. Please try again later." as a notice, with `kept` after it if given
 * ("Your story is saved."), and its reference line under it (LG-1): the failed call's
 * `reference`, or a fresh one made in the browser. When the call got no answer (`noAnswer`), it
 * says "We couldn't reach He Is Real. Check your internet connection and try again." instead,
 * with a *Try again* button (`onTryAgain`) before the reference line (LG-13c, Joel 25 Nov 2026).
 */
export function TryAgainLaterNotice({
  reference,
  kept,
  noAnswer,
  onTryAgain,
  kind = 'danger',
  children,
  ...props
}: Omit<ComponentProps<typeof Notice>, 'kind' | 'as'> & {
  reference?: string;
  kept?: string;
  noAnswer?: boolean;
  onTryAgain?: () => void;
  kind?: ComponentProps<typeof Notice>['kind'];
}) {
  return (
    <Notice kind={kind} {...props}>
      <p>{problemText(noAnswer, kept)}</p>
      {noAnswer && onTryAgain && (
        <Button variant="outline" wrap className="mt-3" onClick={onTryAgain}>
          Try again
        </Button>
      )}
      <ErrorReference reference={reference} className="mt-1" />
      {children}
    </Notice>
  );
}
