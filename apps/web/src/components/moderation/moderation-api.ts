import { ApiUserProblem, NotSignedIn } from '@/lib/api-user';
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

/** api-admin's `StoryModeration` (M3 task 3.2). */
export interface ModerationStory {
  id: string;
  version: number;
  status: string;
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
  statusLog: StatusEntry[];
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
