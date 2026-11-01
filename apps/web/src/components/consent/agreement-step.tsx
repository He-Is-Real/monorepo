'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { type AgreementTexts, agreementTexts } from '@/app/consent/actions';
import { confirmAgreement } from '@/components/auth/account-bootstrap';
import { LegalHtml } from '@/components/legal/legal-html';
import { PrivacyNoticeLink } from '@/components/legal/privacy-notice-link';
import { Redline } from '@/components/legal/redline';
import { Button } from '@/components/ui/button';
import {
  type Agreement,
  type AgreementState,
  type ApiUser,
  ApiUserProblem,
  ApiUserUnavailable,
  NotSignedIn,
} from '@/lib/api-user';
import { type AgreementName, documentHref, shortDate } from '@/lib/legal-text';
import { SomeoneElseSignedIn } from '@/lib/personal-session';

const KEY: Record<AgreementName, 'termsOfUse' | 'testimonyConsent'> = {
  'terms-of-use': 'termsOfUse',
  'testimony-consent': 'testimonyConsent',
};

type Ready = Extract<AgreementTexts, { ok: true }>;

/**
 * One step where a person agrees to the latest version of the terms of use or the testimony
 * consent on their account (plan 4e; 8b mockups): the sign-up terms step, "Our terms of use have
 * changed", the testimony consent before a first story, and "Our testimony consent has changed",
 * on their own pages (/consent/terms, /consent/testimony) and inside the share flow.
 *
 * - **First time** (`agreed` null): the whole text, scrollable, and one box.
 * - **Agreed to an older version:** what changed from that version to the latest, in one redline
 *   however many versions came between, "Read the full version N", and one box.
 * - Nothing is ticked for the person, and nothing is sent until they tick and press Continue. The
 *   page sends back the version it showed (`POST /v1/account/agreements/{agreement}`); if a newer
 *   one was saved meanwhile (409 `agreement_version_changed`) it never sends the old one again: it
 *   reads the latest, says so, shows what changed, and the box is unticked for them to read and
 *   agree again.
 * - The privacy notice is linked beside the box (8b P1: nothing to tick for it).
 */
export function AgreementStep({
  document,
  agreed,
  userId,
  api,
  heading,
  onAgreed,
  after,
}: {
  document: AgreementName;
  /** What the person agreed to (api-user's account), or null. */
  agreed: Agreement | null;
  /** Clerk's user id for the person (whose agreement this is). */
  userId: string;
  /** api-user for this person only (personal-session.ts). */
  api: ApiUser;
  /** The step's heading, drawn by the page (an h1 on its own page, the flow's h2 in Share). */
  heading: (text: string) => React.ReactNode;
  onAgreed: (state: AgreementState) => void;
  /** Below the button: the way out ("Back", "Not now"). */
  after?: React.ReactNode;
}) {
  const id = useId();
  const [texts, setTexts] = useState<Ready | 'loading' | 'failed'>('loading');
  const [ticked, setTicked] = useState(false);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<React.ReactNode>(null);
  /** A newer version was saved while the person read: the version they were shown. */
  const [changedFrom, setChangedFrom] = useState<number | null>(null);
  const reads = useRef(0);
  const box = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (from: number | null) => {
      const mine = ++reads.current;
      setTexts('loading');
      const result = await agreementTexts(document, from).catch(
        () => ({ ok: false }) as const,
      );
      if (reads.current !== mine) return;
      setTexts(result.ok ? result : 'failed');
    },
    [document],
  );

  useEffect(() => {
    void load(agreed?.version ?? null);
  }, [load, agreed?.version]);

  useEffect(() => {
    if (problem) alert.current?.focus();
  }, [problem, texts]);

  // The heading stays the same element while the texts load, so the step can focus it at once.
  if (texts === 'loading') {
    return (
      <div>
        {heading(title(document, agreed))}
        <div aria-busy="true" className="min-h-[16rem]">
          <p role="status" className="text-secondary-text">
            Loading…
          </p>
        </div>
      </div>
    );
  }
  if (texts === 'failed') {
    return (
      <div>
        {heading(title(document, agreed))}
        <div data-agreement-unavailable="">
          <p role="alert" className="mb-4 text-secondary-text">
            This can’t be shown right now. Please try again in a moment.
          </p>
          <Button
            variant="outline"
            className="h-auto min-h-11 px-5 py-2 whitespace-normal"
            onClick={() => void load(changedFrom ?? agreed?.version ?? null)}
          >
            Try again
          </Button>
          {after}
        </div>
      </div>
    );
  }

  const latest = texts.latest.version;
  const name =
    document === 'terms-of-use' ? 'terms of use' : 'testimony consent';
  const reAgree = agreed !== null && agreed.version < latest;
  const label =
    document === 'terms-of-use' && !reAgree
      ? 'I am 18 or over and agree to the terms of use.'
      : reAgree
        ? `I agree to version ${latest} of the ${name}.`
        : `I agree to the ${name}.`;

  async function agree(event: React.FormEvent) {
    event.preventDefault();
    if (saving || texts === 'loading' || texts === 'failed') return;
    if (!ticked) {
      setMissing(true);
      box.current?.focus();
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const { data } = await api.command<AgreementState>(
        `/v1/account/agreements/${document}`,
        { method: 'POST', body: { version: latest } },
      );
      if (!data || data.agreed?.version !== latest) {
        throw new ApiUserUnavailable('api-user answered without the agreement');
      }
      confirmAgreement(userId, KEY[document], data);
      onAgreed(data);
    } catch (err) {
      setSaving(false);
      if (
        err instanceof ApiUserProblem &&
        err.code === 'agreement_version_changed'
      ) {
        // Never the old version again: the latest, what changed, and a fresh tick.
        setTicked(false);
        setChangedFrom(latest);
        setProblem(
          `We updated the ${name} while you were reading. Please read what changed, then tick the box again.`,
        );
        void load(reAgree ? (agreed?.version ?? null) : latest);
        return;
      }
      setProblem(messageFor(err));
    }
  }

  return (
    <div>
      {heading(title(document, agreed, latest))}
      <form
        noValidate
        onSubmit={agree}
        data-agreement={document}
        data-agreement-version={latest}
      >
        {reAgree ? (
          <p className="mb-4 text-[1.0625rem] text-secondary-text">
            You agreed to version {agreed.version} on{' '}
            <time dateTime={agreed.agreedAt}>{shortDate(agreed.agreedAt)}</time>
            . Here’s what’s different in version {latest}.
          </p>
        ) : (
          <p className="mb-4 text-[1.0625rem] text-secondary-text">
            {document === 'terms-of-use'
              ? 'Please read our terms of use. You must be 18 or over to have an account.'
              : 'Please read our testimony consent. It covers every story you submit.'}
          </p>
        )}

        {problem && (
          <div
            ref={alert}
            tabIndex={-1}
            role="alert"
            data-agreement-problem=""
            className="mb-4 rounded-xl border border-destructive px-4 py-3 text-foreground outline-none"
          >
            {problem}
          </div>
        )}

        {reAgree ? (
          <>
            <Redline
              items={texts.redline ?? []}
              label={`What changed in the ${name}`}
            />
            <FullText version={latest} html={texts.latest.html} />
          </>
        ) : (
          <>
            {changedFrom !== null && texts.redline && (
              <Redline
                items={texts.redline}
                label={`What changed in the ${name}`}
                className="mb-4"
              />
            )}
            <section
              aria-label={`The ${name}, version ${latest}`}
              data-legal-document={document}
              tabIndex={0}
              className="max-h-[50svh] overflow-y-auto rounded-xl border border-border bg-card px-4 py-4 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:px-5"
            >
              <LegalHtml html={texts.latest.html} />
            </section>
            {document === 'terms-of-use' && (
              <p className="mt-2">
                <a
                  href={documentHref('terms-of-use')}
                  className="inline-flex min-h-11 items-center font-medium text-link underline-offset-4 hover:text-link-hover hover:underline"
                >
                  Read the full terms
                </a>
              </p>
            )}
          </>
        )}

        <div className="mt-6">
          <label
            className={`flex min-h-11 cursor-pointer items-start gap-[12px] rounded-xl border bg-accent px-[12px] py-3 text-[1.0625rem] leading-relaxed text-foreground has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 [overflow-wrap:anywhere] sm:px-4 ${missing ? 'border-destructive' : 'border-border'}`}
          >
            <input
              ref={box}
              type="checkbox"
              checked={ticked}
              onChange={(e) => {
                setTicked(e.target.checked);
                setMissing(false);
              }}
              aria-invalid={missing || undefined}
              aria-describedby={missing ? `${id}-missing` : undefined}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="mt-[3px] flex size-[22px] shrink-0 items-center justify-center rounded-md border-2 border-input bg-input-background text-primary-foreground peer-checked:border-primary peer-checked:bg-primary [&>svg]:invisible peer-checked:[&>svg]:visible"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-[16px] fill-none stroke-current"
                strokeWidth="3"
              >
                <path d="M5 12l5 5 9-10" />
              </svg>
            </span>
            <span className="min-w-0 font-semibold">{label}</span>
          </label>
          {missing && (
            <p
              id={`${id}-missing`}
              className="mt-2 font-medium text-destructive"
            >
              Tick the box to continue. Nothing is saved until you do.
            </p>
          )}
        </div>

        <Button
          type="submit"
          disabled={saving}
          className="mt-6 h-auto min-h-11 w-full px-6 py-2 text-base whitespace-normal sm:w-auto"
        >
          {saving ? 'Saving…' : 'Continue'}
        </Button>
        <PrivacyNoticeLink className="mt-4" />
        {after}
      </form>
    </div>
  );
}

/** The step's heading, as the 8b mockups have it. */
function title(
  document: AgreementName,
  agreed: Agreement | null,
  latest?: number,
): string {
  const changed =
    agreed !== null && (latest === undefined || agreed.version < latest);
  if (document === 'terms-of-use')
    return changed
      ? 'Our terms of use have changed'
      : 'Welcome to He Is Real Today';
  return changed
    ? 'Our testimony consent has changed'
    : 'Your story and your data';
}

/** The latest version in full, folded away under the redline ("Read the full version N"). */
function FullText({ version, html }: { version: number; html: string }) {
  return (
    <details className="group mt-2">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-medium text-link hover:text-link-hover">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-4 shrink-0 fill-none stroke-current transition-transform group-open:rotate-90"
          strokeWidth="2"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        Read the full version {version}
      </summary>
      <div
        data-full-version={version}
        className="mt-2 rounded-xl border border-border bg-card px-4 py-4 sm:px-5"
      >
        <LegalHtml html={html} />
      </div>
    </details>
  );
}

/** What went wrong saving, for the person. */
function messageFor(err: unknown): React.ReactNode {
  if (err instanceof SomeoneElseSignedIn)
    return 'The account signed in on this browser changed while this page was open, so nothing was saved. Reload the page to continue as the person signed in now.';
  if (
    err instanceof NotSignedIn ||
    (err instanceof ApiUserProblem && err.status === 401)
  )
    return 'You’ve been signed out. Sign in again to continue.';
  return 'We couldn’t save your answer just now. Please try again in a moment.';
}
