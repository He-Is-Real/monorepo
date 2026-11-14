'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { previewHref } from '@/components/share/own-media';
import { Button } from '@/components/ui/button';
import {
  type Agreement,
  type ApiUser,
  ApiUserProblem,
  ApiUserUnavailable,
  plainMessage,
  StaleVersion,
} from '@/lib/api-user';
import { shortDate } from '@/lib/legal-text';
import { signInHref } from '@/lib/return-path';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';
import { useOwnData, useOwnNotice } from './use-own-data';

/** The contract's `StoryMine`, the parts the profile shows. */
export interface MyStoryRow {
  id: string;
  version: number;
  slug: string;
  status: string;
  title: string;
  primaryFormat: 'video' | 'audio' | 'written';
  themes: { id: string; name: string }[];
  /** The moderator's note while sent back for changes or rejected ("What our team said"). */
  rejectionFeedback: string | null;
  /** When it was first sent for review; null for a story never sent (a "Draft"). */
  submittedAt?: string | null;
  createdAt: string;
  /**
   * When the nightly clean-up deletes it (api-user's rule; never recomputed here): a draft or a
   * story being edited after it was sent, if nobody touches it; a rejected story (G3 B).
   */
  deletesAt?: string | null;
  /**
   * Plan 4e: the social media sharing consent ticked for this story at the end of its upload, or
   * null. It can't be withdrawn: deleting the story stops any future use.
   */
  socialMediaSharingConsent?: Agreement | null;
}

/**
 * What the owner sees of each state (Story states, Joel 2026-11-11). A story being edited is a
 * "Draft" if it was never sent, "Sent back" while a moderator's note is on it, and "Being edited"
 * once its owner took it down with Edit. G2: a hidden story shows as it is.
 */
type Label =
  | 'draft'
  | 'sent_back'
  | 'editing'
  | 'pending'
  | 'approved'
  | 'hidden'
  | 'rejected';
const LABEL: Record<Label, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'border-border text-secondary-text' },
  sent_back: { label: 'Sent back', tone: 'border-link text-link' },
  editing: { label: 'Being edited', tone: 'border-border text-secondary-text' },
  pending: { label: 'Waiting for review', tone: 'border-link text-link' },
  approved: { label: 'Published', tone: 'border-primary text-foreground' },
  hidden: {
    label: 'Not on the site right now',
    tone: 'border-border text-foreground',
  },
  rejected: { label: 'Not accepted', tone: 'border-border text-foreground' },
};
function labelOf(story: MyStoryRow): Label {
  if (story.status === 'editing') {
    if (!story.submittedAt) return 'draft';
    return story.rejectionFeedback ? 'sent_back' : 'editing';
  }
  return story.status as Label;
}
/** api-user's own rule (story-store.ts): Edit takes these down to edit (ED-1, ED-4). */
const CAN_START_EDITING = ['pending', 'approved', 'hidden'];

const FORMAT = { video: 'Video', audio: 'Audio', written: 'Written' };
const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
/** The day a story goes, as the UK sees it (where the site and its nightly clean-up run). */
const LONG_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/London',
});
/** A person has few stories (D94's limits); a bound in case. */
const MAX_PAGES = 10;

/** The person's stories. */
interface Mine {
  stories: MyStoryRow[];
}

async function readMine(api: ApiUser): Promise<Mine> {
  return { stories: await readAll(api) };
}

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

type Command = 'edit' | 'delete';

/**
 * "My submissions" (M2 plan PR 8): the person's stories with their status, a moderator's
 * feedback when there is some, and what they can do with each: preview it as others will see it
 * (M3 plan PR 2; a published one is viewed on the site instead), continue a story being edited (a
 * draft shows when it goes if left untouched), Edit one waiting for review, published or not on
 * the site right now (ED-1, ED-4: it is taken down at once, then opens in the share flow), and
 * Delete any of them after one "This can't be undone" question (ED-3); and whether the person
 * allowed it to be shared on social media (plan 4e: chosen once, at the end of its upload; read
 * only here).
 * Filled in by the browser from api-user (D83), with its space kept while it loads.
 */
export function MySubmissions() {
  const own = useOwnData(readMine);
  const { notice, say } = useOwnNotice<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  const router = useRouter();

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
        command === 'delete' ? `/v1/stories/${id}` : `/v1/stories/${id}/edit`,
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
        return plainMessage(err, TRY_AGAIN_LATER);
      }
    }
    if (command === 'edit') {
      // Taken down: it opens in the share flow, where everything can change (M3-6 A).
      router.push(`/share?draft=${id}`);
      return null;
    }
    say(owner, `“${story.title}” is deleted.`);
    await own.reload(owner);
    heading.current?.focus();
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
          {TRY_AGAIN_LATER}
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
  } else if (state.data.stories.length === 0) {
    body = (
      <p className="min-h-24 text-secondary-text">
        You haven’t shared a story yet. When you do, you’ll see it here, with
        where it is in review.
      </p>
    );
  } else {
    body = (
      <ul data-submissions="" className="flex flex-col gap-4">
        {state.data.stories.map((story) => (
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
  const onSite = story.status === 'approved';
  const shared = story.socialMediaSharingConsent;
  const [confirm, setConfirm] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = labelOf(story);
  const status = LABEL[label] ?? {
    label: story.status,
    tone: 'border-border text-secondary-text',
  };
  const titleId = `story-${story.id}`;
  const what = label === 'draft' ? 'draft' : 'story';

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
    story.themes.map((t) => t.name).join(', '),
  ].filter(Boolean);

  return (
    <li
      data-submission={label}
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
          <p className="mb-1 font-semibold">What our team said</p>
          <p className="whitespace-pre-line [overflow-wrap:anywhere]">
            {story.rejectionFeedback}
          </p>
        </div>
      )}
      {label === 'draft' && story.deletesAt && (
        <p data-draft-expiry="" className="mb-3 text-sm text-secondary-text">
          If you don’t change this draft, we’ll delete it after{' '}
          {LONG_DATE.format(new Date(story.deletesAt))}.
        </p>
      )}
      {(label === 'sent_back' || label === 'editing') && story.deletesAt && (
        <p data-draft-expiry="" className="mb-3 text-sm text-secondary-text">
          If you don’t change this story, we’ll delete it after{' '}
          {LONG_DATE.format(new Date(story.deletesAt))}.
        </p>
      )}
      {label === 'rejected' && story.deletesAt && (
        <p data-draft-expiry="" className="mb-3 text-sm text-secondary-text">
          We’ll delete this story after{' '}
          {LONG_DATE.format(new Date(story.deletesAt))}. To keep our team’s
          note, download your data before then.
        </p>
      )}
      {label === 'editing' && (
        <p className="mb-3 text-sm text-secondary-text">
          It isn’t on the site or waiting for review. Send it again when you’re
          ready, and our team will look at it.
        </p>
      )}
      {label === 'hidden' && (
        <p className="mb-3 text-sm text-secondary-text">
          It isn’t on the site right now. You can edit it or delete it.
        </p>
      )}
      {shared && (
        <p
          data-shared-on-social=""
          className="mb-3 text-sm text-secondary-text"
        >
          You allowed us to share it on social media (on{' '}
          {shortDate(shared.agreedAt)}).
        </p>
      )}

      {confirm ? (
        <div
          data-confirm={confirm}
          className="rounded-xl border border-border-hover p-4"
        >
          <p className="mb-3">
            {confirm === 'delete'
              ? `Delete this ${what} for good? Its text and any video or audio go too${onSite ? ', and it comes off the site' : ''}. This can’t be undone.`
              : 'Edit this story? It comes off the site straight away, and goes back on once our team has approved it again.'}
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
                  : 'Opening…'
                : confirm === 'delete'
                  ? `Delete ${what}`
                  : 'Edit story'}
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
          {story.status === 'editing' && (
            <Button
              asChild
              className="h-auto min-h-11 max-w-full px-5 py-2 text-center whitespace-normal"
            >
              <Link
                href={`/share?draft=${encodeURIComponent(story.id)}`}
                aria-describedby={titleId}
              >
                {label === 'draft' ? 'Continue' : 'Continue editing'}
              </Link>
            </Button>
          )}
          {!onSite && (
            <Button
              asChild
              variant="outline"
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
            >
              <Link href={previewHref(story.id)} aria-describedby={titleId}>
                Preview
              </Link>
            </Button>
          )}
          {onSite && (
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
          {CAN_START_EDITING.includes(story.status) && (
            <Button
              variant="outline"
              className="h-auto min-h-11 px-5 py-2 whitespace-normal"
              aria-describedby={titleId}
              disabled={busy}
              // ED-1: a published story leaves the site on pressing Edit, so it asks first; one
              // waiting for review or already off the site opens straight away.
              onClick={() => (onSite ? setConfirm('edit') : go('edit'))}
            >
              Edit
            </Button>
          )}
          <Button
            variant="outline"
            className="h-auto min-h-11 px-5 py-2 whitespace-normal"
            aria-describedby={titleId}
            onClick={() => setConfirm('delete')}
          >
            Delete
          </Button>
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
