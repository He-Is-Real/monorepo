'use client';

import { SignOutButton, useAuth } from '@clerk/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import {
  E2E_FIXTURE_USER_ID,
  e2eFixtureToken,
} from '@/components/auth/account-control';
import {
  confirmConsent,
  useAccountState,
} from '@/components/auth/account-bootstrap';
import { dismissTestimonyBanner } from '@/components/consent/consent-prompts';
import { LegalBlocks } from '@/components/consent/legal-blocks';
import { Button } from '@/components/ui/button';
import {
  ApiUserProblem,
  apiUser,
  type GetToken,
  NotSignedIn,
  newIdempotencyKey,
} from '@/lib/api-user';
import type {
  ConsentBox,
  ConsentFormName,
  ConsentStatement,
  LegalBlock,
} from '@/lib/legal';
import { signInHref } from '@/lib/return-path';

/** What a consent page asks for, from the server's read of the form in force (D32). */
export interface ConsentAsk {
  form: ConsentFormName;
  /** The version in force, which every grant names (D84). */
  formVersion: string;
  /**
   * The boxes to tick, and the words beside each, from the version's statements data (D114):
   * all of them, before anything is recorded.
   */
  boxes: ConsentBox[];
  /** `GrantConsent.mechanism`. */
  mechanism: 'web_form_submission' | 'reconsent_prompt';
  blocks: LegalBlock[];
  dpaVersion: string;
  dpaBlocks: LegalBlock[];
  /** A same-site path to go on to afterwards (return-path.ts). */
  returnTo: string;
  /** api-user's origin (config.ts); none: nothing can be recorded. */
  apiUserUrl?: string;
}

/**
 * The consent form with the site's Clerk session (app/layout.tsx, D115): the person's own token
 * on every call (D31).
 */
export function ClerkConsentForm(ask: ConsentAsk) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  return (
    <ConsentFormView
      {...ask}
      signedIn={isLoaded ? !!isSignedIn : undefined}
      userId={userId ?? null}
      getToken={() => getToken()}
      signOut={(button) => (
        <SignOutButton redirectUrl="/">{button}</SignOutButton>
      )}
    />
  );
}

/**
 * e2e only (E2E_FIXTURES): signed in (or out) with the fixtures' token, which only the stub api-user
 * accepts; Sign out goes home, as Clerk's would.
 */
export function FixtureConsentForm({
  signedIn,
  ...ask
}: ConsentAsk & { signedIn: boolean }) {
  const router = useRouter();
  return (
    <ConsentFormView
      {...ask}
      signedIn={signedIn}
      userId={signedIn ? E2E_FIXTURE_USER_ID : null}
      getToken={e2eFixtureToken}
      signOut={(button) => (
        <span onClickCapture={() => router.push('/')}>{button}</span>
      )}
    />
  );
}

type Saving =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'missing'; statements: ConsentStatement[] }
  | { status: 'error'; message: React.ReactNode };

/**
 * The form's words, a document to read, and beside them its boxes, unticked (D73: nothing is
 * ticked for the person), drawn from the version's statements data (D114).
 * Nothing is recorded until every box is ticked; then each box is one grant on the version
 * shown (`POST /v1/account/consents`), each with its own `Idempotency-Key`, kept for retries
 * so a retry after a half-finished save doesn't record a box twice (D29). Afterwards the page
 * goes on to `returnTo`.
 */
export function ConsentFormView({
  form,
  formVersion,
  boxes: asked,
  mechanism,
  blocks,
  dpaVersion,
  dpaBlocks,
  returnTo,
  apiUserUrl,
  signedIn,
  userId,
  getToken,
  signOut,
}: ConsentAsk & {
  /** undefined while Clerk loads. */
  signedIn: boolean | undefined;
  /** Clerk's user id for the signed-in person; null when signed out or loading. */
  userId: string | null;
  getToken: GetToken;
  signOut: (button: React.ReactElement) => React.ReactNode;
}) {
  const statements = asked.map((b) => b.statement);
  const router = useRouter();
  const pathname = usePathname();
  const account = useAccountState();
  const id = useId();
  const [ticked, setTicked] = useState<Set<ConsentStatement>>(new Set());
  const [saving, setSaving] = useState<Saving>({ status: 'idle' });
  const keys = useRef(new Map<ConsentStatement, string>());
  const inputs = useRef(new Map<ConsentStatement, HTMLInputElement>());
  const alert = useRef<HTMLDivElement>(null);

  // Someone who has already accepted the sign-up form in force goes straight on.
  const alreadyAccepted =
    form === 'signup' &&
    account.status === 'ready' &&
    account.account.signupConsent.accepted;
  useEffect(() => {
    if (alreadyAccepted && saving.status === 'idle') router.replace(returnTo);
  }, [alreadyAccepted, saving.status, returnTo, router]);

  useEffect(() => {
    if (saving.status === 'error') alert.current?.focus();
  }, [saving]);

  const toggle = (statement: ConsentStatement, on: boolean) => {
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(statement);
      else next.delete(statement);
      return next;
    });
    if (saving.status === 'missing') setSaving({ status: 'idle' });
  };

  async function accept(event: React.FormEvent) {
    event.preventDefault();
    if (saving.status === 'saving') return;
    const missing = statements.filter((s) => !ticked.has(s));
    if (missing.length > 0) {
      setSaving({ status: 'missing', statements: missing });
      inputs.current.get(missing[0])?.focus();
      return;
    }
    if (!apiUserUrl) {
      setSaving({ status: 'error', message: UNAVAILABLE });
      return;
    }
    setSaving({ status: 'saving' });
    try {
      const api = apiUser(apiUserUrl, getToken);
      for (const statement of statements) {
        let key = keys.current.get(statement);
        if (!key) {
          key = newIdempotencyKey();
          keys.current.set(statement, key);
        }
        await api.command('/v1/account/consents', {
          method: 'POST',
          body: { form, formVersion, statement, mechanism },
          idempotencyKey: key,
        });
      }
    } catch (err) {
      setSaving({
        status: 'error',
        message: messageFor(err, currentPath(pathname, returnTo)),
      });
      return;
    }
    // Accepted for the rest of this page load, even if the bootstrap's answer, sent before
    // this, arrives afterwards saying otherwise (account-bootstrap.ts).
    if (userId)
      confirmConsent(userId, form === 'signup' ? 'signup' : 'testimony');
    router.replace(returnTo);
  }

  const missing = saving.status === 'missing' ? saving.statements : [];
  const errorId = `${id}-error`;

  return (
    <div className="space-y-8">
      {/* The form's words: a document to read, beside the boxes (D114). */}
      <section
        aria-label="The form"
        data-legal-document={formVersion}
        className="rounded-2xl border border-border bg-card px-5 py-4"
      >
        <LegalBlocks blocks={blocks} />
      </section>

      <details className="group rounded-2xl border border-border bg-card">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl px-5 py-3 font-medium text-link hover:text-link-hover">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="size-4 shrink-0 fill-none stroke-current transition-transform group-open:rotate-90"
            strokeWidth="2"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          Read the privacy document
        </summary>
        <div
          data-privacy-document={dpaVersion}
          className="border-t border-border px-5 py-4"
        >
          <LegalBlocks blocks={dpaBlocks} />
        </div>
      </details>

      <form
        noValidate
        onSubmit={accept}
        aria-describedby={missing.length > 0 ? errorId : undefined}
        className="space-y-6"
      >
        {/* D114: the boxes are the page's own, drawn from the statements data, never from
            the document above. */}
        <fieldset className="space-y-3">
          <legend className="mb-3 text-lg font-semibold text-foreground">
            {statements.length > 1 ? 'Tick both boxes' : 'Tick the box'}
          </legend>
          {asked.map(({ statement, label }) => {
            const invalid = missing.includes(statement);
            return (
              <label
                key={statement}
                className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-card px-4 py-3 text-[1.0625rem] leading-relaxed text-foreground transition-colors hover:border-border-hover [overflow-wrap:anywhere] ${invalid ? 'border-destructive' : 'border-border'}`}
              >
                <input
                  ref={(el) => {
                    if (el) inputs.current.set(statement, el);
                    else inputs.current.delete(statement);
                  }}
                  type="checkbox"
                  name={statement}
                  checked={ticked.has(statement)}
                  onChange={(e) => toggle(statement, e.target.checked)}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? errorId : undefined}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border-2 border-input bg-input-background text-primary-foreground peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50 [&>svg]:invisible peer-checked:[&>svg]:visible"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="size-4 fill-none stroke-current"
                    strokeWidth="3"
                  >
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                </span>
                <span className="min-w-0">{label}</span>
              </label>
            );
          })}
        </fieldset>

        {missing.length > 0 && (
          <p id={errorId} className="font-medium text-destructive">
            {statements.length > 1
              ? 'Tick both boxes to continue. Nothing is stored until you do.'
              : 'Tick the box to continue.'}
          </p>
        )}
        {saving.status === 'error' && (
          <div
            ref={alert}
            role="alert"
            tabIndex={-1}
            className="rounded-xl border border-destructive px-4 py-3 text-foreground outline-none"
          >
            {saving.message}
          </div>
        )}

        {signedIn === false ? (
          <p className="rounded-xl border border-border bg-card px-4 py-3">
            You’re signed out.{' '}
            <a
              href={signInHref(currentPath(pathname, returnTo))}
              className="inline-flex min-h-11 items-center font-medium"
            >
              Sign in to continue
            </a>
          </p>
        ) : (
          <Button
            type="submit"
            disabled={saving.status === 'saving' || signedIn === undefined}
            className="h-auto min-h-11 w-full px-6 py-2 text-base whitespace-normal sm:w-auto"
          >
            {saving.status === 'saving'
              ? 'Saving…'
              : form === 'signup'
                ? 'Agree and continue'
                : 'Accept'}
          </Button>
        )}
      </form>

      {form === 'signup' ? (
        <section
          aria-labelledby={`${id}-decline`}
          className="space-y-3 border-t border-border pt-6"
        >
          <h2 id={`${id}-decline`} className="text-lg font-semibold">
            If you’d rather not
          </h2>
          <p className="text-secondary-text">
            Without these, you can’t use an account here, but every story stays
            open to read, watch and listen to without one. Accounts are for
            adults only: if you’re under 18, please sign out. You’re still very
            welcome to read the stories.
          </p>
          {signedIn !== false &&
            signOut(
              <Button
                variant="outline"
                className="h-auto min-h-11 max-w-full shrink px-6 py-2 whitespace-normal"
              >
                Sign out
              </Button>,
            )}
        </section>
      ) : (
        <section
          aria-labelledby={`${id}-later`}
          className="space-y-3 border-t border-border pt-6"
        >
          <h2 id={`${id}-later`} className="text-lg font-semibold">
            Not now?
          </h2>
          <p className="text-secondary-text">
            Your stories stay on the site whatever you choose. You only need to
            accept this before you start or submit a new story.
          </p>
          <Button
            asChild
            variant="outline"
            className="h-auto min-h-11 max-w-full shrink px-6 py-2 whitespace-normal"
          >
            <Link href={returnTo} onClick={dismissTestimonyBanner}>
              Not now
            </Link>
          </Button>
        </section>
      )}
    </div>
  );
}

const UNAVAILABLE = (
  <>We couldn’t save your answer just now. Please try again in a moment.</>
);

function currentPath(pathname: string, returnTo: string): string {
  return `${pathname}?redirect_url=${encodeURIComponent(returnTo)}`;
}

/** What went wrong saving, for the person; `here` is this page with its return path. */
function messageFor(err: unknown, here: string): React.ReactNode {
  if (
    err instanceof ApiUserProblem &&
    err.status === 409 &&
    err.code === 'form_version_not_in_force'
  ) {
    return (
      <>
        This form was updated while you were reading it.{' '}
        <a
          href={here}
          className="inline-flex min-h-11 items-center font-medium"
        >
          Reload the page
        </a>{' '}
        to read the new version.
      </>
    );
  }
  if (
    err instanceof NotSignedIn ||
    (err instanceof ApiUserProblem && err.status === 401)
  ) {
    return (
      <>
        You’ve been signed out.{' '}
        <a
          href={signInHref(here)}
          className="inline-flex min-h-11 items-center font-medium"
        >
          Sign in again
        </a>{' '}
        to continue.
      </>
    );
  }
  return UNAVAILABLE;
}
