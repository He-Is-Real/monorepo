import { formRef, recordKey, storySharing } from '@heisreal/consent';
import { runQuery } from '@heisreal/database';
import type { MediaUrls } from '@heisreal/story-cards';
import type { SurrealQueryable } from 'surrealdb';
import type { ClerkProfile } from '../erasure/clerk-backend';

/** How long the file's media links work (M2 decisions: "media as 1-hour links"). */
export const LINK_SECONDS = 60 * 60;

/**
 * Everything the database holds about the person, read in one query in **their own session**
 * (D27): every table below shows a person their own rows and nobody else's, so the export can't
 * reach anyone else's data whatever this query asks. `moderationReview.moderator` reads as absent
 * to them (api-admin's alone), and the story fields kept from them (`lockedBy`) aren't asked for.
 */
const HELD_SQL = `
LET $stories = SELECT id, slug, status, title, description, body, bylineName, primaryFormat,
    tagRefs.map(|$t| { slug: record::id($t), name: $t.name }) AS tags, media, image,
    rejectionFeedback, createdAt, updatedAt, submittedAt, approvedAt,
    fn::story::draft_expires_at(id) AS draftExpiresAt,
    fn::consent::story_sharing(submitter, id) AS sharing,
    fn::consent::valid(fn::consent::story_sharing(submitter, id)) AS sharingCounts
  FROM story WHERE submitter = $auth ORDER BY createdAt DESC, id DESC;
LET $mine = $stories.map(|$s| $s.id);
LET $public = $stories.map(|$s| type::record('publicStory', record::id($s.id)));
LET $hearts = SELECT id, record::id(story) AS story, createdAt FROM favourite
  WHERE person = $auth ORDER BY createdAt DESC, id DESC;
LET $hearted = $hearts.map(|$h| type::record('publicStory', $h.story));
RETURN {
  user: (SELECT record::id(id) AS id, createdAt FROM ONLY $auth),
  stories: $stories,
  published: IF array::len($public) > 0 {
    (SELECT record::id(id) AS id, publishedAt, image.path AS imagePath FROM $public)
  } ELSE { [] },
  reviews: IF array::len($mine) > 0 {
    (SELECT record::id(story) AS story, decision, feedbackToSubmitter, storyVersion, decidedAt
       FROM moderationReview WHERE story IN $mine ORDER BY decidedAt ASC)
  } ELSE { [] },
  consents: (SELECT id, type, event, form, form.statements AS statements, dpaVersion, termsVersion,
      story, mechanism, evidenceHash, evidenceVersion, occurredAt, legacyGivenAt
    FROM consent WHERE subject = $auth ORDER BY occurredAt ASC, id ASC),
  hearts: $hearts,
  heartedPublic: IF array::len($hearted) > 0 {
    (SELECT record::id(id) AS id, slug FROM $hearted)
  } ELSE { [] },
  limits: (SELECT trusted, openDraftsMax, submissionsPer7Days, uploadRequestsPerHour,
      uploadsPer7Days, updatedAt
    FROM ONLY type::record('submitterLimits', record::id($auth))),
  effective: fn::limits::effective($auth),
  submissions: (SELECT at FROM submissionLog WHERE person = $auth ORDER BY at ASC),
  uploads: (SELECT record::id(id) AS id, record::id(story) AS story, format, contentType,
      sizeBytes, durationSeconds, at, renewedAt
    FROM uploadGrant WHERE person = $auth ORDER BY at ASC),
  keys: (SELECT record::id(id)[2] AS key, status, expiresAt FROM idempotencyKey
    WHERE record::id(id)[0] = 'api-user' AND record::id(id)[1] = $auth ORDER BY expiresAt ASC)
};`;

type Opt<T> = T | null | undefined;

interface Held {
  user: { id: string; createdAt: string } | null;
  stories: {
    id: string;
    slug: string;
    status: string;
    title: string;
    description: string;
    body?: Opt<string>;
    bylineName?: Opt<string>;
    primaryFormat: string;
    tags: { slug: string; name?: Opt<string> }[];
    media?: Opt<
      {
        format: 'video' | 'audio';
        bunnyVideoId?: Opt<string>;
        thumbnailPath?: Opt<string>;
        width?: Opt<number>;
        height?: Opt<number>;
        durationSeconds?: Opt<number>;
        processing?: Opt<string>;
      }[]
    >;
    image?: Opt<{
      path: string;
      width: number;
      height: number;
      alt?: Opt<string>;
    }>;
    rejectionFeedback?: Opt<string>;
    createdAt: string;
    updatedAt: string;
    submittedAt?: Opt<string>;
    approvedAt?: Opt<string>;
    draftExpiresAt?: Opt<string>;
    sharing?: Opt<{ event?: string; form?: Opt<string>; occurredAt?: string }>;
    sharingCounts?: Opt<boolean>;
  }[];
  published: { id: string; publishedAt: string; imagePath?: Opt<string> }[];
  reviews: {
    story: string;
    decision: string;
    feedbackToSubmitter?: Opt<string>;
    storyVersion: number;
    decidedAt: string;
  }[];
  consents: {
    id: string;
    type: string;
    event: string;
    form?: Opt<string>;
    statements?: Opt<{ key: string; label: string }[]>;
    dpaVersion: string;
    termsVersion?: Opt<string>;
    story?: Opt<string>;
    mechanism: string;
    evidenceHash: string;
    evidenceVersion?: Opt<number>;
    occurredAt: string;
    legacyGivenAt?: Opt<string>;
  }[];
  hearts: { story: string; createdAt: string }[];
  heartedPublic: { id: string; slug: string }[];
  limits: Opt<{
    trusted?: Opt<boolean>;
    openDraftsMax?: Opt<number>;
    submissionsPer7Days?: Opt<number>;
    uploadRequestsPerHour?: Opt<number>;
    uploadsPer7Days?: Opt<number>;
    updatedAt?: Opt<string>;
  }>;
  effective: Record<string, Opt<number | boolean>>;
  submissions: { at: string }[];
  uploads: {
    id: string;
    story: string;
    format: string;
    contentType: string;
    sizeBytes: number;
    durationSeconds?: Opt<number>;
    at: string;
    renewedAt?: Opt<string>;
  }[];
  keys: { key: string; status: number; expiresAt: string }[];
}

/** The person's rows, read in their own session. */
export async function readHeld(person: SurrealQueryable): Promise<Held> {
  const results = await runQuery(person, HELD_SQL);
  const held = results.at(-1) as Held;
  // The session opened as this person, so their row exists; checked anyway, fail closed.
  if (!held?.user)
    throw new Error('The signed-in person’s user row is missing');
  return held;
}

const iso = (d: Opt<string>) => (d ? new Date(d).toISOString() : null);
const or = <T>(v: Opt<T>): T | null => v ?? null;

/** What each part of the file is, in plain words (the contract's `about.sections`). */
const SECTIONS = {
  account:
    'Your account here: its id in our database, when it was made, and your role on the site.',
  signIn:
    'What Clerk, the company that runs our sign-in, holds about you: your names, email addresses, phone numbers, any accounts you sign in with (such as Google), your picture if you gave one, and when you made the account and last signed in. We read it from Clerk when you asked for this file; we don’t keep a copy. You can change it under Manage account.',
  stories:
    'Every story you have started or shared, whatever its status, newest first: its words, themes and name on the story, and whether it is on the site now. "moderation" lists each decision our moderators made on it, with any feedback to you, but not who made it. A video or audio story has its id at Bunny, the company that stores and plays our videos, and a link to watch or listen to it; a picture on a story that is on the site has a link to the picture (a picture not on the site has none, as we can only vouch for the file once a moderator has approved it). These links stop working at the time in "linksExpireAt", so ask for a new file to get new ones. "draftExpiresAt" is when an untouched draft will be deleted. "sharing" is whether you let our media team share that story beyond heisreal.today (you choose it for each story): "granted" is your latest choice for it, "counts" whether that choice was made on a version of our sharing form that still counts, and "formVersion" and "occurredAt" which version and when. We only ever share a story while it is on the site.',
  consents:
    'Every time you gave or withdrew a consent, oldest first, with the words of the box you ticked, the form and the version of our privacy policy (and terms of use) it was given under. Sharing a story beyond heisreal.today is chosen for each story, so those name the story ("storyId"); every other consent covers all your stories. "evidenceHash" is a fingerprint of exactly what you were shown, so either of us can prove it. We keep this record even after you delete your account, for six years, as proof that we asked.',
  favourites:
    'The stories you hearted, newest first, and when. Hearts are private: nobody else sees them, not even the story’s author. The stories belong to their authors, so this file only says which ones, with their address on the site while they are public.',
  limits:
    'The limits on starting and submitting stories and uploading files that apply to you now ("effective"; null means no limit), and any limits an admin set for you alone ("overrides"; "trusted" means the usual limits don’t apply).',
  submissions:
    'When you sent a story for review in the last seven days. We keep these for seven days to apply the weekly limit, then delete them.',
  uploads:
    'Each video or audio file you started uploading: which story, the kind of file, its size and length, and when. We keep these to apply the upload limits.',
  requestKeys:
    'Codes your browser sent with your recent changes, so that pressing a button twice does a change only once. Each is deleted after 24 hours.',
} as const;

const NOT_INCLUDED = [
  'The files of your videos and audio. We never keep the file you uploaded once it is ready to play, and our servers never carry your media: use each item’s link to watch or listen to it, or ask us for help to get a copy.',
  'Who moderated your stories. You get every decision and the feedback to you, not the moderator’s name or id.',
  'Our audit log: a record, by ids only and without any of your words, of things done to your account and stories (for example, a story approved or taken off the site). We keep it for six years as a record of what we did. Ask us if you want it.',
  'Your sign-in sessions and devices, which Clerk keeps. You can see and end them under Manage account.',
  'Anyone else’s data, including the words of the stories you hearted.',
] as const;

/** fn::limits::effective's limits (the contract's `AccountExport.limits.effective`). */
const EFFECTIVE_LIMITS = [
  'openDraftsMax',
  'submissionsPer7Days',
  'uploadRequestsPerHour',
  'uploadsPer7Days',
  'videoMaxBytes',
  'audioMaxBytes',
  'mediaMaxSeconds',
] as const;

/** The contract's `AccountExport`. */
export function toExport(
  held: Held,
  {
    role,
    signIn,
    urls,
    generatedAt,
  }: { role: string; signIn: ClerkProfile; urls: MediaUrls; generatedAt: Date },
) {
  const publishedAt = new Map(held.published.map((p) => [p.id, p.publishedAt]));
  // A picture is signed only as published (approved by a moderator, and public anyway): a
  // draft's image.path is the person's own write, so signing it could hand them a link to any
  // file in the storage zone they name.
  const publishedImage = new Map(
    held.published.map((p) => [p.id, p.imagePath ?? null]),
  );
  const reviewsOf = (story: string) =>
    held.reviews
      .filter((r) => r.story === story)
      .map((r) => ({
        decision: r.decision,
        feedbackToSubmitter: or(r.feedbackToSubmitter),
        storyVersion: r.storyVersion,
        decidedAt: iso(r.decidedAt) as string,
      }));
  const publicPath = new Map(
    held.heartedPublic.map((p) => [p.id, `/stories/${p.slug}`]),
  );
  const limits = held.limits ?? null;
  return {
    about: {
      format: 'he-is-real-my-data',
      formatVersion: 1,
      generatedAt: generatedAt.toISOString(),
      linksExpireAt: urls.linksExpireAt(),
      summary:
        'Everything He Is Real Today holds about you, as you asked for it. Each part is explained in "sections" below, and "notIncluded" says what this file leaves out and why. Times are in UTC.',
      sections: SECTIONS,
      notIncluded: NOT_INCLUDED,
    },
    account: {
      id: held.user!.id,
      createdAt: iso(held.user!.createdAt) as string,
      role,
    },
    signIn,
    stories: held.stories.map((s) => {
      const id = recordKey(s.id);
      return {
        id,
        slug: s.slug,
        status: s.status,
        onSiteNow: publishedAt.has(id),
        title: s.title,
        description: s.description,
        body: or(s.body),
        bylineName: or(s.bylineName),
        primaryFormat: s.primaryFormat,
        tags: s.tags.flatMap((t) =>
          t.name ? [{ slug: t.slug, name: t.name }] : [],
        ),
        media: (s.media ?? []).map((m) => ({
          format: m.format,
          bunnyVideoId: or(m.bunnyVideoId),
          playbackUrl: urls.playbackUrl(m.bunnyVideoId),
          thumbnailUrl: urls.thumbnailUrl(m.bunnyVideoId, m.thumbnailPath),
          width: or(m.width),
          height: or(m.height),
          durationSeconds: or(m.durationSeconds),
          processing: or(m.processing),
        })),
        image: s.image
          ? {
              url: urls.imageUrl(publishedImage.get(id)),
              width: s.image.width,
              height: s.image.height,
              alt: or(s.image.alt),
            }
          : null,
        rejectionFeedback: or(s.rejectionFeedback),
        moderation: reviewsOf(id),
        createdAt: iso(s.createdAt) as string,
        updatedAt: iso(s.updatedAt) as string,
        submittedAt: iso(s.submittedAt),
        approvedAt: iso(s.approvedAt),
        publishedAt: iso(publishedAt.get(id)),
        draftExpiresAt: iso(s.draftExpiresAt),
        sharing: storySharing(s.sharing, s.sharingCounts),
      };
    }),
    consents: held.consents.map((c) => {
      const ref = formRef(c.form);
      return {
        id: recordKey(c.id),
        type: c.type,
        event: c.event,
        statement: c.statements?.find((b) => b.key === c.type)?.label ?? null,
        form: ref?.form ?? null,
        formVersion: ref?.formVersion ?? null,
        privacyPolicyVersion: recordKey(c.dpaVersion),
        termsVersion: c.termsVersion ? recordKey(c.termsVersion) : null,
        storyId: c.story ? recordKey(c.story) : null,
        mechanism: c.mechanism,
        evidenceHash: c.evidenceHash,
        evidenceVersion: or(c.evidenceVersion),
        occurredAt: iso(c.occurredAt) as string,
        legacyGivenAt: iso(c.legacyGivenAt),
      };
    }),
    favourites: held.hearts.map((h) => ({
      storyId: h.story,
      heartedAt: iso(h.createdAt) as string,
      publicPath: publicPath.get(h.story) ?? null,
    })),
    limits: {
      trusted: limits?.trusted === true,
      overrides: limits
        ? {
            openDraftsMax: or(limits.openDraftsMax),
            submissionsPer7Days: or(limits.submissionsPer7Days),
            uploadRequestsPerHour: or(limits.uploadRequestsPerHour),
            uploadsPer7Days: or(limits.uploadsPer7Days),
          }
        : null,
      overridesChangedAt: iso(limits?.updatedAt),
      // Every limit named, null where none applies (the database leaves those out).
      effective: Object.fromEntries(
        EFFECTIVE_LIMITS.map((k) => {
          const v = held.effective[k];
          return [k, typeof v === 'number' ? v : null];
        }),
      ),
    },
    submissions: held.submissions.map((s) => ({ at: iso(s.at) as string })),
    uploads: held.uploads.map((u) => ({
      bunnyVideoId: u.id,
      storyId: u.story,
      format: u.format,
      contentType: u.contentType,
      sizeBytes: u.sizeBytes,
      durationSeconds: or(u.durationSeconds),
      requestedAt: iso(u.at) as string,
      renewedAt: iso(u.renewedAt),
    })),
    requestKeys: held.keys.map((k) => ({
      key: k.key,
      status: k.status,
      expiresAt: iso(k.expiresAt) as string,
    })),
  };
}
