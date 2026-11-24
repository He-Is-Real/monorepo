import type { ComponentProps } from 'react';
import { Notice } from '@heisreal/web-ui';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';
import { ErrorReference } from './error-reference';

/**
 * "Something went wrong. Please try again later." as a notice, with `kept` after it if given
 * ("Your story is saved."), and its reference line under it (LG-1): the failed call's
 * `reference`, or a fresh one made in the browser.
 */
export function TryAgainLaterNotice({
  reference,
  kept,
  kind = 'danger',
  children,
  ...props
}: Omit<ComponentProps<typeof Notice>, 'kind' | 'as'> & {
  reference?: string;
  kept?: string;
  kind?: ComponentProps<typeof Notice>['kind'];
}) {
  return (
    <Notice kind={kind} {...props}>
      <p>{kept ? `${TRY_AGAIN_LATER} ${kept}` : TRY_AGAIN_LATER}</p>
      <ErrorReference reference={reference} className="mt-1" />
      {children}
    </Notice>
  );
}
