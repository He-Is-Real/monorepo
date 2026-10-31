'use client';

import { useClerk } from '@clerk/react';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  type ApiUser,
  ApiUserProblem,
  ApiUserUnavailable,
  newIdempotencyKey,
  NotSignedIn,
} from '@/lib/api-user';
import { personalApiUser, usePersonalSession } from '@/lib/personal-session';
import { forgetShareStorageExcept } from '@/lib/share-storage';
import { PUBLISHING_CHANGED } from './my-submissions';
import { useOwnData, useOwnNotice } from './use-own-data';

/** What the person types to delete their account (D88: a typed confirmation). */
const CONFIRM_WORD = 'delete';

async function readPublishing(api: ApiUser): Promise<boolean> {
  const { data } = await api.get<{
    current: { type: string; granted: boolean }[];
  }>('/v1/account/consents');
  if (!data) throw new ApiUserUnavailable('No answer');
  return data.current.some((c) => c.type === 'publish' && c.granted);
}

/** "Your data" with Clerk's session: deleting the account ends with Clerk's sign-out. */
export function ClerkYourData() {
  const clerk = useClerk();
  return (
    <YourData
      signOut={async () => {
        forgetShareStorageExcept(null);
        await clerk.signOut({ redirectUrl: '/' });
      }}
    />
  );
}

/** e2e only (E2E_FIXTURES): the same, going home in place of Clerk's sign-out. */
export function FixtureYourData() {
  const router = useRouter();
  return <YourData signOut={async () => router.push('/')} />;
}

/**
 * Your data (R6, Joel 2026-10-30): the profile's serious choices about the person's data, in one
 * place. "Take all my stories off the site" withdraws their consent to publish (every story comes
 * off the site at once and stays in the account); "Download my data" comes with the export (M2
 * plan PR 12); "Delete my account" erases everything (D39, D82) after a typed confirmation, and
 * signs them out. Filled in by the browser (D83).
 */
export function YourData({ signOut }: { signOut: () => Promise<void> }) {
  const session = usePersonalSession();
  const owner = session.status === 'signed-in' ? session.userId : null;
  if (session.status === 'signed-out') return null;
  return (
    <section aria-labelledby="your-data" className="mb-12">
      <h2 id="your-data" className="mb-5 text-2xl font-normal">
        Your data
      </h2>
      {/* A fresh one for each person: nobody inherits the last person's confirmation or key. */}
      <ul key={owner ?? 'unknown'} className="flex flex-col gap-4">
        <TakeStoriesOff />
        <li
          data-coming-soon=""
          className="rounded-2xl border border-border bg-card p-5 sm:p-6"
        >
          <h3 className="mb-1 text-lg font-semibold">Download my data</h3>
          <p className="text-secondary-text">
            Get a copy of everything we hold about you. Coming soon.
          </p>
        </li>
        <DeleteAccount signOut={signOut} />
      </ul>
    </section>
  );
}

function TakeStoriesOff() {
  const own = useOwnData(readPublishing);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { notice, say } = useOwnNotice<{ alert: boolean; text: string }>();
  // One key per withdrawal, kept across retries of it (D29).
  const [key, setKey] = useState(newIdempotencyKey);
  const { state } = own;

  const takeOff = async (owner: string) => {
    const api = own.api(owner);
    if (!api) return;
    setBusy(true);
    say(owner, undefined);
    try {
      await api.command('/v1/account/consents/publish/withdraw', {
        method: 'POST',
        idempotencyKey: key,
      });
      setKey(newIdempotencyKey());
      setConfirm(false);
      say(owner, {
        alert: false,
        text: 'Done. None of your stories are on the site now. They’re still here in your account.',
      });
      window.dispatchEvent(new Event(PUBLISHING_CHANGED));
      await own.reload(owner);
    } catch (err) {
      say(owner, {
        alert: true,
        text:
          err instanceof ApiUserProblem && err.problem.detail
            ? err.problem.detail
            : 'We couldn’t do that just now. Please try again in a moment.',
      });
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (state.status !== 'ready' && state.status !== 'failed') {
    body = <div aria-busy="true" className="min-h-11" />;
  } else if (state.status === 'failed') {
    body = (
      <div className="min-h-11">
        <p role="alert" className="mb-3 text-secondary-text">
          This couldn’t load. Try again in a moment.
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
      <p data-publishing="off" className="min-h-11 text-secondary-text">
        None of your stories can be on the site: you haven’t given us your
        consent to publish them, or you’ve withdrawn it. You give it when you
        submit a story.
      </p>
    );
  } else if (confirm) {
    body = (
      <div
        data-confirm="take-off"
        className="rounded-xl border border-border-hover p-4"
      >
        <p className="mb-3">
          Take every one of your stories off the site? They come off straight
          away and stay in your account. To publish again, you give your consent
          again when you next submit a story.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            autoFocus
            className="h-auto min-h-11 px-5 py-2 whitespace-normal"
            disabled={busy}
            onClick={() => takeOff(state.owner)}
          >
            {busy ? 'Taking them off…' : 'Yes, take them off'}
          </Button>
          <Button
            variant="outline"
            className="h-auto min-h-11 px-5 py-2 whitespace-normal"
            disabled={busy}
            onClick={() => setConfirm(false)}
          >
            Keep them on
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <Button
        data-publishing="on"
        variant="outline"
        className="h-auto min-h-11 px-5 py-2 whitespace-normal"
        onClick={() => setConfirm(true)}
      >
        Take all my stories off the site
      </Button>
    );
  }

  return (
    <li className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <h3 className="mb-1 text-lg font-semibold">
        Take all my stories off the site
      </h3>
      <p className="mb-4 text-secondary-text">
        Withdraw your consent to publish: every story of yours comes off the
        site, and stays in your account.
      </p>
      {body}
      {notice && (
        <p
          role={notice.alert ? 'alert' : 'status'}
          className={`mt-3 text-sm ${notice.alert ? 'text-destructive' : ''}`}
        >
          {notice.text}
        </p>
      )}
    </li>
  );
}

function DeleteAccount({ signOut }: { signOut: () => Promise<void> }) {
  const session = usePersonalSession();
  const owner = session.status === 'signed-in' ? session.userId : null;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const { notice: error, say } = useOwnNotice<string>();
  // An earlier try whose answer never came may have deleted the account already.
  const uncertain = useRef(false);
  const inputId = useId();
  const ready = typed.trim().toLowerCase() === CONFIRM_WORD;

  const remove = async () => {
    if (!owner || session.status !== 'signed-in' || !ready) return;
    setBusy(true);
    say(owner, undefined);
    let deleted = false;
    try {
      await personalApiUser(session).command('/v1/account', {
        method: 'DELETE',
      });
      deleted = true;
    } catch (err) {
      const gone =
        err instanceof NotSignedIn ||
        (err instanceof ApiUserProblem && err.status === 401);
      if (uncertain.current && gone) {
        deleted = true;
      } else {
        if (err instanceof ApiUserUnavailable) uncertain.current = true;
        say(
          owner,
          'We couldn’t delete your account just now. Please try again in a moment.',
        );
      }
    }
    if (!deleted) {
      setBusy(false);
      return;
    }
    setDone(true);
    await signOut();
  };

  return (
    <li
      data-delete-account=""
      className="rounded-2xl border border-border bg-card p-5 sm:p-6"
    >
      <h3 className="mb-1 text-lg font-semibold">Delete my account</h3>
      <p className="mb-4 text-secondary-text">
        Remove your account and everything we hold about you.
      </p>
      {done ? (
        <p role="status" data-deleted="">
          Your account is deleted. Signing you out…
        </p>
      ) : open ? (
        <div className="rounded-xl border border-border-hover p-4">
          <p className="mb-2 font-semibold">This deletes, for good:</p>
          <ul className="mb-3 list-disc pl-5">
            <li>your account and your sign-in;</li>
            <li>
              every story you’ve shared or started, with its video, audio and
              pictures, wherever it is;
            </li>
            <li>your favourites.</li>
          </ul>
          <p className="mb-3">
            It can’t be undone. It’s also how you withdraw your consent for us
            to keep your stories: we can’t keep your account without it. We keep
            only the record of the consents you gave and withdrew, with none of
            your stories, for six years, as proof that we asked.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void remove();
            }}
          >
            <label htmlFor={inputId} className="mb-1 block font-medium">
              Type <span className="font-bold">{CONFIRM_WORD}</span> to confirm
            </label>
            <input
              id={inputId}
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mb-4 block min-h-11 w-full max-w-xs rounded-lg border border-border bg-background px-3 py-2"
            />
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                variant="destructive"
                className="h-auto min-h-11 px-5 py-2 whitespace-normal"
                disabled={!ready || busy}
              >
                {busy ? 'Deleting…' : 'Delete my account for good'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 px-5 py-2 whitespace-normal"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setTyped('');
                }}
              >
                Keep my account
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <Button
          variant="outline"
          className="h-auto min-h-11 px-5 py-2 whitespace-normal"
          onClick={() => setOpen(true)}
        >
          Delete my account
        </Button>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}
