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
import {
  personalApiUser,
  SomeoneElseSignedIn,
  usePersonalSession,
} from '@/lib/personal-session';
import { forgetShareStorageOf } from '@/lib/share-storage';
import { PUBLISHING_CHANGED } from './my-submissions';
import { signedInAs, useOwnData, useOwnNotice } from './use-own-data';

/** What the person types to delete their account (D88: a typed confirmation). */
const CONFIRM_WORD = 'delete';

async function readPublishing(api: ApiUser): Promise<boolean> {
  const { data } = await api.get<{
    current: { type: string; granted: boolean }[];
  }>('/v1/account/consents');
  if (!data) throw new ApiUserUnavailable('No answer');
  return data.current.some((c) => c.type === 'publish' && c.granted);
}

/**
 * After `owner`'s account is deleted: their unsaved submit-flow state goes, and they're signed
 * out, but only if they are still the one signed in here. Someone else who signed in on this
 * browser while the deletion was on its way keeps their session and their drafts.
 */
type AfterDeletion = (owner: string) => Promise<void>;

/** "Your data" with Clerk's session: deleting the account ends with Clerk's sign-out. */
export function ClerkYourData() {
  const clerk = useClerk();
  return (
    <YourData
      afterDeletion={async (owner) => {
        forgetShareStorageOf(owner);
        if (signedInAs(owner)) await clerk.signOut({ redirectUrl: '/' });
      }}
    />
  );
}

/** e2e only (E2E_FIXTURES): the same, going home in place of Clerk's sign-out. */
export function FixtureYourData() {
  const router = useRouter();
  return (
    <YourData
      afterDeletion={async (owner) => {
        forgetShareStorageOf(owner);
        if (signedInAs(owner)) router.push('/');
      }}
    />
  );
}

/** The answer says the person's session no longer opens: their account is gone. */
const accountGone = (err: unknown) =>
  (err instanceof NotSignedIn && !(err instanceof SomeoneElseSignedIn)) ||
  (err instanceof ApiUserProblem && err.status === 401);

/** No answer, or the server failed: the deletion may have happened. */
const outcomeUnknown = (err: unknown) =>
  err instanceof ApiUserUnavailable ||
  (err instanceof ApiUserProblem && err.status >= 500);

/**
 * Your data (R6, Joel 2026-10-30): the profile's serious choices about the person's data, in one
 * place. "Take all my stories off the site" withdraws their consent to publish (every story comes
 * off the site at once and stays in the account); "Download my data" saves everything we hold
 * about them as one JSON file (M2 plan PR 12; Art 15, Art 20); "Delete my account" erases everything (D39, D82) after a typed confirmation, and
 * signs them out. Filled in by the browser (D83).
 */
export function YourData({ afterDeletion }: { afterDeletion: AfterDeletion }) {
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
        <DownloadMyData />
        <DeleteAccount afterDeletion={afterDeletion} />
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

/** The part of `GET /v1/account/export` the page reads; the rest goes into the file as it is. */
interface MyDataFile {
  about: { generatedAt: string; linksExpireAt: string | null };
}

/** Hands the browser `text` as a file to save, named `name`. */
function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // After the click has handed it over; revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * "Download my data" (Art 15, Art 20; M2 plan PR 12): api-user reads everything of the person's
 * in their own session and sends it as JSON, which is saved as it came, laid out to be read. The
 * token is in a header, so the browser fetches it and saves it itself (a plain link can't carry
 * the token). Media stay at Bunny: the file has links, never files. The file is handed over only
 * while the person who asked is still the one signed in.
 */
function DownloadMyData() {
  const session = usePersonalSession();
  const owner = session.status === 'signed-in' ? session.userId : null;
  const [busy, setBusy] = useState(false);
  const { notice, say } = useOwnNotice<{ alert: boolean; text: string }>();

  const download = async () => {
    if (!owner || session.status !== 'signed-in') return;
    const api = personalApiUser(session);
    setBusy(true);
    say(owner, undefined);
    try {
      const { data } = await api.get<MyDataFile>('/v1/account/export');
      if (!data?.about?.generatedAt) throw new ApiUserUnavailable('No file');
      if (!signedInAs(owner)) return;
      const name = `he-is-real-my-data-${data.about.generatedAt.slice(0, 10)}.json`;
      saveFile(name, JSON.stringify(data, null, 2));
      say(owner, {
        alert: false,
        text: data.about.linksExpireAt
          ? `Your file ${name} is saved to your downloads. Its links to your videos and pictures work for 7 days.`
          : `Your file ${name} is saved to your downloads.`,
      });
    } catch {
      say(owner, {
        alert: true,
        text: 'We couldn’t prepare your file just now. Please try again in a moment.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      data-download-data=""
      className="rounded-2xl border border-border bg-card p-5 sm:p-6"
    >
      <h3 className="mb-1 text-lg font-semibold">Download my data</h3>
      <p className="mb-4 text-secondary-text">
        Get a copy of everything we hold about you, in one file (JSON) that
        explains each part: your account and sign-in details, every story you’ve
        started or shared, your consents, favourites and limits. Your videos,
        audio and pictures are in it as links that work for 7 days, including a
        link to download each video or audio file as you uploaded it.
      </p>
      <Button
        variant="outline"
        className="h-auto min-h-11 px-5 py-2 whitespace-normal"
        disabled={busy || !owner}
        aria-busy={busy}
        onClick={() => void download()}
      >
        {busy ? 'Preparing your file…' : 'Download my data'}
      </Button>
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

function DeleteAccount({ afterDeletion }: { afterDeletion: AfterDeletion }) {
  const session = usePersonalSession();
  const owner = session.status === 'signed-in' ? session.userId : null;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const { notice: error, say } = useOwnNotice<string>();
  // An earlier try whose outcome is unknown (no answer, or a server error) may have deleted the
  // account already: then a refused session means it's gone.
  const uncertain = useRef(false);
  const inputId = useId();
  const ready = typed.trim().toLowerCase() === CONFIRM_WORD;

  /** Whether the account is gone, asked again after an unknown outcome; null if still unknown. */
  const recheck = async (api: ApiUser): Promise<boolean | null> => {
    try {
      await api.get('/v1/account');
      return false;
    } catch (err) {
      if (accountGone(err)) return true;
      return outcomeUnknown(err) ? null : false;
    }
  };

  const remove = async () => {
    if (!owner || session.status !== 'signed-in' || !ready) return;
    const api = personalApiUser(session);
    setBusy(true);
    say(owner, undefined);
    let deleted = false;
    try {
      await api.command('/v1/account', { method: 'DELETE' });
      deleted = true;
    } catch (err) {
      if (accountGone(err) && uncertain.current) {
        deleted = true;
      } else if (outcomeUnknown(err)) {
        uncertain.current = true;
        const gone = await recheck(api);
        if (gone) deleted = true;
        else
          say(
            owner,
            gone === null
              ? 'We couldn’t tell whether your account was deleted. Please try again in a moment.'
              : 'We couldn’t delete your account just now. Please try again in a moment.',
          );
      } else {
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
    // Only for the person who asked: if someone else signed in meanwhile, this card is
    // already theirs (keyed by owner), and afterDeletion leaves them signed in.
    if (signedInAs(owner)) setDone(true);
    await afterDeletion(owner);
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
            your stories, for six years, as proof that we asked. We also keep a
            fingerprint of your sign-in’s id, so the deleted sign-in can’t make
            a new account here. It isn’t your name or email, but it isn’t
            anonymous: it can be matched to that id.
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
