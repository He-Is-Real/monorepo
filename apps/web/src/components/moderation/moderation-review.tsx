'use client';

import Link from 'next/link';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  AdminAccess,
  useRole,
  WRAPPING_BUTTON,
} from '@/components/admin/admin-access';
import { StoryArticle } from '@/components/stories/story-view';
import { Button } from '@heisreal/web-ui';
import { type ApiUser, ApiUserProblem } from '@/lib/api-user';
import {
  decisionRefusal,
  type DecisionRoute,
  DONE,
  type ModerationStory,
  moderationProblem,
  type Refusal,
  sentAt,
  stateLabel,
  type StatusEntry,
} from './moderation-api';

type Loaded =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; story: ModerationStory };

/**
 * How often an open review page checks whether the story changed (Part 1a: it can be sent back
 * automatically while a moderator has it open), as well as whenever the tab comes back into view.
 */
const RECHECK_MS = 60_000;

/** Longest note a moderator may write (api-admin's limit). */
const NOTE_MAX = 2000;

/** Each status log entry by what happened (its action). */
const STEP_LABEL: Record<string, string> = {
  sent: 'Sent for review',
  editStarted: 'Taken down to edit',
  changesRequested: 'Sent back',
  // Part 1a: the system's own line ("automatically" is in the label, so no actor after it).
  fileUnusable: 'Sent back automatically: the video couldn’t be processed',
  approved: 'Approved',
  rejected: 'Rejected',
  hiddenBySystem: 'Hidden while its video or audio can’t play',
  shownBySystem: 'Shown again',
  hiddenByModerator: 'Taken down',
  shownByModerator: 'Shown again',
  fileReplaced: 'New video or audio file',
  pictureReplaced: 'New picture',
  wordsChanged: 'Words changed',
};

const ACTOR_LABEL: Record<StatusEntry['actor'], string> = {
  person: 'by the person',
  moderator: 'by a moderator',
  system: 'automatically',
};

/** Entries that record a change without moving the story (they carry its state as it was). */
const HISTORY_ONLY = ['fileReplaced', 'pictureReplaced', 'wordsChanged'];

/** The newest entry that moved the story: what put it in its state. */
const currentAction = (story: ModerationStory): string | null =>
  [...story.statusLog].reverse().find((e) => !HISTORY_ONLY.includes(e.action))
    ?.action ?? null;

/** What the page says the story is now, from its newest entry that moved it (MD-4's labels). */
function statusLabel(story: ModerationStory): string {
  if (story.status === 'editing' && !story.submittedAt) {
    return stateLabel('draft', null);
  }
  return stateLabel(story.status, currentAction(story));
}

/** The states with something to decide (G5, G24); the rest are read only (MD-4). */
const DECIDABLE: ModerationStory['status'][] = [
  'pending',
  'approved',
  'hidden',
];

/**
 * /moderation/{id} (M3 task 3.2; M3 plan PR 6; MD-4): one story in any state the moderators'
 * list shows (drafts never sent for Admins only, MD-3), or a published one, for Moderators and up
 * (api-admin checks it too, M3 plan concern C2). The story shows as the public would see it,
 * through the story page's own parts, with the player's speed menu on; then what the moderator
 * can do with it (approve, send back or reject a waiting story; hide a published one, G5; show a
 * hidden one again, or reject one the site hid, P1-9; nothing for one being edited or rejected;
 * Admins can also delete it in any state, P1-11) and its history, with moderators' notes.
 */
export function ModerationReview({
  id,
  apiAdminUrl,
}: {
  id: string;
  apiAdminUrl?: string;
}) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl} min="Moderator">
      {(client) => <Review id={id} client={client} />}
    </AdminAccess>
  );
}

/** A note above the story: what was done, or why the page refreshed. */
type Notice = { text: string; tone: 'done' | 'refreshed' } | null;

function Review({ id, client }: { id: string; client: ApiUser }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [notice, setNotice] = useState<Notice>(null);
  // The story changed since the page read it: the page stays as it is until the moderator reloads.
  const [stale, setStale] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const load = useRef(0);

  const reload = useCallback(() => {
    const mine = ++load.current;
    client
      .get<ModerationStory>(`/v1/moderation/stories/${encodeURIComponent(id)}`)
      .then(
        ({ data }) => {
          if (load.current !== mine) return;
          setLoaded(
            data
              ? { status: 'ready', story: data }
              : { status: 'failed', message: moderationProblem(undefined) },
          );
        },
        (err: unknown) => {
          if (load.current !== mine) return;
          setLoaded(
            err instanceof ApiUserProblem && err.status === 404
              ? { status: 'gone' }
              : { status: 'failed', message: moderationProblem(err) },
          );
        },
      );
  }, [client, id]);

  useEffect(() => reload(), [reload]);

  // Part 1a: while the page is open, check now and then (and whenever the tab is back in view)
  // whether the story changed; if it was sent back automatically or changed meanwhile, the page
  // says so and its decisions are disabled until the moderator reloads it. It never replaces
  // itself, so a note being typed stays in its box.
  useEffect(() => {
    if (loaded.status !== 'ready' || stale) return;
    const shown = loaded.story;
    let stopped = false;
    const recheck = () => {
      if (document.visibilityState !== 'visible') return;
      client
        .get<ModerationStory>(
          `/v1/moderation/stories/${encodeURIComponent(id)}`,
        )
        .then(
          ({ data }) => {
            if (stopped || !data) return;
            if (data.version === shown.version && data.status === shown.status)
              return;
            setStale(true);
          },
          (err: unknown) => {
            if (!stopped && err instanceof ApiUserProblem && err.status === 404)
              reload();
          },
        );
    };
    const timer = setInterval(recheck, RECHECK_MS);
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [client, id, loaded, reload, stale]);

  // Move to the notice, so a moderator (and a screen reader) learns what happened at once.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  /** After a decision, or a refusal because the story moved on: say so and read it again. */
  const settled = useCallback(
    (next: Notice) => {
      setStale(false);
      setNotice(next);
      reload();
    },
    [reload],
  );

  const noticeLine = notice && (
    <p
      ref={noticeRef}
      tabIndex={-1}
      role="status"
      className="mx-auto mb-6 max-w-measure rounded-2xl border border-link bg-card p-4 font-semibold outline-none"
      data-review-notice={notice.tone}
    >
      {notice.text}
    </p>
  );

  if (loaded.status === 'loading') {
    return (
      <>
        {noticeLine}
        <p className="text-secondary-text">Loading the story…</p>
      </>
    );
  }
  if (loaded.status === 'gone') {
    return (
      <>
        {noticeLine}
        <p
          className="rounded-2xl border border-border bg-card p-6"
          data-review-gone=""
        >
          This story isn’t here any more. It may have been deleted.{' '}
          <Link href="/moderation">Back to the list</Link>
        </p>
      </>
    );
  }
  if (loaded.status === 'failed') {
    return (
      <>
        {noticeLine}
        <p
          role="alert"
          className="rounded-2xl border border-destructive bg-card p-6"
          data-moderation-error=""
        >
          {loaded.message}
        </p>
      </>
    );
  }
  const { story } = loaded;
  return (
    <>
      {noticeLine}
      {stale && (
        <div
          role="status"
          className="mx-auto mb-6 max-w-measure rounded-2xl border border-link bg-card p-4"
          data-review-stale=""
        >
          <p className="mb-3 font-semibold">
            This story changed while you had it open.
          </p>
          <Button
            variant="outline"
            className={WRAPPING_BUTTON}
            onClick={() => {
              setStale(false);
              setNotice(null);
              reload();
            }}
          >
            Reload to see it
          </Button>
        </div>
      )}
      <p
        className="mx-auto mb-8 max-w-measure text-sm font-semibold text-link"
        data-review-status={story.status}
      >
        {statusLabel(story)}
      </p>
      <Sender
        key={`${story.id} ${story.senderEmailBlocked} ${story.senderIpBlocked}`}
        story={story}
        client={client}
      />
      <MediaNote story={story} />
      <StoryArticle
        story={story}
        speedMenu
        dateLine={
          story.submittedAt ? (
            <>
              Sent for review{' '}
              <time dateTime={story.submittedAt}>
                {sentAt(story.submittedAt)}
              </time>
            </>
          ) : (
            'Never sent for review'
          )
        }
        after={
          <>
            <Decisions
              key={story.reviewTag}
              story={story}
              client={client}
              stale={stale}
              onSettled={settled}
            />
            <History entries={story.statusLog} format={story.primaryFormat} />
          </>
        }
      />
    </>
  );
}

/**
 * Block list (G21 D, G24; EM-1 B, EM-2: Joel 2026-11-17): the email and the IP address the story
 * was sent with, which api-admin gives Admins only (the address for 30 days, the email as long as
 * the story), each with a Block button that blocks it here, without leaving the page. The Block
 * list page stays for the overview, manual blocking and unblocking.
 */
function Sender({
  story,
  client,
}: {
  story: ModerationStory;
  client: ApiUser;
}) {
  if (!story.senderEmail && !story.senderIp) return null;
  return (
    <div
      className="mx-auto mb-6 max-w-measure space-y-3 rounded-2xl border border-border bg-card p-4 [overflow-wrap:anywhere]"
      data-sender=""
    >
      {story.senderEmail && (
        <SenderLine
          kind="emails"
          value={story.senderEmail}
          blocked={story.senderEmailBlocked === true}
          client={client}
        >
          Sent with email <span className="font-mono">{story.senderEmail}</span>
          . Only admins see this.
        </SenderLine>
      )}
      {story.senderIp && (
        <SenderLine
          kind="ips"
          value={story.senderIp}
          blocked={story.senderIpBlocked === true}
          client={client}
        >
          Sent from IP address{' '}
          <span className="font-mono">{story.senderIp}</span>. Only admins see
          this, for 30 days.
        </SenderLine>
      )}
    </div>
  );
}

/** One of the sender's details with its inline Block: Block, then a short confirm, then "Blocked". */
function SenderLine({
  kind,
  value,
  blocked: blockedAtLoad,
  client,
  children,
}: {
  kind: 'emails' | 'ips';
  value: string;
  blocked: boolean;
  client: ApiUser;
  children: ReactNode;
}) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy' | 'done'>(
    blockedAtLoad ? 'done' : 'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (step === 'confirm') confirmRef.current?.focus();
  }, [step]);
  const block = async () => {
    setStep('busy');
    setError(null);
    try {
      await client.command(
        `/v1/admin/block-list/${kind}/${encodeURIComponent(value)}`,
        { method: 'PUT' },
      );
      setStep('done');
    } catch (err) {
      setError(moderationProblem(err));
      setStep('confirm');
    }
  };
  const attr = kind === 'emails' ? 'data-sender-email' : 'data-sender-ip';
  return (
    <div {...{ [attr]: value }}>
      <p>{children}</p>
      {step === 'done' ? (
        <p className="mt-1 font-semibold" data-sender-blocked="">
          Blocked
        </p>
      ) : step === 'idle' ? (
        <Button
          variant="outline"
          className={`mt-2 ${WRAPPING_BUTTON}`}
          onClick={() => setStep('confirm')}
        >
          Block
        </Button>
      ) : (
        <div className="mt-2" role="group" aria-label={`Block ${value}`}>
          <p ref={confirmRef} tabIndex={-1} className="mb-2 outline-none">
            Block <span className="font-mono">{value}</span>? It stays until an
            Admin removes it.
          </p>
          {error && (
            <p role="alert" className="mb-2 text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              className={`${WRAPPING_BUTTON} ${RED_BUTTON}`}
              disabled={step === 'busy'}
              onClick={() => void block()}
            >
              Block
            </Button>
            <Button
              variant="outline"
              className={WRAPPING_BUTTON}
              disabled={step === 'busy'}
              onClick={() => {
                setError(null);
                setStep('idle');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The form a decision opens: Send back, Reject and Hide need a note; Approve and Show don't. */
type Open = 'request-changes' | 'reject' | 'hide' | null;
export type Noted = Exclude<Open, null>;

/**
 * Decision colours (Joel, 17 November 2026): Send back is orange, Reject and Delete are red,
 * filled like Approve, on the decision button and on the confirm button it leads to.
 * Contrast (WCAG AA): light, white on warning 5.9:1 and on destructive 5.6:1; dark, near-black
 * on warning 8.6:1, and white on destructive at 80% over the card 5.6:1 (the dark destructive
 * token itself is 4.2:1 with white, 4.5:1 with black, so it isn't used as a solid fill).
 */
const SEND_BACK_BUTTON = 'bg-warning text-background hover:bg-warning/90';
const RED_BUTTON =
  'bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/80 dark:hover:bg-destructive/70';

const NOTED: Record<
  Noted,
  {
    label: string;
    hint: string;
    confirm: string;
    confirmColour: string;
    field: string;
  }
> = {
  'request-changes': {
    label: 'Your note to the person',
    hint: 'They see it as “What our team said”, with their story to change. Write kindly: thank them, and say what would help.',
    confirm: 'Send back',
    confirmColour: SEND_BACK_BUTTON,
    field: 'feedbackToSubmitter',
  },
  reject: {
    label: 'Your note to the person',
    hint: 'They see it as “What our team said”. Write kindly: thank them for sharing, and say why it can’t go on the site.',
    confirm: 'Reject',
    confirmColour: RED_BUTTON,
    field: 'feedbackToSubmitter',
  },
  hide: {
    label: 'Why it’s being taken down',
    hint: 'The person can read this, as “What our team said”, beside “Taken down by our team” on their profile.',
    confirm: 'Take down',
    confirmColour: '',
    field: 'reason',
  },
};

/**
 * The note a decision needs (1–2000 characters), and its confirm and Cancel buttons: the review
 * page's, and the Take down form on a published story's own page (MD-1: the same form).
 * `onSubmit` gets the body to send.
 */
export function NoteForm({
  kind,
  busy,
  onSubmit,
  onCancel,
}: {
  kind: Noted;
  busy: boolean;
  onSubmit: (body: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const noted = NOTED[kind];
  const [note, setNote] = useState('');
  const noteId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Opening a note moves to it.
  useEffect(() => noteRef.current?.focus(), []);
  const noteLength = [...note.trim()].length;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (noteLength === 0) return;
        onSubmit({ [noted.field]: note.trim() });
      }}
    >
      <label htmlFor={noteId} className="mb-1.5 block font-semibold">
        {noted.label}
      </label>
      <p id={`${noteId}-hint`} className="mb-2 text-sm text-secondary-text">
        {noted.hint}
      </p>
      <textarea
        ref={noteRef}
        id={noteId}
        className="min-h-40 w-full rounded-md border border-input bg-input-background px-3 py-2.5 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        maxLength={NOTE_MAX}
        value={note}
        required
        aria-describedby={`${noteId}-hint ${noteId}-count`}
        onChange={(e) => setNote(e.target.value)}
      />
      <p id={`${noteId}-count`} className="mt-1 text-sm text-secondary-text">
        {noteLength.toLocaleString('en-GB')} /{' '}
        {NOTE_MAX.toLocaleString('en-GB')} characters
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          type="submit"
          className={`${WRAPPING_BUTTON} ${noted.confirmColour}`}
          disabled={busy || noteLength === 0}
        >
          {noted.confirm}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={WRAPPING_BUTTON}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * What the moderator can do with the story in its state (G24: Moderators approve, send back,
 * reject, hide and show again; Admins also approve anyway, and delete it in any state after one
 * "This can't be undone" question, P1-11). Each decision (and Delete) names what the page
 * showed (`reviewTag`, G14 B). A refusal says why in plain words; when the story moved on (D-1:
 * another moderator decided first) the page says so and refreshes.
 */
function Decisions({
  story,
  client,
  stale,
  onSettled,
}: {
  story: ModerationStory;
  client: ApiUser;
  /** The story changed since the page read it: every button waits for a reload. */
  stale: boolean;
  onSettled: (notice: Notice) => void;
}) {
  const isAdmin = useRole() === 'Admin';
  const [open, setOpen] = useState<Open>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sending, setSending] = useState(false);
  const busy = sending || stale;
  const [refusal, setRefusal] = useState<
    (Refusal & { route: DecisionRoute | 'delete' }) | null
  >(null);
  async function decide(route: DecisionRoute, body?: unknown) {
    setSending(true);
    setRefusal(null);
    try {
      await client.command(
        `/v1/moderation/stories/${encodeURIComponent(story.id)}/${route}`,
        { method: 'POST', body, tag: story.reviewTag },
      );
      onSettled({ text: DONE[route], tone: 'done' });
    } catch (err) {
      refused(err, route);
    }
  }
  function refused(err: unknown, route: DecisionRoute | 'delete') {
    const why = decisionRefusal(err, story, route);
    if (why.refresh) {
      onSettled({ text: why.message, tone: 'refreshed' });
    } else {
      setRefusal({ ...why, route });
      setSending(false);
    }
  }
  /** P1-11: an Admin's Delete, as the owner's (ED-3); the page then says it's gone. */
  async function remove() {
    setSending(true);
    setRefusal(null);
    try {
      await client.command(
        `/v1/moderation/stories/${encodeURIComponent(story.id)}`,
        { method: 'DELETE' },
      );
      onSettled({ text: DONE.delete, tone: 'done' });
    } catch (err) {
      refused(err, 'delete');
    }
  }

  /** Approve or Show again, refused while the media is processing: an Admin may go anyway. */
  const anywayRoute =
    refusal?.anyway && refusal.route !== 'delete' ? refusal.route : null;
  const decidable = DECIDABLE.includes(story.status);
  if (!decidable && !isAdmin) return null;
  // P1-9: a story the site took off itself is resolved by rejecting it.
  const hiddenBySite =
    story.status === 'hidden' && currentAction(story) === 'hiddenBySystem';

  return (
    <section
      aria-labelledby="decide-heading"
      className="mx-auto mt-12 w-full max-w-measure min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-6"
      data-decisions={story.status}
    >
      <h2 id="decide-heading" className="mb-4 text-xl font-semibold">
        {story.status === 'pending'
          ? 'Your decision'
          : decidable
            ? 'On the site'
            : 'Admin'}
      </h2>
      {confirmDelete && (
        <div
          data-confirm-delete=""
          className="rounded-xl border border-border-hover p-4"
        >
          <p className="mb-3">
            Delete this story for good? Its text and any video or audio go too
            {story.status === 'approved' ? ', and it comes off the site' : ''}.
            The person isn’t told, beyond it leaving their submissions. This
            can’t be undone.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              autoFocus
              className={`${WRAPPING_BUTTON} ${RED_BUTTON}`}
              disabled={busy}
              onClick={() => void remove()}
            >
              {sending ? 'Deleting…' : 'Delete story'}
            </Button>
            <Button
              variant="outline"
              className={WRAPPING_BUTTON}
              disabled={busy}
              onClick={() => {
                setConfirmDelete(false);
                setRefusal(null);
              }}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}
      {!open && !confirmDelete && (
        <div className="flex flex-wrap gap-3">
          {story.status === 'pending' && (
            <>
              <Button
                className={WRAPPING_BUTTON}
                disabled={busy}
                onClick={() => void decide('approve')}
              >
                Approve
              </Button>
              <Button
                className={`${WRAPPING_BUTTON} ${SEND_BACK_BUTTON}`}
                disabled={busy}
                onClick={() => setOpen('request-changes')}
              >
                Send back
              </Button>
              <Button
                className={`${WRAPPING_BUTTON} ${RED_BUTTON}`}
                disabled={busy}
                onClick={() => setOpen('reject')}
              >
                Reject
              </Button>
            </>
          )}
          {story.status === 'approved' && (
            <Button
              variant="outline"
              className={WRAPPING_BUTTON}
              disabled={busy}
              onClick={() => setOpen('hide')}
            >
              Take down
            </Button>
          )}
          {story.status === 'hidden' && (
            <Button
              className={WRAPPING_BUTTON}
              disabled={busy}
              onClick={() => void decide('show')}
            >
              Show again
            </Button>
          )}
          {hiddenBySite && (
            <Button
              className={`${WRAPPING_BUTTON} ${RED_BUTTON}`}
              disabled={busy}
              onClick={() => setOpen('reject')}
            >
              Reject
            </Button>
          )}
          {isAdmin && (
            <Button
              className={`${WRAPPING_BUTTON} ${RED_BUTTON}`}
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>
      )}
      {open && (
        <NoteForm
          kind={open}
          busy={busy}
          onSubmit={(body) => void decide(open, body)}
          onCancel={() => {
            setOpen(null);
            setRefusal(null);
          }}
        />
      )}
      {refusal && (
        <div role="alert" className="mt-4" data-decision-refused="">
          <p>{refusal.message}</p>
          {anywayRoute && isAdmin && (
            <Button
              variant="outline"
              className={`${WRAPPING_BUTTON} mt-3`}
              disabled={busy}
              onClick={() => void decide(anywayRoute, { approveAnyway: true })}
            >
              {anywayRoute === 'show' ? 'Show anyway' : 'Approve anyway'}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** Why there is no player yet: the file is still being processed, or couldn't be. */
function MediaNote({ story }: { story: ModerationStory }) {
  const media = story.media[0];
  if (!media || media.processing === 'ready') return null;
  const what = media.format === 'audio' ? 'audio file' : 'video';
  return (
    <p
      className="mx-auto mb-6 max-w-measure rounded-2xl border border-border bg-card p-4"
      data-media-note={media.processing ?? 'processing'}
    >
      {media.processing === 'failed'
        ? `This ${what} couldn’t be processed, so it can’t be played.`
        : `This ${what} is still being processed. Reload the page in a few minutes to watch it.`}
    </p>
  );
}

/** The story's status log, oldest first, with moderators' notes to the person. */
function History({
  entries,
  format,
}: {
  entries: StatusEntry[];
  format: ModerationStory['primaryFormat'];
}) {
  return (
    <section
      aria-labelledby="history-heading"
      className="mx-auto mt-12 w-full max-w-measure min-w-0"
    >
      <h2 id="history-heading" className="mb-4 text-xl font-semibold">
        History
      </h2>
      <ol className="space-y-4" data-history="">
        {entries.map((e, i) => (
          <li
            key={`${e.at}-${i}`}
            className="border-l-[3px] border-border pl-4"
            data-history-entry={e.action}
          >
            <p>
              <span className="font-semibold">
                {e.action === 'sent' &&
                entries.slice(0, i).some((p) => p.action === 'sent')
                  ? 'Sent again'
                  : e.action === 'fileUnusable' && format === 'audio'
                    ? 'Sent back automatically: the recording couldn’t be processed'
                    : (STEP_LABEL[e.action] ?? e.action)}
              </span>
              {e.action !== 'fileUnusable' &&
                (e.actor === 'moderator' && e.staffEmail ? (
                  <>
                    {' '}
                    by{' '}
                    <span
                      className="[overflow-wrap:anywhere]"
                      data-staff-email={e.staffEmail}
                    >
                      {e.staffEmail}
                    </span>
                  </>
                ) : (
                  <> {ACTOR_LABEL[e.actor]}</>
                ))}
            </p>
            <p className="text-sm text-secondary-text">
              <time dateTime={e.at}>{sentAt(e.at)}</time>
            </p>
            {e.comment && (
              <div className="mt-2">
                <p className="text-sm font-semibold">
                  {e.action === 'hiddenByModerator'
                    ? 'Why it was taken down'
                    : 'Note to the person'}
                </p>
                <blockquote className="whitespace-pre-line text-secondary-text italic">
                  {e.comment}
                </blockquote>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
