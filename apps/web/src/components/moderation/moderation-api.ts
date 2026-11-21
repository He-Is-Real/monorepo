import type { StatusTone } from '@heisreal/web-ui';
import {
  sanitizeStoryFilters,
  type StoryFilters,
  type StoryFormat,
} from '@heisreal/story-filters';
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
  primaryFormat: StoryFormat;
  themes: { id: string; name: string }[];
  /** When it entered this state (a draft: when it was started); the list's order. */
  since: string;
  sentAt: string | null;
  updatedAt: string;
  /**
   * Part 1a: `ours` when it waits for review or the site took it off, and its file's check keeps
   * giving up on our side (after the nightly retries): "A problem on our side".
   */
  mediaProblem?: 'ours' | null;
}

/**
 * api-admin's `ModerationListCounts` (MQ-1 E): each state's stories whatever the filters (drafts
 * only for an Admin), and this state's by format with the search and theme but not the format.
 */
export interface ListCounts {
  states: Partial<Record<ListState, number>>;
  formats: Record<StoryFormat, number>;
}

export interface ListPage {
  data: ListItem[];
  nextCursor: string | null;
  counts: ListCounts;
}

/** MQ-1 E: the list's orders; `oldest` (the old queue's) is the default. */
export const SORTS = [
  { sort: 'oldest', label: 'Oldest first' },
  { sort: 'newest', label: 'Newest first' },
  { sort: 'changed', label: 'Recently changed' },
] as const;
export type Sort = (typeof SORTS)[number]['sort'];

/**
 * What the list shows (MQ-1 E): every filter and the sort live in the address. The theme and
 * format are browse's own filter (libs/story-filters; revised OQ-2, Joel 2026-11-19): one format,
 * and themes stacked, a story carrying every one (BS-7, Joel 2026-11-21).
 */
export interface ListFilters extends StoryFilters {
  state: ListState;
  q: string | null;
  sort: Sort;
}

/** api-admin's limit on the search: a longer one would be a 400. */
const MAX_SEARCH = 100;

const all = (v: string | string[] | undefined) =>
  v === undefined ? [] : typeof v === 'string' ? [v] : v;

/**
 * The list's filters from its address, keeping only what api-admin takes (anything else is left
 * out, as an unknown state opens on the default). Whether drafts are allowed is the caller's.
 */
export function listFilters(
  sp: Record<string, string | string[] | undefined>,
): ListFilters {
  const [state] = all(sp['state']);
  const [sort] = all(sp['sort']);
  const q = all(sp['q'])[0]?.trim() ?? '';
  return {
    state: isListState(state) ? state : 'pending',
    q: q === '' ? null : [...q].slice(0, MAX_SEARCH).join(''),
    // As browse reads its address: an unknown or repeated one is left out (themes stack, BS-7).
    ...sanitizeStoryFilters({ theme: sp['theme'], format: sp['format'] }),
    sort: SORTS.some((s) => s.sort === sort) ? (sort as Sort) : 'oldest',
  };
}

/** The filters as query parameters, defaults left out (the page's address and api-admin's). */
export function listQuery(f: ListFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.state !== 'pending') sp.set('state', f.state);
  if (f.q) sp.set('q', f.q);
  if (f.format) sp.set('format', f.format);
  for (const id of f.themes) sp.append('theme', id);
  if (f.sort !== 'oldest') sp.set('sort', f.sort);
  return sp;
}

/** The list's address for these filters. */
export function moderationHref(f: ListFilters): string {
  const sp = listQuery(f);
  return sp.size ? `/moderation?${sp}` : '/moderation';
}

/** How many filters are on (the phone's "Filters and sort (N)"): the sort isn't one. */
export const activeFilters = (f: ListFilters) =>
  (f.q ? 1 : 0) + (f.format ? 1 : 0) + f.themes.length;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** OQ-2: how long a story has been in its state: "14 min", "2 h 14 min", "3 days". */
export function waitingFor(since: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(since));
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const min = Math.floor((ms % HOUR) / MINUTE);
    return min ? `${h} h ${min} min` : `${h} h`;
  }
  const days = Math.floor(ms / DAY);
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * OQ-2 (Joel, 2026-11-17): on Waiting for review only, a story waiting over 2 days is `late`
 * (orange), over 7 days `overdue` (red).
 */
export function waitingAlert(
  state: ListState,
  since: string,
  now: number,
): 'late' | 'overdue' | null {
  if (state !== 'pending') return null;
  const ms = now - Date.parse(since);
  return ms > 7 * DAY ? 'overdue' : ms > 2 * DAY ? 'late' : null;
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

/** A state's badge colour, by meaning (CH-2 A, Joel, 20 November 2026), as on My submissions. */
export function stateTone(state: string, action: string | null): StatusTone {
  switch (state) {
    case 'pending':
      return 'brand';
    case 'approved':
      return 'success';
    case 'rejected':
      return 'danger';
    case 'hidden':
      return 'warning';
    case 'editing':
      return action === 'changesRequested' || action === 'fileUnusable'
        ? 'brand'
        : 'neutral';
  }
  return 'neutral';
}

/** api-admin's `ModerationStatusEntry`. */
export interface StatusEntry {
  /** What happened (the step); `status` is where it left the story. */
  action: string;
  status: string;
  actor: 'person' | 'moderator' | 'system';
  comment: string | null;
  /** On a moderator's entry: the Moderator's or Admin's email (EM-1); else null. */
  staffEmail: string | null;
  at: string;
}

/** api-admin's `StoryModeration` (M3 task 3.2; M3 plan PR 6). */
export interface ModerationStory {
  id: string;
  version: number;
  /**
   * Waiting for review, published, hidden (G5) or rejected (OV-1 C): something to decide. Being
   * edited (a draft when `submittedAt` is null, Admins only): read only (MD-4).
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
  /** Whether `senderIp` is on the block list (EM-2); null when `senderIp` is. */
  senderIpBlocked: boolean | null;
  /** The email it was last sent with: Admins only, kept as long as the story (EM-1 B). */
  senderEmail: string | null;
  /** Whether `senderEmail` is on the block list (EM-2); null when `senderEmail` is. */
  senderEmailBlocked: boolean | null;
  /** What a decision names in `If-Match` (G14 B). */
  reviewTag: string;
  statusLog: StatusEntry[];
}

/** The decisions, by api-admin's route, and the status entry each adds. */
export type DecisionRoute =
  | 'approve'
  | 'request-changes'
  | 'reject'
  | 'hide'
  | 'show'
  | 'return-to-queue';

/** What the moderator did, as the page confirms it (and an Admin's Delete, P1-11). */
export const DONE: Record<DecisionRoute | 'delete', string> = {
  approve: 'Approved. It’s on the site now.',
  'request-changes': 'Sent back. The person can read your note.',
  reject: 'Rejected. The person can read your note.',
  hide: 'Taken down. It stays off the site until a moderator shows it again.',
  show: 'Shown again. It’s back on the site.',
  'return-to-queue':
    'Put back in the waiting list. Any moderator can decide it again.',
  delete: 'Deleted. The story and its files are gone.',
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
  route: DecisionRoute | 'delete',
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
      case 'picture_changed_at_bunny':
        // RE-2 B (Joel, 2026-11-17): approve anyway can't fix it; sending it back can.
        return {
          message:
            'The picture changed at Bunny. Send it back so the person sends again.',
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

const shortDay = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Europe/London',
});
/** A time in the list's columns, in UK time: "9 Nov 2026, 14:05". */
export const listTime = (iso: string) => {
  const d = new Date(iso);
  return `${shortDay.format(d)}, ${timeOnly.format(d)}`;
};

/** What each format is called: the shared filter's names (libs/story-filters). */
export { FORMAT_LABELS as FORMAT_LABEL } from '@heisreal/story-filters';
