'use client';

import { useEffect, useState } from 'react';
import { Text, TextLink } from '@heisreal/web-ui';
import { newReference } from '@/lib/reference';

/**
 * "Reference: 0193…" with a Copy button, under every error the person sees (LG-1, Joel 22 Nov
 * 2026: "every error must have a reference and reference be unique"). It means nothing to them;
 * we search the logs for it. `reference` is the failed call's (its `traceparent` trace id, so the
 * API's event has the same `ref`); without one (a page that couldn't be made, a crash in the
 * page) a fresh UUID v7 is made in the browser when the message appears, which still dates the
 * error to the millisecond (LG-1b, LG-1c). Plain words, no codes or status (the no-codes rule).
 */
export function ErrorReference({
  reference,
  onReference,
  copy: canCopy = true,
  as,
  className,
}: {
  reference?: string;
  /** Told the reference once there is one (the error screen reports a crash with it). */
  onReference?: (reference: string) => void;
  /**
   * The Copy button; off where the line sits on a picture (a card's player), whose overlay
   * takes no presses. The reference can still be selected.
   */
  copy?: boolean;
  /** `span` inside another line of text. */
  as?: 'p' | 'span';
  className?: string;
}) {
  const [made, setMade] = useState<string>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!reference) setMade(newReference());
  }, [reference]);
  const shown = reference ?? made;
  useEffect(() => {
    if (shown) onReference?.(shown);
    // Once per reference: `onReference` is read when it appears, not watched.
  }, [shown]);
  if (!shown) return null;
  const copy = () => {
    navigator.clipboard?.writeText(shown).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <Text size="small" tone="quiet" data-reference="" className={className}>
      Reference:{' '}
      <span className="break-all" data-reference-value="">
        {shown}
      </span>{' '}
      <TextLink asChild touch className="min-w-11 justify-center">
        <button type="button" onClick={copy} aria-label="Copy the reference">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </TextLink>
    </Text>
  );
}
