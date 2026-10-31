'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Card } from '@/components/page/card';
import { StorySharing } from '@/components/account/story-sharing';
import {
  type ApiUser,
  ApiUserProblem,
  ApiUserUnavailable,
  newIdempotencyKey,
  StaleVersion,
} from '@/lib/api-user';
import { LegalDocumentDetails } from '@/components/legal/legal-document-details';
import { LegalHtml } from '@/components/legal/legal-html';
import type { ConsentBox, ConsentStatement } from '@/lib/legal';
import type { ShareForm, ShareLegal } from '@/lib/share-legal';
import { signInHref } from '@/lib/return-path';
import {
  type ConsentState,
  type MyStory,
  plainMessage,
  shareApi,
  type StoryFormat,
  type SubmissionLimits,
  type ThemeCategory,
} from './share-api';
import {
  formatWhen,
  SubmissionsLeft,
  submissionsState,
  UploadsLeft,
  uploadsState,
} from './allowance';
import { ThemePicker } from '@/components/themes/theme-picker';
import { useDraft } from './use-draft';
import { ImagePanel, type PictureState } from './image-panel';
import { fileLimits, type FileState, UploadPanel } from './upload-panel';

/**
 * The submit flow for written stories (M2 plan PR 4), from the mockup authenticated/submit.html,
 * reordered by D67: Choose → Your story and your data (Art 9 consent, only when the person isn't
 * on the testimony form in force, D85) → Prepare (prompts, guidance only, never stored) → Write →
 * Details (optional first name, no email: Clerk has it) → Review (publish consent; 18+ was asked
 * at sign-up, D93) → submitted for review. A video or audio story uploads its file where a
 * written one is written (M2 plan PR 7: upload-panel.tsx), with its title; recording in the
 * browser is left out of M2 (A5).
 *
 * Everything personal happens in the browser, against api-user (D32, D83). Nothing is stored
 * before the Art 9 tick; the draft is created once it has a title and text, and autosaves
 * (use-draft.ts). The database enforces consent and D94's limits; the page says them plainly.
 */

/**
 * The limits an admin sets and the person's own (W3, D112: `GET /v1/account/limits`): the page
 * shows and checks these, never numbers of its own.
 */
/** Exported for share-flow.spec.tsx (a step rendered on its own). */
export const Limits = createContext<SubmissionLimits | null>(null);
/** The theme count rule in words, as api-user says it: "Choose 1–5 themes". */
export function themeRule(min: number, max: number): string {
  const themes = (n: number) => `${n} theme${n === 1 ? '' : 's'}`;
  if (min === max) return `Choose ${themes(max)}`;
  if (min === 0) return `Choose up to ${themes(max)}`;
  return `Choose ${min}–${max} themes`;
}

function useLimits(): SubmissionLimits {
  const limits = useContext(Limits);
  if (!limits) throw new Error('the submit flow’s limits are loaded first');
  return limits;
}

type Step =
  'choose' | 'consent' | 'prepare' | 'write' | 'details' | 'review' | 'done';

const STEP_LABELS: Record<Exclude<Step, 'done'>, string> = {
  choose: 'Choose',
  consent: 'Your data',
  prepare: 'Prepare',
  write: 'Write',
  details: 'Details',
  review: 'Review',
};
/** A video or audio story's "write" step is its upload. */
const stepLabel = (s: Exclude<Step, 'done'>, format: StoryFormat) =>
  s === 'write' && format !== 'written' ? 'Upload' : STEP_LABELS[s];
const NOUN: Record<StoryFormat, string> = {
  written: 'story',
  video: 'video',
  audio: 'audio file',
};

/** The sign-up consent step (D73, PR 116's page). */
export const SIGNUP_CONSENT_HREF = `/consent/sign-up?redirect_url=${encodeURIComponent('/share')}`;

export type ShareAuth =
  | { state: 'loading' }
  | { state: 'signed-out' }
  /** `owner`: the person's Clerk user id (scopes what's kept in the tab). */
  | { state: 'signed-in'; api: ApiUser; owner: string };

const PROMPTS = [
  {
    title: 'What was your life like before?',
    text: 'Set the scene. What were you going through?',
  },
  {
    title: 'What happened?',
    text: 'The moment, the encounter, the turning point.',
  },
  { title: 'What changed?', text: 'How is your life different now?' },
];

const counts = (c: ConsentState | null, type: string) =>
  !!c?.current.find((x) => x.type === type)?.counts;

/** Art 9 consent on the testimony form in force (D67, D85, D93). */
const needsTestimonyConsent = (c: ConsentState) =>
  !counts(c, 'special_category_religious') ||
  c.testimony.updateAvailable ||
  c.testimony.acceptanceRequired;

const button =
  'inline-flex min-h-11 items-center justify-center rounded-md px-5 text-sm font-semibold transition-colors disabled:opacity-60';
const primary = `${button} bg-primary text-primary-foreground hover:bg-primary/90`;
const secondary = `${button} border border-border-hover text-secondary-text hover:border-teal hover:bg-accent hover:text-foreground`;
const input =
  'w-full rounded-md border border-input bg-input-background px-3 py-2.5 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function ShareFlow({
  auth,
  legal,
}: {
  auth: ShareAuth;
  legal: ShareLegal;
}) {
  if (auth.state === 'loading') {
    return <div className="min-h-[24rem]" aria-busy="true" />;
  }
  if (auth.state === 'signed-out') {
    return (
      <Card className="p-6 text-center sm:p-8">
        <h2 className="mb-3 text-2xl font-normal">
          Sign in to share your story
        </h2>
        <p className="mb-6 text-secondary-text">
          Your story is saved to your account as you write, so you can come back
          to it.
        </p>
        <a href={signInHref('/share')} className={primary}>
          Sign in
        </a>
      </Card>
    );
  }
  // A new person starts afresh (nothing of the previous one's carries over).
  return (
    <SignedInFlow
      key={auth.owner}
      api={auth.api}
      owner={auth.owner}
      legal={legal}
    />
  );
}

function SignedInFlow({
  api,
  owner,
  legal,
}: {
  api: ApiUser;
  owner: string;
  legal: ShareLegal;
}) {
  const calls = useMemo(() => shareApi(api), [api]);
  const draft = useDraft(calls, owner);
  const [loaded, setLoaded] = useState<
    | { state: 'loading' }
    | { state: 'failed' }
    | {
        state: 'ready';
        consents: ConsentState;
        limits: SubmissionLimits;
        themes: ThemeCategory[];
        drafts: MyStory[];
        askConsent: boolean;
      }
  >({ state: 'loading' });
  const [step, setStep] = useState<Step>('choose');
  const [missingDraft, setMissingDraft] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  const go = useCallback((next: Step) => {
    moved.current = true;
    setStep(next);
  }, []);

  // The draft turned out to be submitted already (a submission whose answer was lost):
  // "Thank you", wherever the person was.
  useEffect(() => {
    if (draft.status === 'submitted') go('done');
  }, [draft.status, go]);

  // Each step's heading takes focus, so keyboard and screen-reader users start at its top.
  useEffect(() => {
    if (!moved.current) return;
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'start' });
  }, [step]);

  const start = useCallback(async () => {
    setLoaded({ state: 'loading' });
    try {
      const [consents, limits, themes, drafts] = await Promise.all([
        calls.consents(),
        calls.limits(),
        calls.themes(),
        calls.openDrafts(),
      ]);
      const askConsent = needsTestimonyConsent(consents);
      setLoaded({
        state: 'ready',
        consents,
        limits,
        themes,
        drafts,
        askConsent,
      });
      // Resuming a draft (?draft=…, kept in the address after it was created).
      const id = new URLSearchParams(window.location.search).get('draft');
      if (id && consents.signup.accepted) {
        if (askConsent) setStep('consent');
        else {
          try {
            // Already submitted (a lost answer that went through): say so.
            setStep((await draft.load(id)) ? 'write' : 'done');
          } catch (err) {
            // Not theirs, or gone: nothing to retry; offer a new story instead.
            if (!(err instanceof ApiUserProblem && err.status === 404))
              throw err;
            window.history.replaceState(window.history.state, '', '/share');
            setMissingDraft(true);
          }
        }
      }
    } catch {
      setLoaded({ state: 'failed' });
    }
  }, [calls]);

  useEffect(() => {
    void start();
  }, [start]);

  // After an upload is counted, and back on Choose: the numbers shown and the drafts listed
  // follow together, so a draft this tab made is offered to carry on even when it filled the
  // open drafts (the old ones stay if this fails).
  const refreshLimits = useCallback(
    () =>
      void Promise.all([calls.limits(), calls.openDrafts()])
        .then(([limits, drafts]) =>
          setLoaded((l) =>
            l.state === 'ready' ? { ...l, limits, drafts } : l,
          ),
        )
        .catch(() => undefined),
    [calls],
  );
  useEffect(() => {
    if (step === 'choose' && moved.current) refreshLimits();
  }, [step, refreshLimits]);

  // A chosen theme was deleted meanwhile (A7): the list is read again to choose from.
  const reloadThemes = useCallback(
    () =>
      void calls
        .themes()
        .then((themes) =>
          setLoaded((l) => (l.state === 'ready' ? { ...l, themes } : l)),
        )
        .catch(() => undefined),
    [calls],
  );
  useEffect(() => {
    if (draft.themesChanged > 0) reloadThemes();
  }, [draft.themesChanged, reloadThemes]);

  // The draft's id in the address once it exists, so a reload resumes it.
  useEffect(() => {
    if (!draft.draftId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('draft') === draft.draftId) return;
    url.searchParams.set('draft', draft.draftId);
    window.history.replaceState(window.history.state, '', url);
  }, [draft.draftId]);

  if (loaded.state === 'loading') {
    return (
      <div className="min-h-[24rem]" aria-busy="true">
        <p className="text-center text-secondary-text" role="status">
          Loading…
        </p>
      </div>
    );
  }
  if (missingDraft) {
    return (
      <Card className="p-6 text-center sm:p-8">
        <h2 className="mb-3 text-2xl font-normal">
          This draft isn’t available
        </h2>
        <p className="mb-6 text-secondary-text">
          It may have been deleted, or it belongs to another account.
        </p>
        <a href="/share" className={primary}>
          Start a new story
        </a>
      </Card>
    );
  }
  if (loaded.state === 'failed') {
    return (
      <Card className="p-6 text-center sm:p-8">
        <h2 role="alert" className="mb-3 text-2xl font-normal">
          We can’t reach our server right now
        </h2>
        <p className="mb-6 text-secondary-text">
          Anything you wrote on this device is kept. Please try again in a
          moment.
        </p>
        <button type="button" className={primary} onClick={() => void start()}>
          Try again
        </button>
      </Card>
    );
  }
  const { consents, limits, themes, drafts, askConsent } = loaded;
  if (!consents.signup.accepted) {
    return (
      <Card className="p-6 text-center sm:p-8">
        <h2 className="mb-3 text-2xl font-normal">
          First, finish setting up your account
        </h2>
        <p className="mb-6 text-secondary-text">
          Before you share a story, please confirm you’re 18 or over and agree
          to us storing your account. It only takes a moment.
        </p>
        <a href={SIGNUP_CONSENT_HREF} className={primary}>
          Finish setting up
        </a>
      </Card>
    );
  }

  const steps = (Object.keys(STEP_LABELS) as Exclude<Step, 'done'>[]).filter(
    (s) => s !== 'consent' || askConsent,
  );
  const after = (s: Step): Step => {
    const i = steps.indexOf(s as Exclude<Step, 'done'>);
    return steps[i + 1] ?? 'done';
  };
  const before = (s: Step): Step => {
    const i = steps.indexOf(s as Exclude<Step, 'done'>);
    return steps[Math.max(0, i - 1)];
  };
  const refreshConsents = async () => {
    const fresh = await calls.consents();
    setLoaded({ ...loaded, consents: fresh });
    return fresh;
  };
  return (
    <Limits.Provider value={limits}>
      <div>
        {step !== 'done' && (
          <nav aria-label="Steps" className="mb-8">
            <ol className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-sm">
              {steps.map((s, i) => {
                const current = s === step;
                const done = steps.indexOf(step as Exclude<Step, 'done'>) > i;
                return (
                  <li
                    key={s}
                    aria-current={current ? 'step' : undefined}
                    className={
                      current
                        ? 'font-semibold text-foreground'
                        : done
                          ? 'text-link'
                          : 'text-secondary-text'
                    }
                  >
                    {i + 1}. {stepLabel(s, draft.format)}
                    {done && <span className="sr-only"> (done)</span>}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        <Card className="p-[16px] sm:p-8">
          {step === 'choose' && (
            <ChooseStep
              heading={heading}
              drafts={drafts}
              onStart={(format) => {
                draft.setFormat(format);
                go(after('choose'));
              }}
              onContinue={async (id) => {
                if (askConsent) {
                  window.history.replaceState(null, '', `/share?draft=${id}`);
                  go('consent');
                  return;
                }
                go((await draft.load(id)) ? 'write' : 'done');
              }}
            />
          )}
          {step === 'consent' && (
            <ConsentStep
              heading={heading}
              legal={legal}
              grant={async () => {
                if (!legal.testimony) return;
                // The version shown, whose box and privacy policy were on screen.
                await calls.grant(
                  'testimony',
                  legal.testimony.version,
                  legal.testimony.privacyVersion,
                  'special_category_religious',
                );
                await refreshConsents();
                const id = new URLSearchParams(window.location.search).get(
                  'draft',
                );
                if (id && !draft.draftId) {
                  go((await draft.load(id)) ? 'write' : 'done');
                } else go(after('consent'));
              }}
              onBack={() => go('choose')}
            />
          )}
          {step === 'prepare' && (
            <PrepareStep
              heading={heading}
              format={draft.format}
              onNext={() => go(after('prepare'))}
              onBack={() => go(before('prepare'))}
            />
          )}
          {step === 'write' && draft.format !== 'written' && (
            <MediaStep
              heading={heading}
              draft={draft}
              calls={calls}
              owner={owner}
              refreshLimits={refreshLimits}
              onNext={() => go(after('write'))}
              onBack={() => go(before('write'))}
            />
          )}
          {step === 'write' && draft.format === 'written' && (
            <WriteStep
              heading={heading}
              draft={draft}
              calls={calls}
              owner={owner}
              onNext={() => go(after('write'))}
              onBack={() => go(before('write'))}
            />
          )}
          {step === 'details' && (
            <DetailsStep
              heading={heading}
              draft={draft}
              themes={themes}
              onNext={() => go(after('details'))}
              onBack={() => go(before('details'))}
            />
          )}
          {step === 'review' && (
            <ReviewStep
              heading={heading}
              draft={draft}
              themes={themes}
              legal={legal}
              consents={consents}
              api={api}
              calls={calls}
              refreshConsents={refreshConsents}
              refreshLimits={refreshLimits}
              refreshThemes={reloadThemes}
              onEdit={(s) => go(s)}
              onDone={() => go('done')}
            />
          )}
          {step === 'done' && <DoneStep heading={heading} />}
        </Card>
      </div>
    </Limits.Provider>
  );
}

/**
 * The box for one statement, from the form version's structured boxes (D114), never from its
 * words; undefined when the version has none, and the step that needs it then fails closed.
 */
function boxFor(
  form: ShareForm | null,
  statement: ConsentStatement,
): ConsentBox | undefined {
  return form?.boxes.find((b) => b.statement === statement);
}

/**
 * The privacy policy a grant on this form names (D122), folded away to read, with its own
 * numbered page: shown beside every box that grants, so what's agreed to is what was shown.
 * The same card as the sign-up step's (legal-document-details.tsx).
 */
function PrivacyPolicy({
  form,
  className,
}: {
  form: ShareForm;
  className?: string;
}) {
  return (
    <LegalDocumentDetails
      name="privacy"
      version={form.privacyVersion}
      number={form.privacyNumber}
      html={form.privacyHtml}
      className={className}
    />
  );
}

/** A form's words, or the privacy policy's: a document to read, in a box of its own. */
function LegalDocument({
  label,
  html,
}: {
  label: string;
  html: ShareForm['html'];
}) {
  return (
    <section
      aria-label={label}
      className="max-h-[60svh] overflow-y-auto rounded-xl border border-border p-4"
    >
      <LegalHtml html={html} />
    </section>
  );
}

/**
 * A consent box: the whole label is the 44 px target (AGENTS.md); the native checkbox stays
 * for keyboards and screen readers, and the box shown is drawn from its state. The box, the gap
 * and the padding around it are px, not rem, so at 200% text on a 320 px phone the wording keeps
 * a readable column (rem would double them and leave a few letters a line).
 */
function Checkbox({
  checked,
  onChange,
  describedBy,
  disabled = false,
  children,
  className = '',
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  describedBy?: string;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      className={`flex min-h-11 items-start gap-[12px] has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 ${disabled ? 'opacity-70' : 'cursor-pointer'} ${className}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={describedBy}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-[20px] shrink-0 items-center justify-center rounded border-2 border-border-hover text-primary-foreground peer-checked:border-teal peer-checked:bg-teal [&>svg]:invisible peer-checked:[&>svg]:visible"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-[16px] fill-none stroke-current"
          strokeWidth="3"
        >
          <path d="M5 12l5 5 9-10" />
        </svg>
      </span>
      <span data-box-label="" className="min-w-0 flex-1">
        {children}
      </span>
    </label>
  );
}

type HeadingRef = React.RefObject<HTMLHeadingElement | null>;
type DraftState = ReturnType<typeof useDraft>;

function StepHeading({
  heading,
  children,
}: {
  heading: HeadingRef;
  children: React.ReactNode;
}) {
  return (
    <h2
      ref={heading}
      tabIndex={-1}
      className="mb-4 scroll-mt-4 text-[1.375rem] leading-snug font-normal outline-none sm:text-2xl"
    >
      {children}
    </h2>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
      {children}
    </div>
  );
}

function ChooseStep({
  heading,
  drafts,
  onStart,
  onContinue,
}: {
  heading: HeadingRef;
  drafts: MyStory[];
  onStart: (format: StoryFormat) => void;
  onContinue: (id: string) => Promise<void>;
}) {
  const limits = useLimits();
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<StoryFormat>('written');
  // Starting a story waits at a limit, said plainly (D94, D113): a new draft past the open
  // drafts allowed, or a video or audio story while no upload can start.
  const draftsFull =
    limits.openDrafts.max !== null &&
    limits.openDrafts.open >= limits.openDrafts.max;
  const uploadsHeld =
    format !== 'written' && !!uploadsState(limits.uploads).until;
  const held = draftsFull || uploadsHeld;
  const options = [
    { id: 'written', label: 'Written', note: 'Write it here' },
    { id: 'video', label: 'Video', note: 'Upload a video file' },
    { id: 'audio', label: 'Audio', note: 'Upload an audio file' },
  ] as const;
  const start: Record<StoryFormat, string> = {
    written: 'Write my story',
    video: 'Share my video',
    audio: 'Share my audio',
  };
  return (
    <div>
      <StepHeading heading={heading}>How would you like to share?</StepHeading>
      <fieldset>
        <legend className="sr-only">Choose how to share</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {options.map((o) => (
            <label
              key={o.id}
              className={`flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl p-4 text-center has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 ${
                format === o.id
                  ? 'border-2 border-teal bg-accent font-semibold'
                  : 'border border-border text-secondary-text'
              }`}
            >
              <input
                type="radio"
                name="format"
                value={o.id}
                checked={format === o.id}
                onChange={() => setFormat(o.id)}
                className="sr-only"
              />
              <span>{o.label}</span>
              <span className="text-xs font-normal text-secondary-text">
                {o.note}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-4 text-sm text-secondary-text">
        Recorded a video or a voice note already? Upload the file. Recording
        straight from this page comes later.
      </p>
      <section
        aria-label="What you can share this week"
        className="mt-4 flex flex-col gap-2 rounded-xl bg-surface px-4 py-3 text-sm text-secondary-text"
      >
        <SubmissionsLeft limits={limits} />
        {format !== 'written' && (
          <>
            <UploadsLeft
              limits={limits.uploads}
              noun={NOUN[format]}
              id="start-uploads"
            />
            <p data-file-limits="">
              {format === 'video' ? 'Videos' : 'Audio files'}:{' '}
              {fileLimits(limits.uploads, format)}
            </p>
          </>
        )}
        {draftsFull && (
          <p id="start-drafts" className="text-foreground">
            You have{' '}
            {limits.openDrafts.open === 1
              ? 'a draft'
              : `${limits.openDrafts.open} drafts`}{' '}
            on the go, which is as many as you can keep at once. Carry on with
            {limits.openDrafts.open === 1 ? ' it' : ' one of them'} below, or
            delete one from your account page to start a new one.
          </p>
        )}
      </section>
      {drafts.length > 0 && (
        <section aria-labelledby="your-drafts" className="mt-8">
          <h3 id="your-drafts" className="mb-3 font-semibold">
            Your drafts
          </h3>
          <ul className="flex flex-col gap-2">
            {drafts.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {d.title}
                  {d.primaryFormat !== 'written' && (
                    <span className="text-secondary-text">
                      {' '}
                      ({d.primaryFormat})
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className={secondary}
                  disabled={busy}
                  aria-label={`Continue “${d.title}”`}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onContinue(d.id);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Continue
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Actions>
        <a href="/get-ready" className={secondary}>
          Tips for getting ready
        </a>
        <button
          type="button"
          className={primary}
          disabled={held}
          aria-describedby={
            draftsFull
              ? 'start-drafts'
              : uploadsHeld
                ? 'start-uploads'
                : undefined
          }
          onClick={() => onStart(format)}
        >
          {start[format]}
        </button>
      </Actions>
    </div>
  );
}

/** Exported for share-flow.spec.tsx. */
export function ConsentStep({
  heading,
  legal,
  grant,
  onBack,
}: {
  heading: HeadingRef;
  legal: ShareLegal;
  grant: () => Promise<void>;
  onBack: () => void;
}) {
  const [ticked, setTicked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = legal.testimony;
  // D114: the box is the version's own data. Without it nothing is asked (fail closed).
  const box = boxFor(form, 'special_category_religious');
  if (!form || !box) {
    return (
      <div role="alert">
        <StepHeading heading={heading}>Your story and your data</StepHeading>
        <p className="text-secondary-text">
          The consent form can’t be shown right now, so we can’t start your
          story yet. Please try again later.
        </p>
        <Actions>
          <button type="button" className={secondary} onClick={onBack}>
            Back
          </button>
        </Actions>
      </div>
    );
  }
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ticked) {
          setProblem(
            'Tick the box to go on. Without it we don’t store anything you write.',
          );
          return;
        }
        setBusy(true);
        setProblem(null);
        try {
          await grant();
        } catch (err) {
          setProblem(
            err instanceof ApiUserProblem &&
              (err.code === 'form_version_not_in_force' ||
                err.code === 'legal_document_not_in_force')
              ? 'The form has just been updated. Please reload the page to read the new version.'
              : err instanceof ApiUserUnavailable
                ? 'We can’t reach our server right now. Please try again in a moment.'
                : plainMessage(
                    err,
                    'Your consent couldn’t be recorded. Please try again.',
                  ),
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <StepHeading heading={heading}>Your story and your data</StepHeading>
      {/* The form's words: a document to read. The box below is the page's own (D114). */}
      <LegalDocument label="The form" html={form.html} />
      <PrivacyPolicy form={form} className="mt-4" />
      <div className="mt-6">
        <Checkbox
          checked={ticked}
          onChange={setTicked}
          describedBy={problem ? 'consent-problem' : undefined}
          className="rounded-xl border border-border bg-accent p-[12px] text-foreground sm:p-4"
        >
          {box.label}
        </Checkbox>
      </div>
      {problem && (
        <p id="consent-problem" role="alert" className="mt-4 text-destructive">
          {problem}
        </p>
      )}
      <Actions>
        <button type="button" className={secondary} onClick={onBack}>
          Back
        </button>
        <button type="submit" className={primary} disabled={busy}>
          {busy ? 'Saving…' : 'I agree, continue'}
        </button>
      </Actions>
    </form>
  );
}

function PrepareStep({
  heading,
  format,
  onNext,
  onBack,
}: {
  heading: HeadingRef;
  format: StoryFormat;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <StepHeading heading={heading}>Prepare your story</StepHeading>
      <p className="mb-5 text-secondary-text">
        Some questions to think about before you{' '}
        {format === 'written' ? 'write' : 'record'}. They’re only here to help:
        nothing on this step is saved.
      </p>
      <ul className="flex flex-col gap-3">
        {PROMPTS.map((p) => (
          <li
            key={p.title}
            className="rounded-xl border-l-[3px] border-teal bg-surface px-4 py-3"
          >
            <p className="font-semibold">{p.title}</p>
            <p className="text-sm text-secondary-text">{p.text}</p>
          </li>
        ))}
      </ul>
      <Actions>
        <button type="button" className={secondary} onClick={onBack}>
          Back
        </button>
        <button type="button" className={primary} onClick={onNext}>
          {format === 'written' ? 'Start writing' : `Upload my ${NOUN[format]}`}
        </button>
      </Actions>
    </div>
  );
}

/** What autosave is doing, said plainly (a polite live region). */
function SaveState({ draft }: { draft: DraftState }) {
  const text: Record<string, string> = {
    idle: '',
    unsaved:
      draft.format === 'written'
        ? 'Kept on this device. It’s saved to your account once it has a title and some text.'
        : 'Kept on this device. It’s saved to your account once it has a title.',
    saving: 'Saving…',
    saved: 'Saved',
    offline:
      'We can’t reach our server. Your story is kept on this device; we’ll save it when you try again.',
    conflict: '',
    error: draft.error ?? '',
    submitted: '',
  };
  return (
    <div className="mt-3 min-h-11">
      <p
        role="status"
        data-save-state={draft.status}
        className={`text-sm ${draft.status === 'error' ? 'text-destructive' : 'text-secondary-text'}`}
      >
        {text[draft.status]}
      </p>
      {(draft.status === 'offline' || draft.status === 'error') && (
        <button
          type="button"
          className={`${secondary} mt-2`}
          onClick={() => void draft.flush()}
        >
          Try saving again
        </button>
      )}
      {draft.status === 'conflict' && (
        <div
          role="alert"
          className="rounded-xl border border-destructive p-4 text-foreground"
        >
          <p className="mb-3">
            This story was changed in another tab or window. Your text here is
            kept. Which version do you want to keep?
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={primary}
              onClick={() => void draft.resolve('mine')}
            >
              Keep what’s here
            </button>
            <button
              type="button"
              className={secondary}
              onClick={() => void draft.resolve('theirs')}
            >
              Use the other version
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The story's picture from its last read (another tab or device, or before a reload). */
function useEarlierPicture(
  calls: ReturnType<typeof shareApi>,
  draftId: string | null,
) {
  const [story, setStory] = useState<MyStory | null>(null);
  useEffect(() => {
    if (!draftId) return;
    let live = true;
    calls
      .story(draftId)
      .then((s) => live && setStory(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [calls, draftId]);
  return story;
}

function WriteStep({
  heading,
  draft,
  calls,
  owner,
  onNext,
  onBack,
}: {
  heading: HeadingRef;
  draft: DraftState;
  calls: ReturnType<typeof shareApi>;
  owner: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const limits = useLimits();
  const earlier = useEarlierPicture(calls, draft.draftId);
  const [picture, setPicture] = useState<PictureState>('none');
  const [pictureProblem, setPictureProblem] = useState<string | null>(null);
  // The draft exists once it has its title and text (D53), so the picture comes after them.
  const preparePicture = async () => {
    if (!draft.fields.title.trim() || !draft.fields.body.trim()) {
      return 'Write your title and your story first, then add a picture.';
    }
    if (!(await draft.flush())) {
      return 'Your story couldn’t be saved yet, so the picture can’t be added. Please try again.';
    }
    const { draftId: id, version } = draft.current();
    if (!id || !version) return 'Your story isn’t saved yet. Please try again.';
    return { draftId: id, version };
  };
  const [problems, setProblems] = useState<{ title?: string; body?: string }>(
    {},
  );
  const length = [...draft.fields.body.trim()].length;
  // The maximum counts the whole text, as the database does.
  const fullLength = [...draft.fields.body].length;
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const p: typeof problems = {};
        if (!draft.fields.title.trim()) p.title = 'Give your story a title.';
        if (!draft.fields.body.trim()) p.body = 'Write your story here.';
        setProblems(p);
        if (p.title || p.body) return;
        if (picture === 'unfinished') {
          setPictureProblem(
            'Add the picture you chose, or remove it, before you continue.',
          );
          return;
        }
        setPictureProblem(null);
        if (await draft.flush()) onNext();
      }}
    >
      <StepHeading heading={heading}>Write your story</StepHeading>
      <div className="flex flex-col gap-5">
        <div>
          <label htmlFor="story-title" className="mb-1.5 block font-semibold">
            Title
          </label>
          <input
            id="story-title"
            className={input}
            maxLength={140}
            value={draft.fields.title}
            aria-invalid={!!problems.title}
            aria-describedby={
              problems.title ? 'story-title-problem' : undefined
            }
            onChange={(e) => draft.update({ title: e.target.value })}
          />
          {problems.title && (
            <p
              id="story-title-problem"
              className="mt-1 text-sm text-destructive"
            >
              {problems.title}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="story-body" className="mb-1.5 block font-semibold">
            Your story
          </label>
          <textarea
            id="story-body"
            className={`${input} min-h-72 leading-relaxed`}
            maxLength={limits.storyText.max}
            value={draft.fields.body}
            aria-invalid={!!problems.body}
            aria-describedby="story-body-count"
            onChange={(e) => draft.update({ body: e.target.value })}
          />
          <p id="story-body-count" className="mt-1 text-sm text-secondary-text">
            {length.toLocaleString('en-GB')} /{' '}
            {limits.storyText.max.toLocaleString('en-GB')} characters. At least{' '}
            {limits.storyText.min.toLocaleString('en-GB')} to submit.
          </p>
          {fullLength > limits.storyText.max && (
            <p role="alert" className="mt-1 text-sm text-destructive">
              This is over the current limit of{' '}
              {limits.storyText.max.toLocaleString('en-GB')} characters. Shorten
              it before you submit; your shorter versions are saved as you go.
            </p>
          )}
          {problems.body && (
            <p className="mt-1 text-sm text-destructive">{problems.body}</p>
          )}
        </div>
        <div>
          <p className="mb-1.5 font-semibold">A picture (optional)</p>
          <ImagePanel
            calls={calls}
            owner={owner}
            format="written"
            draftId={draft.draftId}
            earlier={earlier?.image ?? null}
            prepare={preparePicture}
            setVersion={draft.setVersion}
            current={draft.current}
            reload={draft.load}
            onState={setPicture}
          />
          {pictureProblem && (
            <p role="alert" className="mt-2 text-destructive">
              {pictureProblem}
            </p>
          )}
        </div>
      </div>
      <SaveState draft={draft} />
      <Actions>
        <button type="button" className={secondary} onClick={onBack}>
          Back
        </button>
        <button type="submit" className={primary}>
          Continue
        </button>
      </Actions>
    </form>
  );
}

/**
 * A video or audio story's title and file (M2 plan PR 7). The draft is created once it has a
 * title, before the upload (metadata first: a failed upload leaves the draft to come back to).
 */
function MediaStep({
  heading,
  draft,
  calls,
  owner,
  refreshLimits,
  onNext,
  onBack,
}: {
  heading: HeadingRef;
  draft: DraftState;
  calls: ReturnType<typeof shareApi>;
  owner: string;
  refreshLimits: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const limits = useLimits();
  const format = draft.format === 'audio' ? 'audio' : 'video';
  const noun = NOUN[format];
  const [titleProblem, setTitleProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [file, setFile] = useState<FileState>('none');
  const [picture, setPicture] = useState<PictureState>('none');
  const { draftId } = draft;
  // Whether the story has a file (and a picture) from before (another tab or device).
  const story = useEarlierPicture(calls, draftId);
  const earlier = (story?.media.length ?? 0) > 0;

  const prepare = async () => {
    if (!draft.fields.title.trim()) {
      setTitleProblem('Give your story a title.');
      return 'Give your story a title first, then choose your file.';
    }
    setTitleProblem(null);
    if (!(await draft.flush())) {
      return 'Your story couldn’t be saved yet, so the upload can’t start. Please try again.';
    }
    const { draftId: id, version } = draft.current();
    if (!id || !version) return 'Your story isn’t saved yet. Please try again.';
    return { draftId: id, version };
  };

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (!draft.fields.title.trim()) {
          setTitleProblem('Give your story a title.');
          return;
        }
        if (file === 'none') {
          setProblem(`Choose your ${noun} to upload.`);
          return;
        }
        if (file === 'unfinished') {
          setProblem(
            `Your ${noun} hasn’t finished uploading. Wait for it to finish, or pause it and come back later: your story is saved.`,
          );
          return;
        }
        if (picture === 'unfinished') {
          setProblem(
            `Add the ${format === 'video' ? 'thumbnail' : 'picture'} you chose, or remove it, before you continue.`,
          );
          return;
        }
        setProblem(null);
        if (await draft.flush()) onNext();
      }}
    >
      <StepHeading heading={heading}>Upload your {noun}</StepHeading>
      <div className="flex flex-col gap-5">
        <div>
          <label htmlFor="story-title" className="mb-1.5 block font-semibold">
            Title
          </label>
          <input
            id="story-title"
            className={input}
            maxLength={140}
            value={draft.fields.title}
            aria-invalid={!!titleProblem}
            aria-describedby={titleProblem ? 'story-title-problem' : undefined}
            onChange={(e) => draft.update({ title: e.target.value })}
          />
          {titleProblem && (
            <p
              id="story-title-problem"
              className="mt-1 text-sm text-destructive"
            >
              {titleProblem}
            </p>
          )}
        </div>
        <div>
          <p className="mb-1.5 font-semibold">Your {noun}</p>
          <UploadPanel
            calls={calls}
            owner={owner}
            format={format}
            limits={limits.uploads}
            draftId={draftId}
            hasEarlierFile={earlier}
            prepare={prepare}
            setVersion={draft.setVersion}
            reload={draft.load}
            onState={setFile}
            onCounted={refreshLimits}
          />
        </div>
        {/* An audio story's picture, or (Joel, 2026-10-30) a video's own thumbnail once the
            video is chosen; without one, Bunny's thumbnail (or the site's audio picture). */}
        {(format === 'audio' || file !== 'none') && (
          <div>
            <p className="mb-1.5 font-semibold">
              {format === 'video'
                ? 'Add a thumbnail (optional)'
                : 'Add a picture (optional)'}
            </p>
            <p className="mb-3 text-sm text-secondary-text">
              {format === 'video'
                ? 'The picture shown before your video plays. Without one, our video host picks a frame.'
                : 'The picture shown while people listen. Without one, we show our own.'}
            </p>
            <ImagePanel
              calls={calls}
              owner={owner}
              format={format}
              draftId={draftId}
              earlier={story?.image ?? null}
              prepare={prepare}
              setVersion={draft.setVersion}
              current={draft.current}
              reload={draft.load}
              onState={setPicture}
            />
          </div>
        )}
      </div>
      <SaveState draft={draft} />
      {problem && (
        <p role="alert" className="mt-2 text-destructive">
          {problem}
        </p>
      )}
      <Actions>
        <button type="button" className={secondary} onClick={onBack}>
          Back
        </button>
        <button type="submit" className={primary}>
          Continue
        </button>
      </Actions>
      <p className="mt-4 text-sm text-secondary-text">
        Your {noun} goes straight to our video host in Frankfurt. Only our team
        sees it until your story is approved.
      </p>
    </form>
  );
}

function DetailsStep({
  heading,
  draft,
  themes,
  onNext,
  onBack,
}: {
  heading: HeadingRef;
  draft: DraftState;
  themes: ThemeCategory[];
  onNext: () => void;
  onBack: () => void;
}) {
  const limits = useLimits();
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = draft.fields.themeIds;
  const { min, max } = limits.themes;
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        // The rule submitting checks (themes plan v3), said before the review step.
        if (chosen.length < min || chosen.length > max) {
          setProblem(`${themeRule(min, max)}.`);
          return;
        }
        setProblem(null);
        if (await draft.flush()) onNext();
      }}
    >
      <StepHeading heading={heading}>Add some details</StepHeading>
      <div className="flex flex-col gap-6">
        <div>
          <label htmlFor="story-name" className="mb-1.5 block font-semibold">
            Your first name{' '}
            <span className="font-normal text-secondary-text">(optional)</span>
          </label>
          <input
            id="story-name"
            className={`${input} placeholder:text-secondary-text focus:placeholder:text-transparent`}
            placeholder="Anonymous"
            maxLength={80}
            autoComplete="given-name"
            value={draft.fields.bylineName}
            aria-describedby="story-name-hint"
            onChange={(e) => draft.update({ bylineName: e.target.value })}
          />
          <p id="story-name-hint" className="mt-1 text-sm text-secondary-text">
            Shown with your story. Leave it empty to share as Anonymous.
          </p>
        </div>
        <div>
          <label
            htmlFor="story-description"
            className="mb-1.5 block font-semibold"
          >
            Brief description{' '}
            <span className="font-normal text-secondary-text">(optional)</span>
          </label>
          <textarea
            id="story-description"
            className={`${input} min-h-24`}
            maxLength={5000}
            value={draft.fields.description}
            aria-describedby="story-description-hint"
            onChange={(e) => draft.update({ description: e.target.value })}
          />
          <p
            id="story-description-hint"
            className="mt-1 text-sm text-secondary-text"
          >
            In a sentence or two, what is your story about?
          </p>
        </div>
        <fieldset aria-describedby="story-themes-hint">
          <legend className="mb-1.5 font-semibold">
            Which themes fit your story?
          </legend>
          <p
            id="story-themes-hint"
            className="mb-3 text-sm text-secondary-text"
          >
            {chosen.length > 0
              ? `${chosen.length} of ${max} chosen. `
              : `${themeRule(min, max)}. `}
            They help people find it.
          </p>
          <ThemePicker
            categories={themes}
            chosen={chosen}
            renderTheme={(t) => {
              const on = chosen.includes(t.id);
              return (
                <label
                  className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 ${
                    on
                      ? 'border-teal bg-accent font-semibold text-foreground'
                      : 'border-border text-secondary-text'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    disabled={!on && chosen.length >= max}
                    onChange={() =>
                      draft.update({
                        themeIds: on
                          ? chosen.filter((id) => id !== t.id)
                          : [...chosen, t.id],
                      })
                    }
                  />
                  {t.name}
                </label>
              );
            }}
          />
          {problem && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {problem}
            </p>
          )}
        </fieldset>
      </div>
      <SaveState draft={draft} />
      <Actions>
        <button type="button" className={secondary} onClick={onBack}>
          Back
        </button>
        <button type="submit" className={primary}>
          Continue
        </button>
      </Actions>
    </form>
  );
}

/** Exported for share-flow.spec.tsx. */
export function ReviewStep({
  heading,
  draft,
  themes,
  legal,
  consents,
  api,
  calls,
  refreshConsents,
  refreshLimits,
  refreshThemes,
  onEdit,
  onDone,
}: {
  heading: HeadingRef;
  draft: DraftState;
  themes: ThemeCategory[];
  legal: ShareLegal;
  consents: ConsentState;
  /** For the story's own sharing choice, once given (O4). */
  api: ApiUser;
  calls: ReturnType<typeof shareApi>;
  refreshConsents: () => Promise<ConsentState>;
  /** The page's limits and drafts read again (when the server's answer shows them stale). */
  refreshLimits: () => void;
  /** The themes read again (a chosen one was deleted meanwhile, A7). */
  refreshThemes: () => void;
  onEdit: (step: Step) => void;
  onDone: () => void;
}) {
  const limits = useLimits();
  const askPublish = !counts(consents, 'publish');
  // O4: sharing beyond heisreal.today is chosen for each story. The box is part of the submit
  // command: ticked, it's sent with the submission and recorded in the same transaction, so the
  // two commit together or not at all, and a lost answer is resolved by replaying the same
  // submission (same key, same body). It's offered unless this story already allows it (sent
  // back for changes, say): then Review says so, with the way to stop it, and submitting leaves
  // it as it is. So the choice waits for the story's sharing state; if that can't be read (no
  // answer, or one without a yes or no), the person retries, and nothing is submitted meanwhile.
  const storyId = draft.current().draftId;
  const needsSharing = !!storyId && !!legal.social;
  const [sharing, setSharing] = useState<
    'loading' | 'shared' | 'not_shared' | 'error'
  >(needsSharing ? 'loading' : 'not_shared');
  const reads = useRef(0);
  const readSharing = useCallback(async () => {
    const mine = ++reads.current;
    if (!storyId || !legal.social) {
      setSharing('not_shared');
      return;
    }
    setSharing('loading');
    let next: 'shared' | 'not_shared' | 'error' = 'error';
    try {
      const granted = (await calls.story(storyId))?.sharing?.granted;
      if (typeof granted === 'boolean')
        next = granted ? 'shared' : 'not_shared';
    } catch {
      // stays 'error'
    }
    // Only the latest read speaks (an earlier one's answer is older).
    if (reads.current === mine) setSharing(next);
  }, [calls, storyId, legal.social]);
  useEffect(() => {
    void readSharing();
    return () => {
      reads.current += 1;
    };
  }, [readSharing]);
  const alreadyShared = sharing === 'shared';
  const sharingKnown = sharing === 'shared' || sharing === 'not_shared';
  const askSocial = !!legal.social && sharing === 'not_shared';
  // D114: the boxes are the versions' own data. Publishing is required, so without its box the
  // story can't be submitted (fail closed); sharing is optional, so without its box it's not offered.
  const publishBox = boxFor(legal.testimony, 'publish');
  const socialBox = askSocial
    ? boxFor(legal.social, 'share_socials')
    : undefined;
  // The weekly submissions are used up (D94): submitting waits, said before they try.
  const waiting = !draft.submittedBefore && !!submissionsState(limits).until;
  const [publish, setPublish] = useState(false);
  // A submission whose outcome is unknown (an answer lost) is sent again exactly as it was, so
  // its sharing choice is shown as sent, and can't change until it's resolved.
  const [kept, setKept] = useState(() => {
    const { draftId, version } = draft.current();
    return draftId && version ? draft.keptSubmit(draftId, version) : null;
  });
  const [social, setSocial] = useState(() => !!kept?.share);
  const [problem, setProblem] = useState<React.ReactNode>(null);
  const [busy, setBusy] = useState(false);
  // A form or privacy policy replaced since this page loaded (D122): trying again would send
  // the old version again, so the way on is a reload (the draft is saved and in the address).
  const [outdated, setOutdated] = useState(false);
  // One key per grant, kept while retrying (D29).
  const publishKey = useRef(newIdempotencyKey());
  const f = draft.fields;
  // The picture as the story has it now (M2 plan PR 10).
  const picture = useEarlierPicture(calls, draft.draftId)?.image ?? null;
  const themeNames = f.themeIds
    .flatMap((id) => themes.flatMap((c) => c.themes).filter((t) => t.id === id))
    .map((t) => t.name);

  async function submit() {
    if (outdated || waiting || !sharingKnown) return;
    if (askPublish && !publishBox) {
      setProblem(
        'The publishing consent can’t be shown right now, so your story can’t be submitted yet. It’s saved; please try again later.',
      );
      return;
    }
    if (askPublish && !publish) {
      setProblem('Tick the box to publish your story once it’s approved.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const saved = await draft.flush();
      const { draftId, version } = draft.current();
      if (!saved || !draftId || !version) {
        setProblem('Your latest changes aren’t saved yet. Please try again.');
        return;
      }
      if (askPublish && legal.testimony) {
        await calls.grant(
          'testimony',
          legal.testimony.version,
          legal.testimony.privacyVersion,
          'publish',
          publishKey.current,
        );
      }
      if (askPublish) await refreshConsents();
      // The submission being tried, kept by the draft (per person and draft, in this tab's
      // storage) across failures that leave its outcome unknown: no answer, an unreadable one,
      // or a server error. Trying again, after Back or a reload too, replays it, even if it went
      // through and the answer was lost (Codex #118). Settled after a definite refusal, or
      // replaced when the draft has changed. Its body (sharing, O4) is kept with it.
      const tried = draft.beginSubmit(
        draftId,
        version,
        socialBox && social && legal.social
          ? {
              formVersion: legal.social.version,
              privacyPolicyVersion: legal.social.privacyVersion,
            }
          : undefined,
      );
      setKept(tried);
      const result = await calls.submit(
        tried.draftId,
        tried.version,
        tried.key,
        tried.share,
      );
      draft.settleSubmit(draftId);
      draft.setVersion(result.version);
      draft.forget();
      onDone();
    } catch (err) {
      const unknown =
        err instanceof ApiUserUnavailable ||
        (err instanceof ApiUserProblem && err.status >= 500);
      const { draftId } = draft.current();
      if (!unknown && draftId) {
        // Refused: nothing was submitted or shared; the box is the person's again.
        draft.settleSubmit(draftId);
        setKept(null);
      }
      const changed =
        err instanceof StaleVersion ||
        (err instanceof ApiUserProblem &&
          (err.code === 'story_not_submittable' ||
            err.code === 'story_locked'));
      if (
        err instanceof ApiUserProblem &&
        (err.code === 'form_version_not_in_force' ||
          err.code === 'legal_document_not_in_force')
      ) {
        setOutdated(true);
        setProblem(
          'Our privacy policy or consent form was updated while you were writing. Your story is saved. Reload the page to read the new version, then submit.',
        );
      } else if (changed && draftId) {
        // Already submitted (a submission whose answer was lost, then retried with another
        // key): "Thank you", not an error. Otherwise it changed elsewhere: check it again.
        if (!(await draft.load(draftId))) {
          onDone();
          return;
        }
        setProblem(
          'Your story was changed in another tab or window. Check it, then submit again.',
        );
      } else if (err instanceof ApiUserUnavailable) {
        setProblem(
          'We can’t reach our server right now. Your story is saved; please try again in a moment.',
        );
      } else if (err instanceof ApiUserProblem) {
        const p = err.problem as ApiUserProblem['problem'] & {
          availableAt?: string;
        };
        if (p.code === 'weekly_submission_limit_reached' && p.availableAt) {
          // The numbers on the page were stale: the server's answer says it, and they follow.
          refreshLimits();
          setProblem(
            `You’ve sent as many stories for review as you can this week. Your story is saved as a draft: you can submit it from ${formatWhen(new Date(p.availableAt))}.`,
          );
        } else if (p.code === 'story_text_too_short') {
          setProblem(
            <>
              Your story needs at least{' '}
              {limits.storyText.min.toLocaleString('en-GB')} characters to be
              submitted.{' '}
              <button
                type="button"
                className="min-h-11 font-semibold text-link underline"
                onClick={() => onEdit('write')}
              >
                Keep writing
              </button>
            </>,
          );
        } else if (
          p.code === 'story_text_too_long' ||
          p.code === 'theme_count'
        ) {
          // The limits in force apply to every submission (Joel, 2026-10-30): the server's
          // message says which limit and its value; the person edits the draft, then submits.
          const tooLong = p.code === 'story_text_too_long';
          setProblem(
            <>
              {plainMessage(
                err,
                tooLong
                  ? 'Your story is longer than the current limit. Shorten it, then submit.'
                  : `${themeRule(limits.themes.min, limits.themes.max)}, then submit.`,
              )}{' '}
              <button
                type="button"
                className="min-h-11 font-semibold text-link underline"
                onClick={() => onEdit(tooLong ? 'write' : 'details')}
              >
                {tooLong ? 'Shorten it' : 'Change themes'}
              </button>
            </>,
          );
        } else if (
          p.code === 'media_not_uploaded' ||
          p.code === 'media_failed' ||
          p.code === 'media_over_limit'
        ) {
          setProblem(
            <>
              {plainMessage(
                err,
                `Your ${NOUN[draft.format]} isn’t ready to submit yet.`,
              )}{' '}
              <button
                type="button"
                className="min-h-11 font-semibold text-link underline"
                onClick={() => onEdit('write')}
              >
                Go to your upload
              </button>
            </>,
          );
        } else if (p.code === 'image_not_uploaded') {
          setProblem(
            <>
              {plainMessage(err, 'Your picture hasn’t finished uploading.')}{' '}
              <button
                type="button"
                className="min-h-11 font-semibold text-link underline"
                onClick={() => onEdit('write')}
              >
                Go to your picture
              </button>
            </>,
          );
        } else if (p.code === 'themes_changed') {
          // A7: a chosen theme was deleted meanwhile. The list is read again and the person
          // chooses again (useDraft clears the choice when a save says so; here, submit did).
          draft.update({ themeIds: [] });
          refreshThemes();
          setProblem(
            <>
              {plainMessage(err, 'Themes have changed, please choose again')}.{' '}
              <button
                type="button"
                className="min-h-11 font-semibold text-link underline"
                onClick={() => onEdit('details')}
              >
                Choose themes
              </button>
            </>,
          );
        } else {
          setProblem(
            plainMessage(
              err,
              'Your story couldn’t be submitted. Please try again.',
            ),
          );
        }
      } else {
        setProblem('Your story couldn’t be submitted. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const row = (label: string, value: React.ReactNode, edit: Step) => (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-border py-3">
      <dt className="text-sm text-secondary-text">{label}</dt>
      <dd className="order-3 w-full [overflow-wrap:anywhere]">{value}</dd>
      <button
        type="button"
        className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm font-semibold text-link"
        aria-label={`Change ${label.toLowerCase()}`}
        onClick={() => onEdit(edit)}
      >
        Change
      </button>
    </div>
  );

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <StepHeading heading={heading}>Review and submit</StepHeading>
      <dl>
        {row('Title', <span id="review-title">{f.title}</span>, 'write')}
        {row('Name shown', f.bylineName.trim() || 'Anonymous', 'details')}
        {row('Description', f.description.trim() || '—', 'details')}
        {row('Themes', themeNames.join(', ') || '—', 'details')}
        {draft.format === 'written'
          ? row(
              'Your story',
              <p className="max-h-64 overflow-y-auto whitespace-pre-wrap">
                {f.body}
              </p>,
              'write',
            )
          : row(`Your ${NOUN[draft.format]}`, 'Uploaded', 'write')}
        {picture &&
          row(
            draft.format === 'video' ? 'Thumbnail' : 'Picture',
            <div
              data-review-picture=""
              className="max-w-64 overflow-hidden rounded-lg bg-surface"
              style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
            >
              {picture.url && (
                // A signed link, at a size already known.
                <img
                  src={picture.url}
                  alt={picture.alt ?? 'Your picture'}
                  width={picture.width}
                  height={picture.height}
                  className="block h-full w-full object-cover"
                />
              )}
            </div>,
            'write',
          )}
      </dl>
      <div className="mt-6 flex flex-col gap-3">
        {askPublish ? (
          publishBox && legal.testimony ? (
            <div data-grant="publish">
              <Checkbox
                checked={publish}
                onChange={setPublish}
                className="rounded-xl border border-border bg-accent p-[12px] sm:p-4"
              >
                {publishBox.label}
              </Checkbox>
              {/* The privacy policy this grant names, even when the consent step was skipped
                  (consented before, under an earlier one). */}
              <PrivacyPolicy form={legal.testimony} className="mt-2" />
            </div>
          ) : (
            <p role="alert" className="text-destructive">
              The publishing consent can’t be shown right now, so your story
              can’t be submitted yet. It’s saved; please try again later.
            </p>
          )
        ) : (
          <p className="text-sm text-secondary-text">
            You’ve agreed to your stories being published on heisreal.today once
            a moderator approves them.
          </p>
        )}
        {sharing === 'loading' && (
          <p data-sharing="loading" className="text-sm text-secondary-text">
            Checking this story’s sharing choice…
          </p>
        )}
        {sharing === 'error' && (
          <div data-sharing="error" role="alert" className="text-destructive">
            <p>
              We couldn’t check whether this story may be shared beyond
              heisreal.today, so it can’t be submitted yet. It’s saved.
            </p>
            <button
              type="button"
              className="min-h-11 font-semibold text-link underline"
              onClick={() => void readSharing()}
            >
              Try again
            </button>
          </div>
        )}
        {alreadyShared && storyId && (
          // The story's own choice, with the way to stop it (O4): the same as My submissions.
          // Submitting leaves it as it is.
          <div data-shared="">
            <p className="mb-2 font-semibold">
              Already shared beyond heisreal.today
            </p>
            <StorySharing
              storyId={storyId}
              titleId="review-title"
              status="draft"
              sharing={{ granted: true, counts: true }}
              form={legal.social}
              api={() => api}
              onChanged={readSharing}
            />
          </div>
        )}
        {socialBox && legal.social && (
          <div
            data-grant="share_socials"
            className="rounded-xl border border-border p-[12px] sm:p-4"
          >
            <Checkbox
              checked={social}
              onChange={setSocial}
              disabled={!!kept}
              describedBy={kept ? 'social-kept' : undefined}
            >
              {socialBox.label}{' '}
              <span className="text-secondary-text">
                (optional, for this story only)
              </span>
            </Checkbox>
            {kept && (
              <p id="social-kept" className="mt-2 text-sm text-secondary-text">
                Kept as you sent it, until we know whether your story was
                submitted.
              </p>
            )}
            <details className="mt-2">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-link">
                What sharing beyond heisreal.today means
              </summary>
              <div className="mt-2">
                <LegalHtml html={legal.social.html} />
              </div>
            </details>
            {/* The privacy policy this grant names, unless the same one is shown above. */}
            {!(
              askPublish &&
              publishBox &&
              legal.social.privacyVersion === legal.testimony?.privacyVersion
            ) && <PrivacyPolicy form={legal.social} className="mt-2" />}
          </div>
        )}
      </div>
      {waiting && (
        <div className="mt-4 rounded-xl bg-surface px-4 py-3">
          <SubmissionsLeft limits={limits} id="submit-waiting" />
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-4 text-destructive">
          {problem}
        </p>
      )}
      <Actions>
        <button
          type="button"
          className={secondary}
          onClick={() => onEdit('details')}
        >
          Back
        </button>
        {outdated ? (
          <button
            type="button"
            className={primary}
            onClick={() => window.location.reload()}
          >
            Reload the page
          </button>
        ) : (
          <button
            type="submit"
            className={primary}
            disabled={busy || waiting || !sharingKnown}
            aria-describedby={waiting ? 'submit-waiting' : undefined}
          >
            {busy ? 'Submitting…' : 'Submit for review'}
          </button>
        )}
      </Actions>
      <p className="mt-4 text-sm text-secondary-text">
        Our team reads every story before it’s published.
      </p>
    </form>
  );
}

function DoneStep({ heading }: { heading: HeadingRef }) {
  return (
    <div className="text-center">
      <StepHeading heading={heading}>
        Thank you for sharing your story
      </StepHeading>
      <p className="mb-6 text-secondary-text">
        It’s waiting for review. Our team reads every story before it goes on
        the site.
      </p>
      <div className="flex flex-col justify-center gap-3 sm:flex-row">
        <a href="/stories" className={primary}>
          Read other stories
        </a>
        <a href="/" className={secondary}>
          Home
        </a>
      </div>
    </div>
  );
}
