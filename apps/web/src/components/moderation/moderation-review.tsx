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
  | { status: 'ready'; story: ModerationStory };

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for review',
};

/** Each status log entry by what happened (its action). */
const STEP_LABEL: Record<string, string> = {
  sent: 'Sent for review',
  editStarted: 'Taken down to edit',
  changesRequested: 'Sent back for changes',
  fileUnusable: 'Sent back: the file can’t be used',
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
  const { story } = loaded;
  return (
    <>
      <p
        className="mx-auto mb-8 max-w-measure text-sm font-semibold text-link"
        data-review-status={story.status}
      >
        {STATUS_LABEL[story.status] ?? story.status}
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
        after={<History entries={story.statusLog} />}
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
                {STEP_LABEL[e.action] ?? e.action}
              </span>{' '}
              {ACTOR_LABEL[e.actor]}
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
