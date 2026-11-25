'use client';

import { TextLink } from '@/components/page/text-link';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { AdminAccess, useRole } from '@/components/admin/admin-access';
import {
  BLOCK_NOTE_MAX,
  BlockNoteField,
  blockNoteBody,
  blockNoteTooLong,
} from '@/components/admin/admin-block-list';
import { StoryArticle } from '@/components/stories/story-view';
import {
  Button,
  Card,
  DangerZone,
  Field,
  FieldHint,
  FieldLabel,
  Heading,
  Notice,
  proseClasses,
  Text,
  Textarea,
} from '@heisreal/web-ui';
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
  | { status: 'failed'; message: ReactNode }
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
  returnedToQueue: 'Put back in the waiting list',
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

/**
 * The states with something to decide (G5, G24; a rejection can be overturned, OV-1 C); a story
 * being edited is read only (MD-4).
 */
const DECIDABLE: ModerationStory['status'][] = [
  'pending',
  'approved',
  'hidden',
  'rejected',
];

/**
 * /moderation/{id} (M3 task 3.2; M3 plan PR 6; MD-4): one story in any state the moderators'
 * list shows (drafts never sent for Admins only, MD-3), or a published one, for Moderators and up
 * (api-admin checks it too, M3 plan concern C2). The story shows as the public would see it,
 * through the story page's own parts, with the player's speed menu on; then what the moderator
 * can do with it (approve, send back or reject a waiting story; hide a published one, G5; show a
 * taken-down one again, send it back or reject it, OV-2 A; approve a rejected one, send it back or
 * put it back in the waiting list, OV-1 C; nothing for one being edited;
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
type ReviewNotice = { text: ReactNode; tone: 'done' | 'refreshed' } | null;

function Review({ id, client }: { id: string; client: ApiUser }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [notice, setNotice] = useState<ReviewNotice>(null);
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
    (next: ReviewNotice) => {
      setStale(false);
      setNotice(next);
      reload();
    },
    [reload],
  );

  const noticeLine = notice && (
    <Notice
      kind={notice.tone === 'done' ? 'success' : 'info'}
      as="p"
      ref={noticeRef}
      tabIndex={-1}
      role="status"
      className="mx-auto mb-6 max-w-measure outline-none"
      data-review-notice={notice.tone}
    >
      <strong>{notice.text}</strong>
    </Notice>
  );

  if (loaded.status === 'loading') {
    return (
      <>
        {noticeLine}
        <Text tone="quiet">Loading the story…</Text>
      </>
    );
  }
  if (loaded.status === 'gone') {
    return (
      <>
        {noticeLine}
        <Card asChild className="p-6">
          <p data-review-gone="">
            This story isn’t here any more. It may have been deleted.{' '}
            <TextLink href="/moderation" touch>
              Back to the list
            </TextLink>
          </p>
        </Card>
      </>
    );
  }
  if (loaded.status === 'failed') {
    return (
      <>
        {noticeLine}
        <Notice kind="danger" as="p" role="alert" data-moderation-error="">
          {loaded.message}
        </Notice>
      </>
    );
  }
  const { story } = loaded;
  return (
    <>
      {noticeLine}
      {stale && (
        <Notice
          kind="warning"
          role="status"
          className="mx-auto mb-6 max-w-measure"
          data-review-stale=""
        >
          <Text weight="bold" className="mb-3">
            This story changed while you had it open.
          </Text>
          <Button
            variant="outline"
            wrap
            onClick={() => {
              setStale(false);
              setNotice(null);
              reload();
            }}
          >
            Reload to see it
          </Button>
        </Notice>
      )}
      <Heading
        as="p"
        size="eyebrow"
        className="mx-auto mb-8 max-w-measure"
        data-review-status={story.status}
      >
        {statusLabel(story)}
      </Heading>
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
  const startNote = blockNoteStart(story);
  return (
    <Card
      className="mx-auto mb-6 max-w-measure space-y-3 p-4 [overflow-wrap:anywhere]"
      data-sender=""
    >
      {story.senderEmail && (
        <SenderLine
          kind="emails"
          value={story.senderEmail}
          blocked={story.senderEmailBlocked === true}
          startNote={startNote}
          client={client}
        >
          Sent with email{' '}
          <code className={proseClasses.code}>{story.senderEmail}</code>. Only
          admins see this.
        </SenderLine>
      )}
      {story.senderIp && (
        <SenderLine
          kind="ips"
          value={story.senderIp}
          blocked={story.senderIpBlocked === true}
          startNote={startNote}
          client={client}
        >
          Sent from IP address{' '}
          <code className={proseClasses.code}>{story.senderIp}</code>. Only
          admins see this, for 30 days.
        </SenderLine>
      )}
    </Card>
  );
}

/**
 * BN-7 A (Joel 2026-11-22): a block note starts with the story's title and the day it was sent,
 * e.g. `Story "Buy cheap…" (sent 20 Nov 2026): `, for the Admin to add why (or clear).
 */
function blockNoteStart(story: ModerationStory): string {
  const sent = story.submittedAt
    ? ` (sent ${new Date(story.submittedAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })})`
    : '';
  // Capped so the start alone fits a note (BN-2): a long title is shortened with "…".
  const room = BLOCK_NOTE_MAX - [...`Story ""${sent}: `].length;
  const chars = [...story.title];
  const title =
    chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : story.title;
  return `Story "${title}"${sent}: `;
}

/**
 * One of the sender's details with its inline Block: Block, then a short confirm with the note
 * box (BN-7 A, started with `startNote`), then "Blocked".
 */
function SenderLine({
  kind,
  value,
  blocked: blockedAtLoad,
  startNote,
  client,
  children,
}: {
  kind: 'emails' | 'ips';
  value: string;
  blocked: boolean;
  startNote: string;
  client: ApiUser;
  children: ReactNode;
}) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy' | 'done'>(
    blockedAtLoad ? 'done' : 'idle',
  );
  const [error, setError] = useState<ReactNode>(null);
  const [note, setNote] = useState(startNote);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const open = step === 'confirm' || step === 'busy';
  // Opening the confirm moves to the note box, with the cursor after the story's title and date.
  useEffect(() => {
    const box = noteRef.current;
    if (!open || !box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [open]);
  const block = async () => {
    if (blockNoteTooLong(note)) return;
    setStep('busy');
    setError(null);
    try {
      await client.command(
        `/v1/admin/block-list/${kind}/${encodeURIComponent(value)}`,
        { method: 'PUT', body: blockNoteBody(note) },
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
        <Text weight="bold" className="mt-1" data-sender-blocked="">
          Blocked
        </Text>
      ) : step === 'idle' ? (
        <Button
          variant="outline"
          wrap
          className="mt-2"
          onClick={() => setStep('confirm')}
        >
          Block
        </Button>
      ) : (
        <div className="mt-2" role="group" aria-label={`Block ${value}`}>
          <p className="mb-2">
            Block <code className={proseClasses.code}>{value}</code>? It stays
            until an Admin removes it.
          </p>
          <div className="mb-3">
            <BlockNoteField
              value={note}
              onChange={setNote}
              textareaRef={noteRef}
            />
          </div>
          {error && (
            <Text role="alert" tone="danger" className="mb-2">
              {error}
            </Text>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              wrap
              variant="danger"
              disabled={step === 'busy'}
              onClick={() => void block()}
            >
              Block
            </Button>
            <Button
              variant="outline"
              wrap
              disabled={step === 'busy'}
              onClick={() => {
                setError(null);
                setNote(startNote);
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

const NOTED: Record<
  Noted,
  {
    label: string;
    hint: string;
    confirm: string;
    confirmVariant: 'default' | 'caution' | 'danger';
    field: string;
    /** Why the button is greyed out before anything is typed (OT-2 A). */
    empty: string;
  }
> = {
  'request-changes': {
    label: 'Your note to the person',
    hint: 'They see it as “What our team said”, with their story to change. Write kindly: thank them, and say what would help.',
    confirm: 'Send back',
    confirmVariant: 'caution',
    field: 'feedbackToSubmitter',
    empty: 'Write a note first.',
  },
  reject: {
    label: 'Your note to the person',
    hint: 'They see it as “What our team said”. Write kindly: thank them for sharing, and say why it can’t go on the site.',
    confirm: 'Reject',
    confirmVariant: 'danger',
    field: 'feedbackToSubmitter',
    empty: 'Write a note first.',
  },
  hide: {
    label: 'Why it’s being taken down',
    hint: 'The person can read this, as “What our team said”, beside “Taken down by our team” on their profile.',
    confirm: 'Take down',
    confirmVariant: 'default',
    field: 'reason',
    empty: 'Write a reason first.',
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
      <Field id={noteId} hint describedBy={`${noteId}-count`}>
        <FieldLabel>{noted.label}</FieldLabel>
        <FieldHint className="mb-2">{noted.hint}</FieldHint>
        <Textarea
          ref={noteRef}
          className="min-h-40"
          maxLength={NOTE_MAX}
          value={note}
          required
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <Text id={`${noteId}-count`} size="small" tone="quiet" className="mt-1">
        {noteLength.toLocaleString('en-GB')} /{' '}
        {NOTE_MAX.toLocaleString('en-GB')} characters
      </Text>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          type="submit"
          wrap
          variant={noted.confirmVariant}
          disabled={busy || noteLength === 0}
          disabledReason={!busy && noteLength === 0 ? noted.empty : undefined}
        >
          {noted.confirm}
        </Button>
        <Button
          type="button"
          variant="outline"
          wrap
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
  onSettled: (notice: ReviewNotice) => void;
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

  return (
    <Card
      asChild
      className="mx-auto mt-12 w-full max-w-measure min-w-0 p-4 sm:p-6"
    >
      <section
        aria-labelledby="decide-heading"

        data-decisions={story.status}
      >
        <Heading level={2} id="decide-heading" className="mb-4">
          {story.status === 'pending'
            ? 'Your decision'
            : story.status === 'rejected'
              ? 'Overturn the rejection'
              : decidable
                ? 'On the site'
                : 'Admin'}
        </Heading>
        {!open && decidable && (
          <div className="flex flex-wrap gap-3">
            {story.status === 'hidden' && (
              <Button wrap disabled={busy} onClick={() => void decide('show')}>
                Show again
              </Button>
            )}
            {(story.status === 'pending' || story.status === 'rejected') && (
              <Button
                wrap
                disabled={busy}
                onClick={() => void decide('approve')}
              >
                Approve
              </Button>
            )}
            {['pending', 'hidden', 'rejected'].includes(story.status) && (
              <Button
                wrap
                variant="caution"
                disabled={busy}
                onClick={() => setOpen('request-changes')}
              >
                Send back
              </Button>
            )}
            {(story.status === 'pending' || story.status === 'hidden') && (
              <Button
                wrap
                variant="danger"
                disabled={busy}
                onClick={() => setOpen('reject')}
              >
                Reject
              </Button>
            )}
            {story.status === 'rejected' && (
              <Button
                variant="outline"
                wrap
                disabled={busy}
                onClick={() => void decide('return-to-queue')}
              >
                Put back in the waiting list
              </Button>
            )}
            {story.status === 'approved' && (
              <Button
                variant="outline"
                wrap
                disabled={busy}
                onClick={() => setOpen('hide')}
              >
                Take down
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
          <Notice
            kind="warning"
            role="alert"
            className="mt-4"
            data-decision-refused=""
          >
            <p>{refusal.message}</p>
            {anywayRoute && isAdmin && (
              <Button
                variant="outline"
                wrap
                className="mt-3"
                disabled={busy}
                onClick={() =>
                  void decide(anywayRoute, { approveAnyway: true })
                }
              >
                {anywayRoute === 'show' ? 'Show anyway' : 'Approve anyway'}
              </Button>
            )}
          </Notice>
        )}
        {isAdmin && !open && (
          // DL-1 A (as changed): an Admin's Delete stands apart from Reject, in the Danger zone;
          // its "Are you sure?" step sits in place of the button.
          <DangerZone
            title="Danger zone (Admins)"
            className={decidable ? 'mt-6' : undefined}
            open={confirmDelete}
            onOpenChange={(next) => {
              setConfirmDelete(next);
              setRefusal(null);
            }}
            disabled={busy}
            busy={sending}
            confirmProps={{ 'data-confirm-delete': '' }}
            question="Delete this story for good?"
            detail={
              <p>
                Its text and any video or audio go too
                {story.status === 'approved'
                  ? ', and it comes off the site'
                  : ''}
                . The person isn’t told, beyond it leaving their submissions.
                This can’t be undone.
              </p>
            }
            confirmLabel={sending ? 'Deleting…' : 'Delete story'}
            onConfirm={() => void remove()}
          />
        )}
      </section>
    </Card>
  );
}

/** Why there is no player yet: the file is still being processed, or couldn't be. */
function MediaNote({ story }: { story: ModerationStory }) {
  const media = story.media[0];
  if (!media || media.processing === 'ready') return null;
  const what = media.format === 'audio' ? 'audio file' : 'video';
  return (
    <Notice
      kind={media.processing === 'failed' ? 'danger' : 'info'}
      as="p"
      className="mx-auto mb-6 max-w-measure"
      data-media-note={media.processing ?? 'processing'}
    >
      {media.processing === 'failed'
        ? `This ${what} couldn’t be processed, so it can’t be played.`
        : `This ${what} is still being processed. Reload the page in a few minutes to watch it.`}
    </Notice>
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
      <Heading level={2} id="history-heading" className="mb-4">
        History
      </Heading>
      <ol className="space-y-4" data-history="">
        {entries.map((e, i) => (
          <li
            key={`${e.at}-${i}`}
            className="border-l-[3px] border-border pl-4"
            data-history-entry={e.action}
          >
            <p>
              <strong>
                {e.action === 'sent' &&
                entries.slice(0, i).some((p) => p.action === 'sent')
                  ? 'Sent again'
                  : e.action === 'fileUnusable' && format === 'audio'
                    ? 'Sent back automatically: the recording couldn’t be processed'
                    : (STEP_LABEL[e.action] ?? e.action)}
              </strong>
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
            <Text size="small" tone="quiet">
              <time dateTime={e.at}>{sentAt(e.at)}</time>
            </Text>
            {e.comment && (
              <div className="mt-2">
                <Text size="small" weight="bold">
                  {e.action === 'hiddenByModerator'
                    ? 'Why it was taken down'
                    : 'Note to the person'}
                </Text>
                <Text
                  as="blockquote"
                  tone="quiet"
                  italic
                  className="whitespace-pre-line"
                >
                  {e.comment}
                </Text>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
