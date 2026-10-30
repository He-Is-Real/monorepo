import type { ClipId, ImageId } from '../media';

export type StoryStatus =
  | 'draft'
  | 'pending'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'withdrawn';

export type StoryFormat = 'video' | 'audio' | 'written';

/** A2: workflow's processing state. NONE (absent) = not processed yet. */
export type Processing = 'processing' | 'ready' | 'failed';

export type TagCategory = 'theme' | 'journey' | 'emotion';

export interface TagFixture {
  /** tag:<id>, also the slug in URLs */
  id: string;
  name: string;
  category: TagCategory;
}

/** A moderation decision (moderationReview.decision) and what the submitter is told. */
export interface ReviewFixture {
  decision: 'approve' | 'reject' | 'request_changes' | 'escalate';
  feedback?: string;
}

export interface StoryFixture {
  /** story:<id> (and publicStory:<id>); always starts with `seed_` */
  id: string;
  slug: string;
  title: string;
  description: string;
  /** Written: required (at least 200 characters from submit on). Video/audio: optional text. */
  body?: string;
  /** NONE = anonymous */
  bylineName?: string;
  /** user:<id>, a fixture person */
  submitter: string;
  format: StoryFormat;
  /** tag ids, at most 5 */
  tags: string[];
  /** Video and audio: the clip. Omitted on a draft before its upload. */
  media?: { clip: ClipId; processing?: Processing };
  /** Written only: the optional image. */
  image?: { file: ImageId; alt?: string; processing?: Processing };
  /**
   * Where the story ends up. The seed walks it there the way the services will (draft →
   * pending → in_review → …), so submittedAt, versions and reviews look real.
   */
  status: StoryStatus;
  /**
   * The moderation decisions, in order. Each one follows a submit and a moderator picking the
   * story up. `request_changes` sends it back; the next decision follows a resubmit. The last
   * one decides the final status (approve → approved, reject → rejected, request_changes →
   * changes_requested; escalate keeps it in review).
   */
  reviews?: ReviewFixture[];
  /** Approved stories: how many days ago it was published (browse order). */
  publishedDaysAgo?: number;
}

export interface Dataset {
  /** Fixture people: user:<id>, no Clerk account, so nobody can sign in as them. */
  people: string[];
  /** The fixture moderator who wrote every review (no Clerk account either). */
  moderator: string;
  tags: TagFixture[];
  stories: StoryFixture[];
  /**
   * D112: dev's Clerk test accounts (their Clerk user ids, `user_…`), marked trusted submitters
   * on every reset so D94's limits don't get in the way of testing (dev only).
   */
  testAccounts: string[];
}
