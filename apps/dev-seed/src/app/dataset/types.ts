import type { ClipId, ImageId } from '../media';

/**
 * Where a fixture story ends up (Story states, Joel 2026-11-11), as its owner would see it: a
 * draft never sent, waiting for review, published, not accepted, sent back for changes, or sent and
 * then taken down by its owner to edit. The database records the last three's state as `editing`
 * (sent back, being edited) or `rejected`.
 */
export type StoryStatus =
  'draft' | 'pending' | 'approved' | 'rejected' | 'sent_back' | 'editing';

export type StoryFormat = 'video' | 'audio' | 'written';

/** A2: workflow's processing state. NONE (absent) = not processed yet. */
export type Processing = 'processing' | 'ready' | 'failed';

/** themeCategory:<id>, a fixed ULID so links survive resets; Other is the schema's own. */
export interface ThemeCategoryFixture {
  /** How the dataset refers to it. */
  key: string;
  id: string;
  name: string;
}

export interface ThemeFixture {
  /** How the dataset refers to it (stories' `themes`). */
  key: string;
  /** theme:<id>, a fixed ULID so ?theme= links survive resets */
  id: string;
  name: string;
  /** A category's key, or `other` (themeCategory:other) */
  category: string;
  /** Shown first, under its category's name */
  highlighted?: true;
}

/** A moderator's decision (a status log entry, R6) and what the submitter is told. */
export interface ReviewFixture {
  decision: 'approve' | 'reject' | 'request_changes';
  feedback?: string;
}

export interface StoryFixture {
  /** story:<id>; always starts with `seed_` */
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
  /** theme keys, at most 5 */
  themes: string[];
  /**
   * Video and audio: the clip. Omitted on a draft before its upload. A story points only at its
   * own storyFile rows (R12), so a clip's upload at Bunny belongs to one story. `placeholder`: a
   * story that is never public gets a row of its own under this made-up Bunny-style id
   * (`00000000-0000-0000-0000-<12 hex>`), with the clip's facts once processed and no file at
   * Bunny: nothing is uploaded or deleted there for it (a delete answers 404, which counts as done).
   */
  media?: { clip: ClipId; processing?: Processing; placeholder?: string };
  /** Written only: the optional image. */
  image?: { file: ImageId; alt?: string; processing?: Processing };
  /**
   * Where the story ends up. The seed walks it there the way the services will (sent, then a
   * moderator's decisions, then the owner's Edit), so its status log and versions look real.
   */
  status: StoryStatus;
  /**
   * The moderation decisions, in order. Each one follows a send (moderators decide straight from
   * pending). `request_changes` sends it back; the next decision follows a send again. The last
   * one decides the final status (approve → approved, reject → rejected, request_changes →
   * sent_back). A pending story has none yet; an `editing` one none, or an approval before Edit.
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
  categories: ThemeCategoryFixture[];
  themes: ThemeFixture[];
  stories: StoryFixture[];
  /**
   * D112: dev's Clerk test accounts (their Clerk user ids, `user_…`), marked trusted submitters
   * on every reset so D94's limits don't get in the way of testing (dev only).
   */
  testAccounts: string[];
  /**
   * Plan 4e: dev's Clerk test accounts that start every run as newcomers. Each reset clears their
   * terms of use and testimony consent (dev-seed is a system user, which may), so signing in
   * shows the terms step every time. Not trusted submitters: they never get past that step.
   */
  newcomerAccounts: string[];
}
