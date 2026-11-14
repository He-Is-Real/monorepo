'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AdminAccess } from '@/components/admin/admin-access';
import { StoryArticle } from '@/components/stories/story-view';
import { type ApiUser, ApiUserProblem } from '@/lib/api-user';
import {
  type ModerationStory,
  moderationProblem,
  sentAt,
  type StatusEntry,
} from './moderation-api';

type Loaded =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; story: ModerationStory; left?: boolean };

/**
 * How often an open review page checks the story is still waiting (Part 1a: it can be sent back
 * automatically while a moderator has it open), as well as whenever the tab comes back into view.
 */
const RECHECK_MS = 60_000;

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for review',
};

/** Each status log entry by what happened (its action). */
const STEP_LABEL: Record<string, string> = {
  sent: 'Sent for review',
  editStarted: 'Taken down to edit',
  changesRequested: 'Sent back for changes',
  // Part 1a: the system's own line ("automatically" is in the label, so no actor after it).
  fileUnusable: 'Sent back automatically: the video couldn’t be processed',
  approved: 'Approved',
  rejected: 'Rejected',
  hiddenBySystem: 'Hidden',
  shownBySystem: 'Shown again',
  hiddenByModerator: 'Hidden',
  shownByModerator: 'Shown again',
  fileReplaced: 'Video or audio replaced',
  pictureReplaced: 'Picture replaced',
  wordsChanged: 'Words changed',
};

const ACTOR_LABEL: Record<StatusEntry['actor'], string> = {
  person: 'by the person',
  moderator: 'by a moderator',
  system: 'automatically',
};

/**
 * /moderation/{id} (M3 task 3.2): one story waiting for review, read-only, for
 * Moderators and up (api-admin checks it too, M3 plan concern C2). The story shows as the public
 * would see it, through the story page's own parts, with the player's speed menu on; then its
 * history, with moderators' past notes to the person. No decision buttons yet (a later PR).
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

function Review({ id, client }: { id: string; client: ApiUser }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const load = useRef(0);

  // Part 1a: while the page is open, check now and then (and whenever the tab is back in view)
  // that the story is still waiting; if it was sent back or decided meanwhile, the page says so.
  useEffect(() => {
    if (loaded.status !== 'ready' || loaded.left) return;
    let stopped = false;
    const recheck = () => {
      if (document.visibilityState !== 'visible') return;
      client
        .get<ModerationStory>(
          `/v1/moderation/stories/${encodeURIComponent(id)}`,
        )
        .then(
          ({ data }) => {
            if (!stopped && data) setLoaded({ status: 'ready', story: data });
          },
          (err: unknown) => {
            if (!stopped && err instanceof ApiUserProblem && err.status === 404)
              setLoaded((l) =>
                l.status === 'ready' ? { ...l, left: true } : l,
              );
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
  }, [client, id, loaded]);

  useEffect(() => {
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

  if (loaded.status === 'loading') {
    return <p className="text-secondary-text">Loading the story…</p>;
  }
  if (loaded.status === 'gone') {
    return (
      <p
        className="rounded-2xl border border-border bg-card p-6"
        data-review-gone=""
      >
        This story isn’t waiting for review.{' '}
        <Link href="/moderation">Back to the queue</Link>
      </p>
    );
  }
  if (loaded.status === 'failed') {
    return (
      <p
        role="alert"
        className="rounded-2xl border border-destructive bg-card p-6"
        data-moderation-error=""
      >
        {loaded.message}
      </p>
    );
  }
  const { story, left } = loaded;
  return (
    <>
      {left && (
        <p
          role="alert"
          className="mx-auto mb-6 max-w-measure rounded-2xl border border-link bg-card p-4"
          data-review-left=""
        >
          This story is no longer waiting for review: while you had it open, it
          was sent back automatically (its{' '}
          {story.primaryFormat === 'audio' ? 'recording' : 'video'} couldn’t be
          processed) or its owner took it back.{' '}
          <Link href="/moderation">Back to the queue</Link>
        </p>
      )}
      <p
        className="mx-auto mb-8 max-w-measure text-sm font-semibold text-link"
        data-review-status={story.status}
      >
        {STATUS_LABEL[story.status] ?? story.status}
      </p>
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
          <History entries={story.statusLog} format={story.primaryFormat} />
        }
      />
    </>
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
                {e.action === 'fileUnusable' && format === 'audio'
                  ? 'Sent back automatically: the recording couldn’t be processed'
                  : (STEP_LABEL[e.action] ?? e.action)}
              </span>
              {e.action !== 'fileUnusable' && <> {ACTOR_LABEL[e.actor]}</>}
            </p>
            <p className="text-sm text-secondary-text">
              <time dateTime={e.at}>{sentAt(e.at)}</time>
            </p>
            {e.comment && (
              <div className="mt-2">
                <p className="text-sm font-semibold">Note to the person</p>
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
