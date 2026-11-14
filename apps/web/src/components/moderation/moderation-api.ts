import { ApiUserProblem, NotSignedIn, StaleVersion } from '@/lib/api-user';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';
import type { MediaPlayback, StoryImage } from '@/lib/public-stories';

/**
 * The moderators' list's states (MD-3, Joel 2026-11-14): every story that isn't public, one at a
 * time; `draft` (never sent) is for Admins only. The list opens on `pending`.
 */
export const LIST_STATES = [
  { state: 'pending', label: 'Waiting for review', admin: false },
  { state: 'editing', label: 'Being edited', admin: false },
  { state: 'hidden', label: 'Taken down', admin: false },
  { state: 'rejected', label: 'Rejected', admin: false },
  { state: 'draft', label: 'Drafts never sent', admin: true },
] as const;
export type ListState = (typeof LIST_STATES)[number]['state'];

export const isListState = (s: string | undefined): s is ListState =>
  LIST_STATES.some((l) => l.state === s);

/** api-admin's `ModerationListItem` (MD-4): one row of the list. */
export interface ListItem {
  id: string;
  state: ListState;
  /** What put it in this state (its current status entry); null for a draft. */
  action: string | null;
  title: string;
  primaryFormat: 'video' | 'audio' | 'written';
  themes: { id: string; name: string }[];
  /** When it entered this state (a draft: when it was started); the list's order. */
  since: string;
  sentAt: string | null;
  updatedAt: string;
}

export interface ListPage {
  data: ListItem[];
  nextCursor: string | null;
}

/** What a row (and the review page) says the story is, from its state and what put it there. */
export function stateLabel(state: string, action: string | null): string {
  switch (state) {
    case 'pending':
      return 'Waiting for review';
    case 'approved':
      return 'Published';
    case 'rejected':
      return 'Rejected';
    case 'draft':
      return 'Draft, never sent';
    case 'hidden':
      return action === 'hiddenByModerator'
        ? 'Taken down by a moderator'
        : 'Hidden by the site while its video or audio can’t play';
    case 'editing':
      return action === 'changesRequested'
        ? 'Sent back by a moderator'
        : action === 'fileUnusable'
          ? 'Sent back: its file can’t be used'
          : 'Being edited by the person';
  }
  return state;
}

/** What the row's "since" date means, by state. */
export const SINCE_LABEL: Record<ListState, string> = {
  pending: 'Sent',
  editing: 'Since',
  hidden: 'Taken down',
  rejected: 'Rejected',
  draft: 'Started',
};

/** api-admin's `ModerationStatusEntry`. */
export interface StatusEntry {
  /** What happened (the step); `status` is where it left the story. */
  action: string;
  status: string;
  actor: 'person' | 'moderator' | 'system';
  comment: string | null;
  at: string;
}

/** api-admin's `StoryModeration` (M3 task 3.2; M3 plan PR 6). */
export interface ModerationStory {
  id: string;
  version: number;
  /**
   * Waiting for review, published, or hidden (G5): something to decide. Being edited (a draft
   * when `submittedAt` is null, Admins only) or rejected: read only (MD-4).
   */
  status: 'editing' | 'pending' | 'approved' | 'hidden' | 'rejected';
  title: string;
  description: string;
  body: string | null;
  bylineName: string | null;
  primaryFormat: 'video' | 'audio' | 'written';
  /** As the public's, plus how far Bunny has got with it. */
  media: (MediaPlayback & {
    processing: 'processing' | 'ready' | 'failed' | null;
  })[];
  image: StoryImage | null;
  themes: { id: string; name: string }[];
  /** When it was last sent; null for a draft never sent. */
  submittedAt: string | null;
  /** The IP address it was last sent from: Admins only, for 30 days (block list); else null. */
  senderIp: string | null;
  /** What a decision names in `If-Match` (G14 B). */
  reviewTag: string;
  statusLog: StatusEntry[];
}

/** The decisions, by api-admin's route, and the status entry each adds. */
export type DecisionRoute =
  'approve' | 'request-changes' | 'reject' | 'hide' | 'show';

/** What the moderator did, as the page confirms it. */
export const DONE: Record<DecisionRoute, string> = {
  approve: 'Approved. It’s on the site now.',
  'request-changes': 'Sent back. The person can read your note.',
  reject: 'Rejected. The person can read your note.',
  hide: 'Taken down. It stays off the site until a moderator shows it again.',
  show: 'Shown again. It’s back on the site.',
};

const timeOnly = new Intl.DateTimeFormat('en-GB', {
  timeStyle: 'short',
  timeZone: 'Europe/London',
});
const ukDay = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'short',
  timeZone: 'Europe/London',
});
/**
 * "14:05" today, else "13 November 2026 at 14:05" (UK time). Rounded up to the next whole minute,
 * so it never names a time before the database's deadline (14:05:59 reads "from 14:06").
 */
function fromTime(iso: string, now = new Date()): string {
  const at = new Date(Math.ceil(Date.parse(iso) / 60_000) * 60_000);
  return ukDay.format(at) === ukDay.format(now)
    ? timeOnly.format(at)
    : sentAt(at.toISOString());
}

/** Which file a media refusal is about, as moderators read it. */
const fileOf = (story: Pick<ModerationStory, 'primaryFormat'>) =>
  story.primaryFormat === 'video'
    ? 'video'
    : story.primaryFormat === 'audio'
      ? 'audio file'
      : 'picture';

/**
 * Why a decision didn't go through, in plain words (Joel, 2026-11-09: never codes), and what the
 * page does next: `refresh` when the story moved on (D-1: the first decision wins), `anyway` when
 * an Admin may approve anyway (only while the media is still being processed; G11 B, G24).
 */
export interface Refusal {
  message: string;
  refresh?: boolean;
  anyway?: boolean;
}

export function decisionRefusal(
  err: unknown,
  story: Pick<ModerationStory, 'primaryFormat'>,
  route: DecisionRoute,
): Refusal {
  const what = fileOf(story);
  const verb = route === 'show' ? 'show it again' : 'approve it';
  if (err instanceof StaleVersion) {
    return {
      message:
        'This story changed since you opened it. Here it is as it is now.',
      refresh: true,
    };
  }
  if (err instanceof ApiUserProblem) {
    const p = err.problem as { code?: string; availableAt?: string };
    switch (p.code) {
      case 'already_decided':
        return {
          message: 'Another moderator has already decided this story.',
          refresh: true,
        };
      case 'wrong_status':
        return {
          message:
            'This story changed since you opened it. Here it is as it is now.',
          refresh: true,
        };
      case 'media_recently_uploaded':
        return {
          message: p.availableAt
            ? `The ${what} is still being processed. You can ${verb} from ${fromTime(p.availableAt)}.`
            : `The ${what} is still being processed. Try again in a few minutes.`,
        };
      case 'media_still_processing':
        return {
          message: `The ${what} is still being processed. Try again in a few minutes.`,
          anyway: true,
        };
      case 'media_not_ready':
        return {
          message: `The ${what} hasn’t finished processing, so you can’t ${verb} yet.`,
        };
      case 'testimony_consent_required':
        return {
          message:
            'This story can’t go on the site: the person hasn’t agreed to the testimony consent.',
        };
      case 'validation_failed':
        return {
          message: err.problem.errors?.[0]?.message ?? 'Check your note.',
        };
    }
    if (err.status === 404) {
      return {
        message: 'This story is no longer here. It may have been deleted.',
        refresh: true,
      };
    }
  }
  return { message: moderationProblem(err) };
}

/** What to tell a moderator when api-admin refused or couldn't answer. */
export function moderationProblem(err: unknown): string {
  if (err instanceof NotSignedIn) return 'You’re signed out. Sign in again.';
  if (err instanceof ApiUserProblem && err.status === 403)
    return 'This page is for moderators.';
  return TRY_AGAIN_LATER;
}

const when = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'Europe/London',
});
/** A time as moderators read it, in UK time: "9 November 2026 at 14:05". */
export const sentAt = (iso: string) => when.format(new Date(iso));

export const FORMAT_LABEL = {
  video: 'Video',
  audio: 'Audio',
  written: 'Written',
} as const;
