import { dummyText } from './text';
import type { Dataset, StoryFixture, TagFixture } from './types';

export * from './text';
export * from './types';

/**
 * The D47 dummy dataset: about 25 obviously fake stories over every story type (D53), moderation
 * state and edge case, 8 fixture people without Clerk accounts, and the browse tags. It can grow
 * during development; `dataset.spec.ts` checks it still covers what D47 asks for and fits the
 * schema's limits, and the integration test loads it into a real SurrealDB.
 *
 * Written stories have at least 200 characters of text from submit on (Joel, 2026-10-23) and at
 * most 10,000 (A3).
 */

const PEOPLE = [
  'seed_ruth',
  'seed_daniel',
  'seed_amara',
  'seed_joon',
  'seed_eleni',
  'seed_tomasz',
  'seed_grace',
];
const MODERATOR = 'seed_moderator';

// The browse list (project content/browse.md), sorted into theme, journey and emotion.
const TAGS: TagFixture[] = [
  { id: 'healing', name: 'Healing', category: 'theme' },
  { id: 'addiction', name: 'Addiction', category: 'theme' },
  { id: 'loss', name: 'Loss', category: 'theme' },
  { id: 'depression', name: 'Depression', category: 'theme' },
  { id: 'relationships', name: 'Relationships', category: 'theme' },
  { id: 'loneliness', name: 'Loneliness', category: 'theme' },
  { id: 'illness', name: 'Illness', category: 'theme' },
  { id: 'parenting', name: 'Parenting', category: 'theme' },
  { id: 'faith', name: 'Faith', category: 'journey' },
  { id: 'answered-prayers', name: 'Answered Prayers', category: 'journey' },
  { id: 'forgiveness', name: 'Forgiveness', category: 'journey' },
  { id: 'salvation', name: 'Salvation', category: 'journey' },
  { id: 'doubt', name: 'Doubt', category: 'journey' },
  { id: 'hope', name: 'Hope', category: 'emotion' },
  { id: 'peace', name: 'Peace', category: 'emotion' },
  { id: 'grief', name: 'Grief', category: 'emotion' },
  { id: 'joy', name: 'Joy', category: 'emotion' },
];

const FEEDBACK_CHANGES =
  'Thank you for sharing this. It is a test story, so this is test feedback: could you say a little more about what happened next? Take your time; we will read it again when you are ready.';
const FEEDBACK_REJECT =
  'Thank you for trusting us with this. This is test feedback for a test story: we are not able to publish it as it is, but we are grateful you wrote it and you are welcome to share again.';

// A title at the 140-character limit.
const TITLE_140 =
  'Test story with the longest title the site allows, written to check that one hundred and forty characters wrap well, on cards and on a page.';

// The description limit is 5,000 characters; this one is long on purpose (D47 edge case).
const LONG_DESCRIPTION = dummyText(4800, 3);

const STORIES: StoryFixture[] = [
  // ------------------------------------------------------------- video (12)
  {
    id: 'seed_v01',
    slug: 'test-video-vertical-phone',
    title: 'Test video: a vertical phone clip',
    description:
      'Dummy video story (9:16) with text, for the development site.',
    body: dummyText(640, 0),
    bylineName: 'Ruth (test)',
    submitter: 'seed_ruth',
    format: 'video',
    tags: ['healing', 'faith', 'hope'],
    media: { clip: 'clip-01', processing: 'ready' },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 2,
  },
  {
    id: 'seed_v02',
    slug: 'test-video-tall-phone',
    title: 'Test video: a taller phone clip (9:19.5)',
    description: 'Dummy video story taller than the 9:16 clamp, without text.',
    bylineName: 'Daniel (test)',
    submitter: 'seed_daniel',
    format: 'video',
    tags: ['answered-prayers'],
    media: { clip: 'clip-02', processing: 'ready' },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 5,
  },
  {
    // Sent back once, resubmitted, then approved: a two-review history. Five tags (the maximum).
    id: 'seed_v03',
    slug: 'test-video-landscape-five-tags',
    title: 'Test video: landscape, with the maximum of five tags',
    description:
      'Dummy 16:9 video story with text and five tags. It was sent back once.',
    body: dummyText(1200, 1),
    bylineName: 'Amara (test)',
    submitter: 'seed_amara',
    format: 'video',
    tags: ['healing', 'loss', 'faith', 'forgiveness', 'peace'],
    media: { clip: 'clip-03', processing: 'ready' },
    status: 'approved',
    reviews: [
      { decision: 'request_changes', feedback: FEEDBACK_CHANGES },
      { decision: 'approve' },
    ],
    publishedDaysAgo: 8,
  },
  {
    id: 'seed_v04',
    slug: 'test-video-wide-cinema',
    title: 'Test video: a wide 2.4:1 clip',
    description: 'Dummy video story wider than the 2:1 clamp, without text.',
    bylineName: 'Joon (test)',
    submitter: 'seed_joon',
    format: 'video',
    tags: ['salvation', 'joy'],
    media: { clip: 'clip-04', processing: 'ready' },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 11,
  },
  {
    // Anonymous byline.
    id: 'seed_v05',
    slug: 'test-video-square-anonymous',
    title: 'Test video: square, shared anonymously',
    description: 'Dummy 1:1 video story with text and no name.',
    body: dummyText(420, 2),
    submitter: 'seed_eleni',
    format: 'video',
    tags: ['addiction', 'forgiveness'],
    media: { clip: 'clip-05', processing: 'ready' },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 14,
  },
  {
    // Non-Latin text: "test story" in Greek, Korean and Japanese; "This is a test story for
    // development only." in Arabic.
    id: 'seed_v06',
    slug: 'test-video-non-latin',
    title: 'Δοκιμαστική ιστορία · 테스트 이야기 · テスト用の物語',
    description:
      'هذه قصة تجريبية لأغراض التطوير فقط. Dummy video story with a non-Latin title.',
    bylineName: 'Ελένη (test)',
    submitter: 'seed_eleni',
    format: 'video',
    tags: ['relationships'],
    media: { clip: 'clip-06', processing: 'ready' },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 17,
  },
  {
    // No tags.
    id: 'seed_v07',
    slug: 'test-video-no-tags',
    title: 'Test video: no tags at all',
    description: 'Dummy 16:9 video story with text and zero tags.',
    body: dummyText(300, 4),
    bylineName: 'Tomasz (test)',
    submitter: 'seed_tomasz',
    format: 'video',
    tags: [],
    media: { clip: 'clip-07', processing: 'ready' },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 20,
  },
  {
    // Submitted, waiting: workflow hasn't processed the upload yet.
    id: 'seed_v08',
    slug: 'test-video-pending',
    title: 'Test video: waiting in the queue',
    description: 'Dummy video story, submitted, media not processed yet.',
    body: dummyText(260, 5),
    bylineName: 'Grace (test)',
    submitter: 'seed_grace',
    format: 'video',
    tags: ['loneliness', 'hope'],
    media: { clip: 'clip-01' },
    status: 'pending',
  },
  {
    // A moderator has it open, and escalated it.
    id: 'seed_v09',
    slug: 'test-video-in-review',
    title: 'Test video: being reviewed',
    description: 'Dummy video story a moderator is reviewing (escalated once).',
    bylineName: 'Daniel (test)',
    submitter: 'seed_daniel',
    format: 'video',
    tags: ['doubt'],
    media: { clip: 'clip-03', processing: 'ready' },
    status: 'in_review',
    reviews: [{ decision: 'escalate' }],
  },
  {
    id: 'seed_v10',
    slug: 'test-video-changes-requested',
    title: 'Test video: sent back with feedback',
    description:
      'Dummy video story returned to its author with pastoral feedback.',
    body: dummyText(350, 6),
    bylineName: 'Joon (test)',
    submitter: 'seed_joon',
    format: 'video',
    tags: ['grief', 'loss'],
    media: { clip: 'clip-05', processing: 'ready' },
    status: 'changes_requested',
    reviews: [{ decision: 'request_changes', feedback: FEEDBACK_CHANGES }],
  },
  {
    // Submitted, then withdrawn by its author.
    id: 'seed_v11',
    slug: 'test-video-withdrawn',
    title: 'Test video: withdrawn by its author',
    description: 'Dummy video story its author withdrew after submitting.',
    bylineName: 'Ruth (test)',
    submitter: 'seed_ruth',
    format: 'video',
    tags: ['parenting'],
    media: { clip: 'clip-06', processing: 'ready' },
    status: 'withdrawn',
  },
  {
    // A draft saved before its upload (A1): no video yet.
    id: 'seed_v12',
    slug: 'test-video-draft-no-upload',
    title: 'Test video: draft, nothing uploaded yet',
    description: 'Dummy video draft created before its upload.',
    bylineName: 'Amara (test)',
    submitter: 'seed_amara',
    format: 'video',
    tags: [],
    status: 'draft',
  },

  // ------------------------------------------------------------- audio (3)
  {
    id: 'seed_a01',
    slug: 'test-audio-with-text',
    title: 'Test audio: a short recording with text',
    description: 'Dummy audio story with text.',
    body: dummyText(520, 7),
    bylineName: 'Tomasz (test)',
    submitter: 'seed_tomasz',
    format: 'audio',
    tags: ['depression', 'hope'],
    media: { clip: 'clip-08', processing: 'ready' },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 3,
  },
  {
    id: 'seed_a02',
    slug: 'test-audio-without-text',
    title: 'Test audio: a recording without text',
    description: 'Dummy audio story without text.',
    bylineName: 'Grace (test)',
    submitter: 'seed_grace',
    format: 'audio',
    tags: ['peace'],
    media: { clip: 'clip-09', processing: 'ready' },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 9,
  },
  {
    // The long one, with a long description (D47 edge case).
    id: 'seed_a03',
    slug: 'test-audio-long',
    title: 'Test audio: the long recording',
    description: LONG_DESCRIPTION,
    body: dummyText(900, 0),
    bylineName: 'Eleni (test)',
    submitter: 'seed_eleni',
    format: 'audio',
    tags: ['grief', 'faith', 'healing'],
    media: { clip: 'clip-10', processing: 'ready' },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 24,
  },

  // ------------------------------------------------------------- written (11)
  {
    id: 'seed_w01',
    slug: 'test-written-portrait-image',
    title: 'Test written story with a portrait picture',
    description: 'Dummy written story, medium length, with a 3:4 image.',
    body: dummyText(1800, 1),
    bylineName: 'Ruth (test)',
    submitter: 'seed_ruth',
    format: 'written',
    tags: ['faith', 'answered-prayers'],
    image: {
      file: 'image-01',
      alt: 'A test pattern with a label (dummy image)',
      processing: 'ready',
    },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 1,
  },
  {
    // Being reviewed: a short story with a landscape image and no alt text (neutral default).
    id: 'seed_w02',
    slug: 'test-written-landscape-image',
    title: 'Test written story with a landscape picture',
    description:
      'Dummy written story, short, with a 3:2 image and no alt text.',
    body: dummyText(230, 2),
    bylineName: 'Daniel (test)',
    submitter: 'seed_daniel',
    format: 'written',
    tags: ['relationships', 'forgiveness'],
    image: { file: 'image-02', processing: 'ready' },
    status: 'in_review',
  },
  {
    // The 140-character title.
    id: 'seed_w03',
    slug: 'test-written-longest-title',
    title: TITLE_140,
    description:
      'Dummy written story with a square image and the longest title allowed.',
    body: dummyText(700, 3),
    bylineName: 'Amara (test)',
    submitter: 'seed_amara',
    format: 'written',
    tags: ['salvation'],
    image: {
      file: 'image-03',
      alt: 'A square test pattern (dummy image)',
      processing: 'ready',
    },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 6,
  },
  {
    // A panorama beyond the 2:1 clamp (cropped on cards), and a non-Latin paragraph.
    id: 'seed_w04',
    slug: 'test-written-panorama',
    title: 'Test written story with a panorama',
    description:
      'Dummy written story with a 2.5:1 image, wider than cards show.',
    body:
      'Δοκιμαστικό κείμενο για την ιστοσελίδα ανάπτυξης. 개발 사이트를 위한 테스트 텍스트입니다.\n\n' +
      dummyText(900, 4),
    bylineName: 'Joon (test)',
    submitter: 'seed_joon',
    format: 'written',
    tags: ['joy', 'hope'],
    image: {
      file: 'image-04',
      alt: 'A wide test pattern (dummy image)',
      processing: 'ready',
    },
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 12,
  },
  {
    // Submitted; the image hasn't been checked yet.
    id: 'seed_w05',
    slug: 'test-written-pending-image',
    title: 'Test written story waiting in the queue',
    description: 'Dummy written story with a 4:5 image not processed yet.',
    body: dummyText(480, 5),
    bylineName: 'Eleni (test)',
    submitter: 'seed_eleni',
    format: 'written',
    tags: ['illness', 'healing'],
    image: { file: 'image-05', alt: 'A portrait test pattern (dummy image)' },
    status: 'pending',
  },
  {
    // The slug the walking skeleton used (0003), kept so old dev links still work. The newest
    // story, so home's first card.
    id: 'seed_w06',
    slug: 'test-story-walking-skeleton',
    title: 'Test story: the walking skeleton',
    description:
      'Placeholder content for the development site. This is not a real testimony.',
    body: dummyText(1100, 6),
    bylineName: 'Test Person',
    submitter: 'seed_tomasz',
    format: 'written',
    tags: ['faith'],
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 0,
  },
  {
    // At the 10,000-character maximum (A3).
    id: 'seed_w07',
    slug: 'test-written-maximum-length',
    title: 'Test written story at the maximum length',
    description: 'Dummy written story of exactly 10,000 characters.',
    body: dummyText(10_000, 7),
    bylineName: 'Grace (test)',
    submitter: 'seed_grace',
    format: 'written',
    tags: ['loss', 'grief', 'peace', 'faith'],
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 30,
  },
  {
    // At the 200-character minimum for a submitted written story.
    id: 'seed_w08',
    slug: 'test-written-minimum-length',
    title: 'Test written story at the minimum length',
    description: 'Dummy written story of exactly 200 characters.',
    body: dummyText(200, 0),
    bylineName: 'Daniel (test)',
    submitter: 'seed_daniel',
    format: 'written',
    tags: ['hope'],
    status: 'approved',
    reviews: [{ decision: 'approve' }],
    publishedDaysAgo: 35,
  },
  {
    id: 'seed_w09',
    slug: 'test-written-rejected',
    title: 'Test written story that was not published',
    description: 'Dummy written story rejected with pastoral feedback.',
    body: dummyText(600, 1),
    bylineName: 'Ruth (test)',
    submitter: 'seed_ruth',
    format: 'written',
    tags: ['doubt', 'loneliness'],
    status: 'rejected',
    reviews: [{ decision: 'reject', feedback: FEEDBACK_REJECT }],
  },
  {
    id: 'seed_w10',
    slug: 'test-written-changes-requested',
    title: 'Test written story sent back with feedback',
    description:
      'Dummy written story returned to its author with pastoral feedback.',
    body: dummyText(380, 2),
    bylineName: 'Amara (test)',
    submitter: 'seed_amara',
    format: 'written',
    tags: ['addiction'],
    status: 'changes_requested',
    reviews: [{ decision: 'request_changes', feedback: FEEDBACK_CHANGES }],
  },
  {
    // A draft shorter than 200 characters: allowed while it's being written.
    id: 'seed_w11',
    slug: 'test-written-short-draft',
    title: 'Test written draft, still short',
    description: 'Dummy written draft under the 200-character minimum.',
    body: dummyText(90, 3),
    bylineName: 'Joon (test)',
    submitter: 'seed_joon',
    format: 'written',
    tags: ['faith'],
    status: 'draft',
  },
];

/**
 * D112 (Joel, 2026-10-28): dev's Clerk test accounts, by Clerk user id (`user_…`, shown in the
 * Clerk dashboard; not secret), marked trusted submitters on every reset so the submission limits
 * don't interfere with testing. The dev behavioural suite's `behavioural+clerk_test@example.com`
 * belongs here once its id is known.
 */
const TEST_ACCOUNTS: string[] = [
  // upload-behaviour+clerk_test@example.com: behavioural/story-upload.developer.ts submits a
  // story on every run.
  'user_3LQqgJMojJ8H1rfyfb16nyBNK3J',
];

export const DATASET: Dataset = {
  people: PEOPLE,
  moderator: MODERATOR,
  tags: TAGS,
  stories: STORIES,
  testAccounts: TEST_ACCOUNTS,
};
