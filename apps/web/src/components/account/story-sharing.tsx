'use client';

import { useEffect, useRef, useState } from 'react';
import { LegalDocumentDetails } from '@/components/legal/legal-document-details';
import { LegalHtml } from '@/components/legal/legal-html';
import { Button } from '@/components/ui/button';
import {
  type ApiUser,
  ApiUserProblem,
  ApiUserUnavailable,
  newIdempotencyKey,
} from '@/lib/api-user';
import type { ShareForm } from '@/lib/share-legal';

/** The contract's `StorySharing`: this story's own choice (O4). */
export interface StorySharingState {
  granted: boolean;
  counts: boolean;
}

/** Story statuses whose sharing can be given: submitted, and not withdrawn or rejected. */
const SHAREABLE = ['pending', 'in_review', 'approved', 'changes_requested'];

/**
 * Where a choice is: `busy` while its command is sent; `unconfirmed` when an answer was lost or
 * unclear, so the same command (key and body) is sent again until one is definite; `rereading`
 * while the story's sharing is read again after it; `reread_failed` if that read failed. Only in
 * `idle` does the box state what the story's sharing is.
 */
type Phase = 'idle' | 'busy' | 'unconfirmed' | 'rereading' | 'reread_failed';

/**
 * Sharing beyond heisreal.today for one story (O4, Joel 2026-10-31): someone may want one story
 * only here and another more visible elsewhere. Given on the social sharing form in force (its
 * box, its words and the privacy policy it names, D114, D122), and withdrawn just as easily: two
 * presses either way. Withdrawing is always offered while it's given, whatever the story's status
 * or whether the form can be shown (Art 7(3)). `api` is null once the person has gone.
 */
export function StorySharing({
  storyId,
  titleId,
  status,
  sharing,
  form,
  api,
  onChanged,
}: {
  storyId: string;
  titleId: string;
  status: string;
  sharing: StorySharingState;
  /** The social sharing form in force; null when none is published or it couldn't be read. */
  form: ShareForm | null;
  api: () => ApiUser | null;
  /** Reads the story's sharing again; the new state comes back as `sharing`. */
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  // One key per choice, kept across retries of it (D29).
  const [key, setKey] = useState(newIdempotencyKey);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const box = form?.boxes.find((b) => b.statement === 'share_socials');
  const on = sharing.granted;
  if (phase === 'idle' && !on && !(SHAREABLE.includes(status) && form && box))
    return null;

  /** The story's sharing read again, once what was sent is known (never before). */
  const reread = async () => {
    setPhase('rereading');
    try {
      await onChanged();
      if (mounted.current) setPhase('idle');
    } catch {
      if (mounted.current) setPhase('reread_failed');
    }
  };

  const choose = async () => {
    const client = api();
    if (!client) {
      setError('You’ve signed out. Sign in again to do this.');
      return;
    }
    // The command for this choice, fixed: every retry sends the same key and body (D29).
    const send = () =>
      on
        ? client.command<{ id?: unknown }>(
            '/v1/account/consents/share_socials/withdraw',
            { method: 'POST', body: { storyId }, idempotencyKey: key },
          )
        : form
          ? client.command<{ id?: unknown }>('/v1/account/consents', {
              method: 'POST',
              body: {
                form: 'social',
                formVersion: form.version,
                statement: 'share_socials',
                mechanism: 'account_settings',
                privacyPolicyVersion: form.privacyVersion,
                storyId,
              },
              idempotencyKey: key,
            })
          : null;
    setPhase('busy');
    setError(null);
    let unconfirmed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await send();
        if (!res) return setPhase('idle');
        // A success without the event's id says nothing about what was done: no answer.
        if (typeof res.data?.id !== 'string')
          throw new ApiUserUnavailable('api-user answered without the result');
        break;
      } catch (err) {
        if (
          err instanceof ApiUserUnavailable ||
          (err instanceof ApiUserProblem && err.status >= 500)
        ) {
          // It may have gone through: the state is unknown until the same command is answered.
          unconfirmed = true;
          setPhase('unconfirmed');
          await new Promise((r) =>
            setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)),
          );
          if (!mounted.current) return;
          continue;
        }
        setError(refusal(err));
        if (!unconfirmed) return setPhase('idle');
        // Refused after an answer was lost: what's true now comes from the story again.
        break;
      }
    }
    setKey(newIdempotencyKey());
    setOpen(false);
    await reread();
  };

  if (phase === 'unconfirmed' || phase === 'rereading') {
    return (
      <div
        data-sharing="unknown"
        className="mb-4 rounded-xl border border-border p-4"
      >
        <p role="status" className="text-[0.9375rem] text-secondary-text">
          {phase === 'unconfirmed'
            ? 'We couldn’t confirm that, checking…'
            : 'Checking this story’s sharing…'}
        </p>
      </div>
    );
  }
  if (phase === 'reread_failed') {
    return (
      <div
        data-sharing="unknown"
        className="mb-4 rounded-xl border border-border p-4"
      >
        <p role="alert" className="mb-3 text-[0.9375rem] text-destructive">
          We couldn’t check whether this story is shared beyond heisreal.today.
        </p>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 px-5 py-2 whitespace-normal"
          onClick={() => void reread()}
        >
          Check again
        </Button>
      </div>
    );
  }

  const busy = phase === 'busy';
  return (
    <div
      data-sharing={on ? 'on' : 'off'}
      className="mb-4 rounded-xl border border-border p-4"
    >
      <p className="mb-3 text-[0.9375rem]">
        {on
          ? 'You let our media team share this story beyond heisreal.today, on our own channels and in the ways our sharing form lists.'
          : 'Only on heisreal.today. Our media team doesn’t share this story anywhere else.'}
      </p>
      {open ? (
        <div data-confirm={on ? 'stop-sharing' : 'share'}>
          {on ? (
            <p className="mb-3">
              Stop sharing this story beyond heisreal.today? We stop at once,
              and take it off our own channels within 30 days. Copies others
              made can’t be recalled. It stays on heisreal.today.
            </p>
          ) : (
            form &&
            box && (
              <>
                <p className="mb-2 font-semibold">{box.label}</p>
                <details className="mb-2">
                  <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-link">
                    What sharing beyond heisreal.today means
                  </summary>
                  <div className="mt-2">
                    <LegalHtml html={form.html} />
                  </div>
                </details>
                <LegalDocumentDetails
                  name="privacy"
                  version={form.privacyVersion}
                  number={form.privacyNumber}
                  html={form.privacyHtml}
                  className="mb-3"
                />
                <p className="mb-3 text-sm text-secondary-text">
                  For this story only. You can stop at any time, here.
                </p>
              </>
            )
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              autoFocus
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
              disabled={busy}
              onClick={() => void choose()}
            >
              {on
                ? busy
                  ? 'Stopping…'
                  : 'Yes, stop sharing'
                : busy
                  ? 'Saving…'
                  : 'Yes, share this story'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              {on ? 'Keep sharing' : 'Not now'}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 px-5 py-2 whitespace-normal"
          aria-describedby={titleId}
          onClick={() => setOpen(true)}
        >
          {on
            ? 'Stop sharing beyond heisreal.today'
            : 'Share beyond heisreal.today'}
        </Button>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A definite refusal, in plain words. */
function refusal(err: unknown): string {
  return err instanceof ApiUserProblem &&
    (err.code === 'form_version_not_in_force' ||
      err.code === 'legal_document_not_in_force')
    ? 'Our sharing form or privacy policy was updated since this page loaded. Reload the page to read the new version.'
    : err instanceof ApiUserProblem && err.problem.detail
      ? err.problem.detail
      : 'We couldn’t do that just now. Please try again in a moment.';
}
