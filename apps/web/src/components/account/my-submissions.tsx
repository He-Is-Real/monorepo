'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  type ApiUser,
  ApiUserProblem,
  ApiUserUnavailable,
  StaleVersion,
} from '@/lib/api-user';
import { signInHref } from '@/lib/return-path';
import { useOwnData, useOwnNotice } from './use-own-data';

/** The contract's `StoryMine`, the parts the profile shows. */
export interface MyStoryRow {
  id: string;
  version: number;
  slug: string;
  status: string;
  title: string;
  primaryFormat: 'video' | 'audio' | 'written';
  tags: { slug: string; name: string }[];
  rejectionFeedback: string | null;
  createdAt: string;
  /** A draft's deletion date if nobody touches it (api-user's rule; never recomputed here). */
  draftExpiresAt?: string | null;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'border-border text-secondary-text' },
  pending: { label: 'Waiting for review', tone: 'border-link text-link' },
  in_review: { label: 'In review', tone: 'border-link text-link' },
  approved: { label: 'Published', tone: 'border-primary text-foreground' },
  changes_requested: {
    label: 'Changes requested',
    tone: 'border-link text-link',
  },
  rejected: { label: 'Not published', tone: 'border-border text-foreground' },
  withdrawn: { label: 'Withdrawn', tone: 'border-border text-secondary-text' },
};
/** api-user's own rules (story-store.ts): what each status offers. */
const WITHDRAWABLE = ['pending', 'in_review', 'approved', 'changes_requested'];
const DELETABLE = ['draft', 'changes_requested', 'withdrawn', 'rejected'];

const FORMAT = { video: 'Video', audio: 'Audio', written: 'Written' };
const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
/** The day a draft goes, as the UK sees it (where the site and its nightly clean-up run). */
const LONG_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/London',
});
/** A person has few stories (D94's limits); a bound in case. */
const MAX_PAGES = 10;

async function readAll(api: ApiUser): Promise<MyStoryRow[]> {
  const all: MyStoryRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: string = cursor
      ? `?limit=50&cursor=${encodeURIComponent(cursor)}`
      : '?limit=50';
    const { data } = await api.get<{
      data: MyStoryRow[];
      nextCursor: string | null;
    }>(`/v1/account/stories${query}`);
    if (!data) throw new ApiUserUnavailable('No answer');
    all.push(...data.data);
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  return all;
}

type Command = 'withdraw' | 'delete';

/**
 * "My submissions" (M2 plan PR 8): the person's stories with their status, a moderator's
 * feedback when there is some, and what they can do with each: continue or delete a draft (and
 * see when it goes if left untouched), withdraw a story waiting for review or published, delete
 * one sent back for changes, withdrawn or not published (D71).
 * Filled in by the browser from api-user (D83), with its space kept while it loads.
 */
export function MySubmissions() {
  const own = useOwnData(readAll);
  const { notice, say } = useOwnNotice<string>();
  const heading = useRef<HTMLHeadingElement>(null);

  const run = async (
    owner: string,
    story: MyStoryRow,
    command: Command,
  ): Promise<string | null> => {
    const api = own.api(owner);
    if (!api) return 'You’ve signed out. Sign in again to do this.';
    const id = encodeURIComponent(story.id);
    try {
      await api.command(
        command === 'delete'
          ? `/v1/stories/${id}`
          : `/v1/stories/${id}/withdraw`,
        {
          method: command === 'delete' ? 'DELETE' : 'POST',
          version: story.version,
        },
      );
    } catch (err) {
      // Gone already (an earlier try whose answer was lost): that's what was asked.
      if (!(
        command === 'delete' &&
        err instanceof ApiUserProblem &&
        err.status === 404
      )) {
        await own.reload(owner);
        if (err instanceof StaleVersion)
          return 'This story changed since the page loaded. It’s up to date now: check it, then try again.';
        if (err instanceof ApiUserProblem && err.problem.detail)
          return err.problem.detail;
        return command === 'delete'
          ? 'We couldn’t delete it just now. Please try again in a moment.'
          : 'We couldn’t withdraw it just now. Please try again in a moment.';
      }
    }
    say(
      owner,
      command === 'delete'
        ? `“${story.title}” is deleted.`
        : `“${story.title}” is withdrawn. It’s no longer on the site or waiting for review.`,
    );
    await own.reload(owner);
    if (command === 'delete') heading.current?.focus();
    return null;
  };

  const { state } = own;
  let body: React.ReactNode;
  if (state.status === 'signed-out') {
    body = (
      <p className="text-secondary-text">
        <a
          href={signInHref('/account')}
          className="inline-flex min-h-11 items-center font-semibold"
        >
          Sign in
        </a>{' '}
        to see the stories you’ve shared.
      </p>
    );
  } else if (state.status === 'loading') {
    body = (
      <div data-submissions-loading="" aria-busy="true" className="min-h-48">
        <p className="sr-only" role="status">
          Loading your stories…
        </p>
      </div>
    );
  } else if (state.status === 'failed') {
    body = (
      <div className="min-h-48">
        <p role="alert" className="mb-4 text-secondary-text">
          Your stories couldn’t load. Try again in a moment.
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
  } else if (state.data.length === 0) {
    body = (
      <p className="min-h-24 text-secondary-text">
        You haven’t shared a story yet. When you do, you’ll see it here, with
        where it is in review.
      </p>
    );
  } else {
    body = (
      <ul data-submissions="" className="flex flex-col gap-4">
        {state.data.map((story) => (
          <StoryRow
            key={story.id}
            story={story}
            onCommand={(command) => run(state.owner, story, command)}
          />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="my-submissions" className="mb-12">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2
          id="my-submissions"
          ref={heading}
          tabIndex={-1}
          className="text-2xl font-normal outline-none"
        >
          My submissions
        </h2>
        <Button
          asChild
          variant="outline"
          className="h-auto min-h-11 px-4 py-2 whitespace-normal"
        >
          <Link href="/share">New story</Link>
        </Button>
      </div>
      <p data-notice="" role="status" className="mb-4 empty:hidden">
        {notice}
      </p>
      {body}
    </section>
  );
}

function StoryRow({
  story,
  onCommand,
}: {
  story: MyStoryRow;
  onCommand: (command: Command) => Promise<string | null>;
}) {
  const [confirm, setConfirm] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[story.status] ?? {
    label: story.status,
    tone: 'border-border text-secondary-text',
  };
  const titleId = `story-${story.id}`;
  const what = story.status === 'draft' ? 'draft' : 'story';

  const go = async (command: Command) => {
    setBusy(true);
    setError(null);
    const problem = await onCommand(command);
    setBusy(false);
    setConfirm(null);
    setError(problem);
  };

  const meta = [
    DATE.format(new Date(story.createdAt)),
    FORMAT[story.primaryFormat] ?? story.primaryFormat,
    story.tags.map((t) => t.name).join(', '),
  ].filter(Boolean);

  return (
    <li
      data-submission={story.status}
      aria-labelledby={titleId}
      className="rounded-2xl border border-border bg-card p-5 sm:p-6"
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h3
          id={titleId}
          className="min-w-0 flex-1 text-lg font-semibold [overflow-wrap:anywhere]"
        >
          {story.title}
        </h3>
        <span
          data-status=""
          className={`max-w-full rounded-full border px-3 py-1 text-sm font-medium ${status.tone}`}
        >
          {status.label}
        </span>
      </div>
      <p className="mb-3 text-sm text-secondary-text [overflow-wrap:anywhere]">
        {meta.join(' · ')}
      </p>
      {story.rejectionFeedback && (
        <div
          data-feedback=""
          className="mb-4 rounded-xl border-l-4 border-link bg-raised p-4 text-[0.9375rem]"
        >
          <p className="mb-1 font-semibold">Feedback from our team</p>
          <p className="whitespace-pre-line [overflow-wrap:anywhere]">
            {story.rejectionFeedback}
          </p>
        </div>
      )}
      {story.status === 'draft' && story.draftExpiresAt && (
        <p data-draft-expiry="" className="mb-3 text-sm text-secondary-text">
          We’ll keep this draft until{' '}
          {LONG_DATE.format(new Date(story.draftExpiresAt))}. If you don’t
          change it before then, it will be deleted.
        </p>
      )}
      {story.status === 'withdrawn' && (
        <p className="mb-3 text-sm text-secondary-text">
          It isn’t on the site or waiting for review. You can delete it.
        </p>
      )}

      {confirm ? (
        <div
          data-confirm={confirm}
          className="rounded-xl border border-border-hover p-4"
        >
          <p className="mb-3">
            {confirm === 'delete'
              ? `Delete this ${what} for good? Its text and any video or audio go too. This can’t be undone.`
              : story.status === 'approved'
                ? 'Withdraw this story? It comes off the site straight away. You can delete it afterwards.'
                : 'Withdraw this story from review? You can delete it afterwards.'}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              autoFocus
              variant={confirm === 'delete' ? 'destructive' : 'default'}
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
              disabled={busy}
              onClick={() => go(confirm)}
            >
              {busy
                ? confirm === 'delete'
                  ? 'Deleting…'
                  : 'Withdrawing…'
                : confirm === 'delete'
                  ? `Delete ${what}`
                  : 'Withdraw story'}
            </Button>
            <Button
              variant="outline"
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {story.status === 'draft' && (
            <Button
              asChild
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
            >
              <Link
                href={`/share?draft=${encodeURIComponent(story.id)}`}
                aria-describedby={titleId}
              >
                Continue
              </Link>
            </Button>
          )}
          {story.status === 'approved' && (
            <Button
              asChild
              variant="outline"
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
            >
              <Link
                href={`/stories/${encodeURIComponent(story.slug)}`}
                aria-describedby={titleId}
              >
                View
              </Link>
            </Button>
          )}
          {WITHDRAWABLE.includes(story.status) && (
            <Button
              variant="outline"
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
              aria-describedby={titleId}
              onClick={() => setConfirm('withdraw')}
            >
              Withdraw
            </Button>
          )}
          {DELETABLE.includes(story.status) && (
            <Button
              variant="outline"
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
              aria-describedby={titleId}
              onClick={() => setConfirm('delete')}
            >
              Delete
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}
