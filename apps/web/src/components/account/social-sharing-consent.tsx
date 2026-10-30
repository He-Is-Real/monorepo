'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  type ApiUser,
  ApiUserProblem,
  ApiUserUnavailable,
  newIdempotencyKey,
} from '@/lib/api-user';
import { usePersonalSession } from '@/lib/personal-session';
import { useOwnData, useOwnNotice } from './use-own-data';

/** The contract's `ConsentState`, the part this shows. */
interface ConsentCurrent {
  type: string;
  granted: boolean;
  counts: boolean;
}

async function readSharing(api: ApiUser): Promise<boolean> {
  const { data } = await api.get<{ current: ConsentCurrent[] }>(
    '/v1/account/consents',
  );
  if (!data) throw new ApiUserUnavailable('No answer');
  return data.current.some((c) => c.type === 'share_socials' && c.granted);
}

/**
 * Sharing beyond heisreal.today (D93's optional social sharing form): whether the person allows
 * it, and withdrawing it, as easily as it was given (Art 7(3); the existing
 * `POST /v1/account/consents/share_socials/withdraw`). D107: new sharing stops at once, and within
 * 30 days we take the person's stories off our own channels. It's given at Review in /share, so
 * nothing here grants it.
 */
export function SocialSharingConsent() {
  const session = usePersonalSession();
  const owner = session.status === 'signed-in' ? session.userId : null;
  // A fresh one for each person: someone signing in never inherits the last person's open
  // confirmation, "Withdrawing…" or retry key, and a late answer only reaches the one that's gone.
  return <SharingConsent key={owner ?? 'signed-out'} />;
}

function SharingConsent() {
  const own = useOwnData(readSharing);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { notice: message, say } = useOwnNotice<{
    alert: boolean;
    text: string;
  }>();
  // One key per withdrawal, kept across retries of it (D29).
  const [key, setKey] = useState(newIdempotencyKey);

  const { state } = own;
  if (state.status === 'signed-out') return null;

  const withdraw = async (owner: string) => {
    const api = own.api(owner);
    if (!api) return;
    setBusy(true);
    say(owner, undefined);
    try {
      await api.command('/v1/account/consents/share_socials/withdraw', {
        method: 'POST',
        idempotencyKey: key,
      });
      setKey(newIdempotencyKey());
      setConfirm(false);
      say(owner, {
        alert: false,
        text: 'Withdrawn. We won’t share your stories beyond heisreal.today any more.',
      });
      await own.reload(owner);
    } catch (err) {
      say(owner, {
        alert: true,
        text:
          err instanceof ApiUserProblem && err.problem.detail
            ? err.problem.detail
            : 'We couldn’t withdraw it just now. Please try again in a moment.',
      });
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (state.status === 'loading') {
    body = (
      <div aria-busy="true" className="min-h-24">
        <p className="sr-only" role="status">
          Loading your choices…
        </p>
      </div>
    );
  } else if (state.status === 'failed') {
    body = (
      <div className="min-h-24">
        <p role="alert" className="mb-4 text-secondary-text">
          Your choices couldn’t load. Try again in a moment.
        </p>
        <Button
          variant="outline"
          className="h-auto min-h-11 px-5 py-2 whitespace-normal"
          onClick={() => own.reload(state.owner, false)}
        >
          Try again
        </Button>
      </div>
    );
  } else if (!state.data) {
    body = (
      <p data-sharing="off" className="min-h-24 text-secondary-text">
        You haven’t allowed us to share your stories beyond heisreal.today. We
        only ask when you submit a story.
      </p>
    );
  } else {
    body = (
      <div data-sharing="on" className="min-h-24">
        <p className="mb-4">
          You allow us to share your published stories beyond heisreal.today, on
          the channels and in the ways you chose. You can withdraw this at any
          time: we stop sharing at once, and take your stories off our own
          channels within 30 days. Copies others made can’t be recalled.
        </p>
        {confirm ? (
          <div className="flex flex-wrap gap-3">
            <Button
              autoFocus
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
              disabled={busy}
              onClick={() => withdraw(state.owner)}
            >
              {busy ? 'Withdrawing…' : 'Yes, withdraw'}
            </Button>
            <Button
              variant="outline"
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Keep sharing
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            className="h-auto min-h-11 px-5 py-2 whitespace-normal"
            onClick={() => setConfirm(true)}
          >
            Withdraw sharing beyond heisreal.today
          </Button>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="privacy-consent" className="mb-12">
      <h2 id="privacy-consent" className="mb-5 text-2xl font-normal">
        Privacy and consent
      </h2>
      <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
        <h3 className="mb-3 text-lg font-semibold">
          Sharing beyond heisreal.today
        </h3>
        {body}
        {message && (
          <p
            role={message.alert ? 'alert' : 'status'}
            className={`mt-3 text-sm ${message.alert ? 'text-destructive' : ''}`}
          >
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}
