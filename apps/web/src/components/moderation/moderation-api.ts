import { ApiUserProblem, NotSignedIn, StaleVersion } from '@/lib/api-user';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';
import type { MediaPlayback, StoryImage } from '@/lib/public-stories';

/** api-admin's `ModerationQueueItem` (M3 task 3.1). */
export interface QueueItem {
  id: string;
  version: number;
  status: string;
  title: string;
  primaryFormat: 'video' | 'audio' | 'written';
  submittedAt: string;
}

export interface QueuePage {
  data: QueueItem[];
  nextCursor: string | null;
}

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
  /** Waiting for review, published, or hidden (G5). */
  status: 'pending' | 'approved' | 'hidden';
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
  submittedAt: string;
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
/** "14:05" today, else "13 November 2026 at 14:05" (UK time). */
function fromTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  return ukDay.format(at) === ukDay.format(now)
    ? timeOnly.format(at)
    : sentAt(iso);
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
