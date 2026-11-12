'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AdminAccess,
  useRole,
  WRAPPING_BUTTON,
} from '@/components/admin/admin-access';
import { StoryArticle } from '@/components/stories/story-view';
import { Button } from '@/components/ui/button';
import { type ApiUser, ApiUserProblem } from '@/lib/api-user';
import {
  decisionRefusal,
  type DecisionRoute,
  DONE,
  type ModerationStory,
  moderationProblem,
  type Refusal,
  sentAt,
  type StatusEntry,
} from './moderation-api';

type Loaded =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; story: ModerationStory };

/** Longest note a moderator may write (api-admin's limit). */
const NOTE_MAX = 2000;

/** Each status log entry by what happened (its action). */
const STEP_LABEL: Record<string, string> = {
  sent: 'Sent for review',
  editStarted: 'Taken down to edit',
  changesRequested: 'Sent back',
  fileUnusable: 'Sent back: the file can’t be used',
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

/** What the page says the story is now; a hidden one says who hid it (its newest moving entry). */
function statusLabel(story: ModerationStory): string {
  if (story.status === 'pending') return 'Waiting for review';
  if (story.status === 'approved') return 'Published';
  const hid = [...story.statusLog]
    .reverse()
    .find(
      (e) => e.action === 'hiddenByModerator' || e.action === 'hiddenBySystem',
    );
  return hid?.action === 'hiddenByModerator'
    ? 'Taken down by a moderator'
    : 'Hidden while its video or audio can’t play';
}

/**
 * /moderation/{id} (M3 task 3.2; M3 plan PR 6): one story waiting for review, published or
 * hidden, for Moderators and up (api-admin checks it too, M3 plan concern C2). The story shows as
 * the public would see it, through the story page's own parts, with the player's speed menu on;
 * then what the moderator can do with it (approve, send back or reject a waiting story; hide a
 * published one, G5; show a hidden one again) and its history, with moderators' notes.
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

  // Move to the notice, so a moderator (and a screen reader) learns what happened at once.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  /** After a decision, or a refusal because the story moved on: say so and read it again. */
  const settled = useCallback(
    (next: Notice) => {
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
          This story isn’t waiting for review.{' '}
          <Link href="/moderation">Back to the queue</Link>
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
      <p
        className="mx-auto mb-8 max-w-measure text-sm font-semibold text-link"
        data-review-status={story.status}
      >
        {statusLabel(story)}
      </p>
      <SenderIp ip={story.senderIp} />
      <MediaNote story={story} />
      <StoryArticle
        story={story}
        speedMenu
        dateLine={
          <>
            Sent for review{' '}
            <time dateTime={story.submittedAt}>
              {sentAt(story.submittedAt)}
            </time>
          </>
        }
        after={
          <>
            <Decisions
              key={story.reviewTag}
              story={story}
              client={client}
              onSettled={settled}
            />
            <History entries={story.statusLog} />
          </>
        }
      />
    </>
  );
}

/**
 * Block list (G21 D, G24): the IP address the story was sent from, which api-admin gives Admins
 * only, for 30 days, with a link to block it.
 */
function SenderIp({ ip }: { ip: string | null }) {
  if (!ip) return null;
  return (
    <p
      className="mx-auto mb-6 max-w-measure rounded-2xl border border-border bg-card p-4 [overflow-wrap:anywhere]"
      data-sender-ip={ip}
    >
      Sent from IP address <span className="font-mono">{ip}</span>. Only admins
      see this, for 30 days.{' '}
      <Link
        href={`/admin/block-list?ip=${encodeURIComponent(ip)}`}
        className="inline-flex min-h-11 items-center underline underline-offset-4"
      >
        Block this address
      </Link>
    </p>
  );
}

/** The form a decision opens: Send back, Reject and Hide need a note; Approve and Show don't. */
type Open = 'request-changes' | 'reject' | 'hide' | null;

const NOTED: Record<
  Exclude<Open, null>,
  { label: string; hint: string; confirm: string; field: string }
> = {
  'request-changes': {
    label: 'Your note to the person',
    hint: 'They see it as “What our team said”, with their story to change. Write kindly: thank them, and say what would help.',
    confirm: 'Send back',
    field: 'feedbackToSubmitter',
  },
  reject: {
    label: 'Your note to the person',
    hint: 'They see it as “What our team said”. Write kindly: thank them for sharing, and say why it can’t go on the site.',
    confirm: 'Reject',
    field: 'feedbackToSubmitter',
  },
  hide: {
    label: 'Why it’s being taken down',
    hint: 'Kept with the story’s history, which the person can read. Their profile says “Taken down by our team”.',
    confirm: 'Take down',
    field: 'reason',
  },
};

/**
 * What the moderator can do with the story in its state (G24: Moderators approve, send back,
 * reject, hide and show again; Admins also approve anyway). Each decision names what the page
 * showed (`reviewTag`, G14 B). A refusal says why in plain words; when the story moved on (D-1:
 * another moderator decided first) the page says so and refreshes.
 */
function Decisions({
  story,
  client,
  onSettled,
}: {
  story: ModerationStory;
  client: ApiUser;
  onSettled: (notice: Notice) => void;
}) {
  const isAdmin = useRole() === 'Admin';
  const [open, setOpen] = useState<Open>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<
    (Refusal & { route: DecisionRoute }) | null
  >(null);
  const noteId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Opening a note moves to it.
  useEffect(() => {
    if (open) noteRef.current?.focus();
  }, [open]);

  async function decide(route: DecisionRoute, body?: unknown) {
    setBusy(true);
    setRefusal(null);
    try {
      await client.command(
        `/v1/moderation/stories/${encodeURIComponent(story.id)}/${route}`,
        { method: 'POST', body, tag: story.reviewTag },
      );
      onSettled({ text: DONE[route], tone: 'done' });
    } catch (err) {
      const why = decisionRefusal(err, story, route);
      if (why.refresh) {
        onSettled({ text: why.message, tone: 'refreshed' });
      } else {
        setRefusal({ ...why, route });
        setBusy(false);
      }
    }
  }

  const noted = open && NOTED[open];
  const noteLength = [...note.trim()].length;

  return (
    <section
      aria-labelledby="decide-heading"
      className="mx-auto mt-12 w-full max-w-measure min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-6"
      data-decisions={story.status}
    >
      <h2 id="decide-heading" className="mb-4 text-xl font-semibold">
        {story.status === 'pending' ? 'Your decision' : 'On the site'}
      </h2>
      {!noted && (
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
                variant="outline"
                className={WRAPPING_BUTTON}
                disabled={busy}
                onClick={() => setOpen('request-changes')}
              >
                Send back
              </Button>
              <Button
                variant="outline"
                className={WRAPPING_BUTTON}
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
        </div>
      )}
      {noted && open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (noteLength === 0) return;
            void decide(open, { [noted.field]: note.trim() });
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
          <p
            id={`${noteId}-count`}
            className="mt-1 text-sm text-secondary-text"
          >
            {noteLength.toLocaleString('en-GB')} /{' '}
            {NOTE_MAX.toLocaleString('en-GB')} characters
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              type="submit"
              className={WRAPPING_BUTTON}
              disabled={busy || noteLength === 0}
            >
              {noted.confirm}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={WRAPPING_BUTTON}
              disabled={busy}
              onClick={() => {
                setOpen(null);
                setRefusal(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {refusal && (
        <div role="alert" className="mt-4" data-decision-refused="">
          <p>{refusal.message}</p>
          {refusal.anyway && isAdmin && (
            <Button
              variant="outline"
              className={`${WRAPPING_BUTTON} mt-3`}
              disabled={busy}
              onClick={() =>
                void decide(refusal.route, { approveAnyway: true })
              }
            >
              {refusal.route === 'show' ? 'Show anyway' : 'Approve anyway'}
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
function History({ entries }: { entries: StatusEntry[] }) {
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
                  : (STEP_LABEL[e.action] ?? e.action)}
              </span>{' '}
              {ACTOR_LABEL[e.actor]}
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
