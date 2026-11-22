'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { previewHref } from '@/components/share/own-media';
import {
  Button,
  Card,
  Confirm,
  DangerZone,
  Heading,
  headingVariants,
  Notice,
  Quiet,
  StatusBadge,
  type StatusTone,
  Text,
  TextLink,
} from '@heisreal/web-ui';
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
  /** Hidden by a moderator (G5): "Taken down by our team". */
  takenDown?: boolean;
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
  /**
   * Part 1a: `unusable` while its video or audio file can't be used (api-user works it out from
   * the file: null again once a new one is on it).
   */
  mediaProblem?: 'unusable' | null;
  /**
   * Part 1a (P1-1, P1-2): which file the system sent it back for (`recording` or `picture`), while
   * it is still sent back for it (api-user works it out from the history).
   */
  unusableFile?: 'recording' | 'picture' | null;
}

/**
 * What the owner sees of each state (Story states, Joel 2026-11-11). A story being edited is a
 * "Draft" if it was never sent, "Sent back" while a moderator's note is on it, and "Being edited"
 * once its owner took it down with Edit. G2: a hidden story shows as it is; G5: one a moderator
 * took down says so. Part 1a: a story whose file can't be used "Needs a new file", then, once the
 * system sent it back for that and a new file is in, "Ready to send again" (P1-1).
 */
type Label =
  | 'draft'
  | 'needs_file'
  | 'ready_again'
  | 'sent_back'
  | 'editing'
  | 'pending'
  | 'approved'
  | 'hidden'
  | 'taken_down'
  | 'rejected';
/** Each label's words and badge colour, by meaning (CH-2 A, Joel, 20 November 2026). */
const LABEL: Record<Label, { label: string; tone: StatusTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  needs_file: { label: 'Needs a new file', tone: 'brand' },
  ready_again: { label: 'Ready to send again', tone: 'brand' },
  sent_back: { label: 'Sent back', tone: 'brand' },
  editing: { label: 'Being edited', tone: 'neutral' },
  pending: { label: 'Waiting for review', tone: 'brand' },
  approved: { label: 'Published', tone: 'success' },
  hidden: { label: 'Not on the site right now', tone: 'warning' },
  taken_down: { label: 'Taken down by our team', tone: 'warning' },
  rejected: { label: 'Not accepted', tone: 'danger' },
};
function labelOf(story: MyStoryRow): Label {
  if (story.status === 'editing') {
    if (story.mediaProblem === 'unusable') return 'needs_file';
    if (story.unusableFile) return 'ready_again';
    if (!story.submittedAt) return 'draft';
    return story.rejectionFeedback ? 'sent_back' : 'editing';
  }
  if (story.status === 'hidden' && story.takenDown) return 'taken_down';
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
      <Text size="inherit" tone="quiet">
        <TextLink href={signInHref('/account')} touch>
          Sign in
        </TextLink>{' '}
        to see the stories you’ve shared.
      </Text>
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
        <Text role="alert" size="inherit" tone="quiet" className="mb-4">
          {TRY_AGAIN_LATER}
        </Text>
        <Button
          variant="outline"
          wrap
          onClick={() => own.reload(state.owner, false)}
        >
          Try again
        </Button>
      </div>
    );
  } else if (state.data.stories.length === 0) {
    body = (
      <Quiet as="p" data-submissions-empty="">
        You haven’t shared a story yet. When you do, you’ll see it here, with
        where it is in review.
      </Quiet>
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
        {/* Heading's look on the h2 itself: focus moves to it (a ref). */}
        <h2
          id="my-submissions"
          ref={heading}
          tabIndex={-1}
          className={headingVariants({
            size: 'section',
            className: 'outline-none',
          })}
        >
          My submissions
        </h2>
        <Button asChild variant="outline" wrap>
          <Link href="/share">New story</Link>
        </Button>
      </div>
      {/* The live region stays in the page; the notice appears inside it. */}
      <div data-notice="" role="status" className="mb-4 empty:hidden">
        {notice && (
          <Notice kind="success" as="p">
            {notice}
          </Notice>
        )}
      </div>
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
    tone: 'neutral' as const,
  };
  const editButton = useRef<HTMLButtonElement>(null);
  const titleId = `story-${story.id}`;
  const what = label === 'draft' ? 'draft' : 'story';
  const media = story.primaryFormat === 'audio' ? 'recording' : 'video';
  // P1-2 (G17 B): an audio story's picture video failed, not its recording.
  const unusable = story.unusableFile === 'picture' ? 'picture' : media;

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
    <Card asChild className="p-5 sm:p-6">
      <li data-submission={label} aria-labelledby={titleId}>
        <div className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <Heading
            level={3}
            id={titleId}
            className="min-w-0 flex-1 [overflow-wrap:anywhere]"
          >
            {story.title}
          </Heading>
          <StatusBadge data-status="" tone={status.tone}>
            {status.label}
          </StatusBadge>
        </div>
        <Text
          size="small"
          tone="quiet"
          className="mb-3 [overflow-wrap:anywhere]"
        >
          {meta.join(' · ')}
        </Text>
        {story.rejectionFeedback && (
          <Notice
            kind="info"
            data-feedback=""
            className="mb-4"
            title="What our team said"
          >
            <Text className="whitespace-pre-line">
              {story.rejectionFeedback}
            </Text>
          </Notice>
        )}
        {label === 'draft' && story.deletesAt && (
          <Text data-draft-expiry="" size="small" tone="quiet" className="mb-3">
            If you don’t change this draft, we’ll delete it after{' '}
            {LONG_DATE.format(new Date(story.deletesAt))}.
          </Text>
        )}
        {(label === 'sent_back' ||
          label === 'editing' ||
          label === 'needs_file' ||
          label === 'ready_again') &&
          story.deletesAt && (
            <Text
              data-draft-expiry=""
              size="small"
              tone="quiet"
              className="mb-3"
            >
              If you don’t change this story, we’ll delete it after{' '}
              {LONG_DATE.format(new Date(story.deletesAt))}.
            </Text>
          )}
        {label === 'rejected' && story.deletesAt && (
          <Text data-draft-expiry="" size="small" tone="quiet" className="mb-3">
            We’ll delete this story after{' '}
            {LONG_DATE.format(new Date(story.deletesAt))}. To keep our team’s
            note, download your data before then.
          </Text>
        )}
        {label === 'editing' && (
          <Text size="small" tone="quiet" className="mb-3">
            It isn’t on the site or waiting for review. Send it again when
            you’re ready, and our team will look at it.
          </Text>
        )}
        {label === 'needs_file' && (
          <Text data-media-problem="" className="mb-3">
            {unusable === 'picture'
              ? // P1-6 A (Joel, 2026-11-14): the recording again, a picture if they like.
                'We couldn’t use your picture. Please upload your recording again, and a picture if you like.'
              : `We couldn’t use your ${unusable}. Please upload another file.`}
          </Text>
        )}
        {label === 'ready_again' && (
          <Text data-media-problem="replaced" className="mb-3">
            Thanks, your new file is in. Send it when you’re ready.
          </Text>
        )}
        {label === 'hidden' && (
          <Text size="small" tone="quiet" className="mb-3">
            {story.primaryFormat === 'written'
              ? 'It isn’t on the site right now. You can edit it or delete it.'
              : `We’re fixing your ${media}. It will be back by itself.`}
          </Text>
        )}
        {shared && (
          <Text
            data-shared-on-social=""
            size="small"
            tone="quiet"
            className="mb-3"
          >
            You allowed us to share it on social media (on{' '}
            {shortDate(shared.agreedAt)}).
          </Text>
        )}

        {confirm === 'edit' ? (
          <Confirm
            data-confirm="edit"
            question="Edit this story?"
            confirmLabel={busy ? 'Opening…' : 'Edit story'}
            busy={busy}
            returnFocus={editButton}
            onConfirm={() => void go('edit')}
            onCancel={() => setConfirm(null)}
          >
            <p>
              It comes off the site straight away, and goes back on once our
              team has approved it again.
            </p>
          </Confirm>
        ) : (
          <div className="flex flex-wrap gap-3">
            {story.status === 'editing' && (
              <Button asChild wrap>
                <Link
                  href={`/share?draft=${encodeURIComponent(story.id)}`}
                  aria-describedby={titleId}
                >
                  {label === 'draft'
                    ? 'Continue'
                    : label === 'needs_file'
                      ? unusable === 'picture'
                        ? 'Upload your recording again'
                        : 'Upload another file'
                      : label === 'ready_again'
                        ? 'Send again'
                        : 'Continue editing'}
                </Link>
              </Button>
            )}
            {!onSite && (
              <Button asChild variant="outline" wrap>
                <Link href={previewHref(story.id)} aria-describedby={titleId}>
                  Preview
                </Link>
              </Button>
            )}
            {onSite && (
              <Button asChild variant="outline" wrap>
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
                ref={editButton}
                variant="outline"
                wrap
                aria-describedby={titleId}
                disabled={busy}
                // ED-1: a published story leaves the site on pressing Edit, so it asks first; one
                // waiting for review or already off the site opens straight away.
                onClick={() => (onSite ? setConfirm('edit') : go('edit'))}
              >
                Edit
              </Button>
            )}
          </div>
        )}
        <DangerZone
          className="mt-4"
          open={confirm === 'delete'}
          onOpenChange={(open) => setConfirm(open ? 'delete' : null)}
          actionProps={{ 'aria-describedby': titleId }}
          confirmProps={{ 'data-confirm': 'delete' }}
          question={`Delete this ${what} for good?`}
          detail={
            <p>
              Its text and any video or audio go too
              {onSite ? ', and it comes off the site' : ''}. This can’t be
              undone.
            </p>
          }
          confirmLabel={busy ? 'Deleting…' : `Delete ${what}`}
          busy={busy}
          onConfirm={() => void go('delete')}
        />
        {error && (
          <Text role="alert" size="small" tone="danger" className="mt-3">
            {error}
          </Text>
        )}
      </li>
    </Card>
  );
}
