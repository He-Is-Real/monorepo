// A stand-in api-public-read for the e2e tests: the dev seed's story, a story with long
// unbroken words (overflow check), a long written story (the "Continue reading" preview),
// video, audio and image stories with stub media, 48 generated browse stories (every kind and
// shape, D53/D55), the list, related and themes endpoints (step 6a's contract, cursors bound to
// the filters), test-only stories for the hide, withdrawal, card playback and hearts tests, a 503 for
// "down" and 404 problems for anything else.
//
// One process, four ports, for the web servers in playwright.config.ts:
// - STUB_PORT: dev as it is today (D48's relaxed consent checks on);
// - STUB_LIVE_PORT: the same stories with D48 off, as at Go live (indexing.e2e.ts);
// - STUB_DOWN_PORT: api-public-read down, every request answers 503;
// - STUB_SLOW_PORT: dev, but each site video's answer waits until the test releases its key
//   (`POST /__test/release-site-video/{key}`; site-videos.e2e.ts: the page doesn't wait for it).
//
// The legal routes serve dev's placeholders, read from libs/legal as the database copies them
// (D75): the forms in force (`/v1/legal/forms/{form}`, v2: a short introduction and the boxes from
// the statements files, D114, D122), the privacy document (`/v1/legal/dpa`) and the two legal
// documents (`/v1/legal/documents/{privacy|terms}` and `…/versions/{number}`, D121, D125): the
// privacy policy has an earlier version too, so its "Previous versions" can be seen. On the Go live port none is published (404), as anywhere but dev.
//
// The founder's videos (`/v1/site-videos/founder-intro` and `/next-steps`) are set on the dev
// port and not on the Go live port (404), so About's and Next Steps' players and their
// placeholders are all seen.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const port = Number(process.env.STUB_PORT ?? 4310);
const livePort = Number(process.env.STUB_LIVE_PORT ?? 4311);
const downPort = Number(process.env.STUB_DOWN_PORT ?? 4312);
const slowPort = Number(process.env.STUB_SLOW_PORT ?? 4314);
const base = {
  bylineName: 'Test Person',
  primaryFormat: 'written',
  media: [],
  image: null,
  themes: [],
  publishedAt: '2026-10-21T20:00:00Z',
  version: 1,
};
const stories = {
  'test-story-walking-skeleton': {
    ...base,
    id: 'dev_seed',
    slug: 'test-story-walking-skeleton',
    title: 'Test story: the walking skeleton',
    description:
      'Placeholder content for the development site. This is not a real testimony.',
    body: 'This is test text, written to check that a published story travels from the database through api-public-read to the page. Nobody shared this story and nothing in it happened. Real stories arrive with the first submissions.',
  },
  'long-words': {
    ...base,
    id: 'long',
    slug: 'long-words',
    title:
      'Supercalifragilisticexpialidociouslyunbreakablelongtitleword and more',
    description:
      'A description with averyveryverylongunbrokenwordthatmustwrapnicelyonsmallphones.',
    body: 'Paragraph one.\n\nhttps://example.com/a/very/long/unbroken/url/that/must/not/push/the/page/sideways/on/a/small/phone',
    themes: [
      { id: 'doubt', name: 'Doubt' },
      { id: 'healing', name: 'Healing' },
    ],
  },
};

// About 2,000 characters in five paragraphs, so the preview (about 600) cuts inside the second.
const LONG_PARAGRAPHS = [
  'This is test text for a long written story. ' +
    'It goes on for a while, sentence after sentence. '.repeat(7),
  'The second paragraph is where the preview stops. ' +
    'Each sentence here is placeholder text and nothing more. '.repeat(6),
  'A third paragraph, hidden until the reader asks for it. ' +
    'Still more placeholder words. '.repeat(6),
  'A fourth paragraph with a long link: https://example.com/a/very/long/unbroken/url/that/must/not/push/the/page/sideways',
  'The last sentence of the long test story.',
].map((p) => p.trim());
stories['long-story'] = {
  ...base,
  id: 'long_story',
  slug: 'long-story',
  title: 'Test story: a long written story',
  description:
    'Placeholder text to check the preview and the Continue reading button.',
  body: LONG_PARAGRAPHS.join('\n\n'),
};

// Media (D52): signed-looking links to this stub, which plays the part of Bunny's player and
// the images CDN. Shapes: a tall phone video, a wide image beyond the card clamp, and audio.
const stub = `http://127.0.0.1:${port}`;
const playback = (id) => `${stub}/embed/1/${id}?token=stub&expires=4102444800`;
const mediaItem = (over) => ({
  format: 'video',
  thumbnailUrl: null,
  width: null,
  height: null,
  captionsUrl: null,
  durationSeconds: 12,
  ...over,
});
stories['video-story'] = {
  ...base,
  id: 'video_story',
  slug: 'video-story',
  primaryFormat: 'video',
  title: 'Test story: a tall video',
  description: 'Placeholder video story (9:16).',
  body: null,
  media: [
    mediaItem({
      playbackUrl: playback('b8a77258-abfd-469d-ba63-9b89b62fcce6'),
      width: 360,
      height: 640,
    }),
  ],
};
stories['audio-story'] = {
  ...base,
  id: 'audio_story',
  slug: 'audio-story',
  primaryFormat: 'audio',
  title: 'Test story: audio',
  description: 'Placeholder audio story.',
  body: null,
  media: [
    // The person's own picture as its thumbnail: its size is the story's (Joel, 2026-10-24).
    mediaItem({
      format: 'audio',
      playbackUrl: playback('5f801563-6d21-40cf-b76e-48712e3eeda6'),
      thumbnailUrl: `${stub}/media/1080x1350.svg?token=HS256-stub&expires=4102444800`,
      width: 1080,
      height: 1350,
    }),
  ],
};
stories['image-story'] = {
  ...base,
  id: 'image_story',
  slug: 'image-story',
  title: 'Test story: a wide image',
  description: 'Placeholder written story with a 2.5:1 image.',
  body: 'A short placeholder text under the image.',
  image: {
    url: `${stub}/images/wide.svg?token=HS256-stub&expires=4102444800`,
    width: 1600,
    height: 640,
    alt: 'A wide test pattern (dummy image)',
  },
};

// The themes (apps/dev-seed's catalogue, themes plan v3) and 48 generated published stories,
// newest first: every kind (video, audio, written with and without an image) and shape, from 1:3
// (beyond the card clamp) to 2.5:1, with short and long titles and excerpts. Topics' themes and
// Feelings' Hope are highlighted; Gratitude is highlighted with no story (A14: still listed).
// Ids are short words here (the real ones are ULIDs); `?theme=` takes either.
const CATEGORIES = [
  { id: 'topics', name: 'Topics' },
  { id: 'journeys', name: 'Journeys' },
  { id: 'feelings', name: 'Feelings' },
  { id: 'other', name: 'Other' },
];
const THEMES = [
  ['healing', 'Healing', 'topics', true],
  ['addiction', 'Addiction', 'topics', true],
  ['loss', 'Loss', 'topics', true],
  ['depression', 'Depression', 'topics', true],
  ['relationships', 'Relationships', 'topics', true],
  ['loneliness', 'Loneliness', 'topics', true],
  ['illness', 'Illness', 'topics', true],
  ['parenting', 'Parenting', 'topics', true],
  ['faith', 'Faith', 'journeys', false],
  ['answered_prayers', 'Answered prayers', 'journeys', false],
  ['forgiveness', 'Forgiveness', 'journeys', false],
  ['salvation', 'Salvation', 'journeys', false],
  ['doubt', 'Doubt', 'journeys', false],
  ['hope', 'Hope', 'feelings', true],
  ['peace', 'Peace', 'feelings', false],
  ['grief', 'Grief', 'feelings', false],
  ['joy', 'Joy', 'feelings', false],
  ['gratitude', 'Gratitude', 'feelings', true],
  ['waiting', 'Waiting', 'other', false],
].map(([id, name, category, highlighted]) => ({
  id,
  name,
  category,
  highlighted,
}));
const ref = (id) => {
  const { name } = THEMES.find((t) => t.id === id);
  return { id, name };
};
const KINDS = [
  { format: 'video', w: 360, h: 640 },
  { format: 'written' },
  { format: 'video', w: 1920, h: 1080 },
  { format: 'audio' },
  { format: 'written', image: [1200, 800] },
  { format: 'video', w: 1080, h: 1080 },
  { format: 'written' },
  { format: 'video', w: 1080, h: 1350 },
  { format: 'written', image: [1600, 640] },
  { format: 'video', w: 300, h: 900 },
  { format: 'audio' },
  { format: 'written', image: [900, 1200] },
];
const NAMES = [
  'Test Person',
  'Dummy Teller',
  null,
  'Sample Name',
  'Placeholder Friend',
];
const EXCERPTS = [
  'Dummy text for a browse card.',
  'Placeholder words that run a little longer, to give this card a second line of excerpt at most widths.',
  'This excerpt is long on purpose. It is placeholder text that fills most of the 240 characters a card excerpt may have, so the card is clamped to three lines and the masonry has to predict a tall text block correctly.',
];
const sized = (w, h) =>
  `${stub}/media/${w}x${h}.svg?token=HS256-stub&expires=4102444800`;
for (let i = 0; i < 48; i++) {
  const kind = KINDS[i % KINDS.length];
  const n = String(i + 1).padStart(2, '0');
  const themeIds = [
    THEMES[i % 8].id,
    ...(i % 3 === 0 ? [THEMES[8 + (i % 5)].id] : []),
    ...(i % 4 === 0 ? [THEMES[13 + ((i / 4) % 4)].id] : []),
  ];
  const day = new Date(Date.UTC(2026, 9, 20) - i * 86_400_000);
  const slug = `browse-test-${n}`;
  stories[slug] = {
    ...base,
    id: `browse_${n}`,
    slug,
    bylineName: NAMES[i % NAMES.length],
    primaryFormat: kind.format,
    title:
      i % 5 === 2
        ? `Browse test story ${n}: a much longer title that wraps over more than one line`
        : `Browse test story ${n}`,
    description: EXCERPTS[i % 3],
    body:
      kind.format === 'written'
        ? 'Placeholder text for a generated written story. '
            .repeat(10 + (i % 5) * 12)
            .trim()
        : i % 2
          ? 'Placeholder words under a generated clip.'
          : null,
    themes: themeIds.map(ref),
    publishedAt: day.toISOString().replace('.000', ''),
    media:
      kind.format === 'written'
        ? []
        : [
            mediaItem({
              format: kind.format,
              playbackUrl: playback(`00000000-0000-4000-8000-0000000000${n}`),
              // Audio: the site's default audio thumbnail, 1280 x 720.
              thumbnailUrl: sized(kind.w ?? 1280, kind.h ?? 720),
              width: kind.w ?? 1280,
              height: kind.h ?? 720,
              durationSeconds: 15 + i * 7,
            }),
          ],
    image: kind.image
      ? {
          url: sized(...kind.image),
          width: kind.image[0],
          height: kind.image[1],
          alt: `A dummy picture, ${kind.image[0]} by ${kind.image[1]}`,
        }
      : null,
  };
}

// Test hooks for "a hidden story disappears on the next server render": POST /__test/hide?slug=
// and /__test/show?slug= withdraw a story from that port's API (every route: the list, related
// lists and the story itself, which then answers 404) or bring it back. Each port keeps its own
// set, so the live server's withdrawal test (freshness.e2e.ts) never touches the dev server's.
// On dev (pages.e2e.ts): stories listed only under `theme=hide_test`, one per device project
// (projects run in parallel, so each hides its own). Nothing else lists them.
const HIDE_TEST = 'hide_test';
const hiddenOn = { dev: new Set(), live: new Set(), down: new Set() };
for (const name of ['phone-320', 'desktop-1280', 'spare']) {
  const slug = `hide-test-${name.replace('.', '-')}`;
  stories[slug] = {
    ...base,
    id: `hide_${name}`,
    slug,
    title: `Hide test story (${name})`,
    description: 'Dummy story for the hide test.',
    body: 'Placeholder text.',
    themes: [{ id: HIDE_TEST, name: 'Hide test' }],
    publishedAt: '2026-10-22T20:00:00Z',
  };
}

// Card playback (card-playback.e2e.ts): stories listed only under `theme=play_test`. Each card
// plays from its media area; "gone" answers 404 and "down" 503 when the player is asked for.
const PLAY_TEST = 'play_test';
const playTheme = { id: PLAY_TEST, name: 'Play test' };
const playStory = (slug, over) => {
  stories[slug] = {
    ...base,
    id: slug.replaceAll('-', '_'),
    slug,
    description: 'Placeholder story for the card playback tests.',
    body: null,
    themes: [playTheme],
    publishedAt: '2026-10-22T19:00:00Z',
    ...over,
  };
};
// Audio: the site's default audio thumbnail and its size, 1280 x 720.
const clip = (format, id, w = 1280, h = 720) => [
  mediaItem({
    format,
    playbackUrl: playback(id),
    thumbnailUrl: sized(w, h),
    width: w,
    height: h,
  }),
];
playStory('play-test-video', {
  primaryFormat: 'video',
  title: 'Play test: a wide video',
  media: clip('video', '11111111-1111-4111-8111-111111111111', 1920, 1080),
});
playStory('play-test-audio', {
  primaryFormat: 'audio',
  title: 'Play test: audio',
  media: clip('audio', '22222222-2222-4222-8222-222222222222'),
});
playStory('play-test-written', {
  title: 'Play test: written',
  body: 'Placeholder text for a written story in the playback tests.',
});
playStory('play-test-gone', {
  primaryFormat: 'video',
  title: 'Play test: a story that has gone',
  media: clip('video', '33333333-3333-4333-8333-333333333333', 1080, 1080),
});
playStory('play-test-down', {
  primaryFormat: 'video',
  title: 'Play test: the API is down',
  media: clip('video', '44444444-4444-4444-8444-444444444444', 1080, 1350),
});
// Prefetch check (card-playback.e2e.ts): each run makes its own video story (POST /__test/story,
// `prefetch-test-…`), listed only under `theme=prefetch_test`, so no two tests (or repeats) ever
// share its read count. GET /__test/reads?slug= says how often its story was read.
const PREFETCH_TEST = 'prefetch_test';
const prefetchStory = (slug) => {
  // A UUID-shaped media id of the story's own (the player's links name it).
  const h = createHash('sha256').update(slug).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  playStory(slug, {
    primaryFormat: 'video',
    title: `Prefetch test ${slug}`,
    themes: [{ id: PREFETCH_TEST, name: 'Prefetch test' }],
    media: clip('video', id, 1920, 1080),
  });
};
// The NEW badge (new-badge.e2e.ts, D72): stories listed only under `theme=new_test`, dated around
// the e2e servers' pinned clock (E2E_NOW in servers.ts, 2026-10-25T12:00:00Z). New means less
// than 7 days old, so exactly 7 days isn't, and one second less is.
const NEW_TEST = 'new_test';
for (const [slug, title, format, publishedAt] of [
  ['new-test-2-days', 'New test: 2 days old', 'video', '2026-10-23T12:00:00Z'],
  [
    'new-test-under-7-days',
    'New test: 1 second under 7 days old',
    'written',
    '2026-10-18T12:00:01Z',
  ],
  [
    'new-test-7-days',
    'New test: exactly 7 days old',
    'audio',
    '2026-10-18T12:00:00Z',
  ],
  [
    'new-test-8-days',
    'New test: 8 days old',
    'written',
    '2026-10-17T12:00:00Z',
  ],
]) {
  playStory(slug, {
    primaryFormat: format,
    title,
    description: 'Placeholder story for the NEW badge tests.',
    themes: [{ id: NEW_TEST, name: 'New test' }],
    publishedAt,
    ...(format === 'written'
      ? { body: 'Placeholder text for the NEW badge tests.' }
      : {
          media: clip(
            format,
            `66666666-6666-4666-8666-${slug === 'new-test-2-days' ? '000000000002' : '000000000007'}`,
          ),
        }),
  });
}
const reads = new Map();

/** Listed (as cards) but not readable: the story was hidden, or the API is failing. */
const UNREADABLE = { 'play-test-gone': 404, 'play-test-down': 503 };

// Hearts (favourites.e2e.ts): a story per behaviour device to heart, listed only under
// `theme=heart_test`. A test that hides a story makes its own first (POST /__test/story), listed
// nowhere, so no two tests (or repeats) ever share one.
const HEART_TEST = 'heart_test';
const HEART_TMP = 'heart_tmp';
for (const name of ['phone-320', 'desktop-1280']) {
  const slug = `heart-test-${name}`;
  stories[slug] = {
    ...base,
    id: slug.replaceAll('-', '_'),
    slug,
    title: `Heart test story (${name})`,
    description: 'Dummy story for the hearts test.',
    body: 'Placeholder text.',
    themes: [{ id: HEART_TEST, name: 'Heart test' }],
    publishedAt: '2026-10-22T20:00:00Z',
  };
}

// Related previews' shapes (card-playback.e2e.ts): `aspect-test`'s related stories are a 3:4 written
// picture, a 9:16 video and a 16:9 video, each at its own shape. Test-themed stories' related
// lists hold only stories with the same test theme.
const ASPECT_TEST = 'aspect-test';
const aspectTheme = { id: 'aspect_test', name: 'Aspect test' };
const aspectStory = (slug, over) => {
  stories[slug] = {
    ...base,
    id: slug.replaceAll('-', '_'),
    slug,
    description: 'Placeholder story for the related previews test.',
    body: null,
    themes: [aspectTheme],
    ...over,
  };
};
aspectStory(ASPECT_TEST, {
  title: 'Aspect test: the story',
  body: 'Placeholder text above the related stories.',
  publishedAt: '2026-10-22T18:00:00Z',
});
aspectStory('aspect-test-portrait', {
  title: 'Aspect test: a 3:4 picture',
  body: 'Placeholder text for a written story with a portrait picture.',
  image: {
    url: sized(900, 1200),
    width: 900,
    height: 1200,
    alt: 'A dummy picture, 900 by 1200',
  },
  publishedAt: '2026-10-22T17:00:00Z',
});
aspectStory('aspect-test-vertical', {
  primaryFormat: 'video',
  title: 'Aspect test: a 9:16 video',
  media: clip('video', '55555555-5555-4555-8555-555555555555', 360, 640),
  publishedAt: '2026-10-22T16:00:00Z',
});
aspectStory('aspect-test-landscape', {
  primaryFormat: 'video',
  title: 'Aspect test: a 16:9 video',
  media: clip('video', '66666666-6666-4666-8666-666666666666', 1920, 1080),
  publishedAt: '2026-10-22T15:00:00Z',
});

const TEST_THEMES = [
  aspectTheme.id,
  HIDE_TEST,
  PLAY_TEST,
  PREFETCH_TEST,
  HEART_TEST,
  HEART_TMP,
  NEW_TEST,
];
const testThemeOf = (s) =>
  s.themes.find((t) => TEST_THEMES.includes(t.id))?.id ?? null;

// A story whose related list can't load (503): its page still shows (pages.e2e.ts). Listed
// nowhere, so the browse counts stay as they are.
const RELATED_DOWN = 'related-down';
stories[RELATED_DOWN] = {
  ...base,
  id: 'related_down',
  slug: RELATED_DOWN,
  title: 'Test story: related stories can’t load',
  description: 'Dummy story whose related list fails.',
  body: 'Placeholder text.',
};
const unlisted = (s) => testThemeOf(s) !== null || s.slug === RELATED_DOWN;

// The live server's withdrawal test (freshness.e2e.ts): the newest story, so it's on home, in
// the sitemap and in other stories' related lists. Only the live port has it, so the dev
// server's counts and newest stories stay as they are.
const WITHDRAWN = 'withdrawal-test';
stories[WITHDRAWN] = {
  ...base,
  id: 'withdrawal_test',
  slug: WITHDRAWN,
  title: 'Withdrawal test story',
  description: 'Dummy story that its teller withdraws during the test.',
  body: 'Withdrawal test testimony text: this sentence must vanish once the story is withdrawn.',
  publishedAt: '2026-10-23T20:00:00Z',
};

// D30: an old slug answers 301 to the story's current one, as api-public-read does.
const ALIASES = { 'old-video-story': 'video-story' };

/** `StorySummary` (libs/contracts): a card, never a player link. */
function summaryOf(s) {
  const media = s.media?.[0];
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    excerpt: (s.description || s.body || '').slice(0, 240),
    bylineName: s.bylineName,
    primaryFormat: s.primaryFormat,
    durationSeconds: media?.durationSeconds ?? null,
    thumbnailUrl: media?.thumbnailUrl ?? null,
    thumbnailWidth: media?.width ?? null,
    thumbnailHeight: media?.height ?? null,
    image: s.image,
    textLength: (s.body ?? '').length,
    themes: s.themes.map(({ id, name }) => ({ id, name })),
    publishedAt: s.publishedAt,
  };
}
const published = (mode) =>
  Object.values(stories)
    .filter((s) => onPort(mode, s))
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id),
    );

function json(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(JSON.stringify(body));
}
const problem = (res, status, code) =>
  json(
    res,
    status,
    { type: 'about:blank', title: code, status, code },
    'application/problem+json',
  );

// D75: dev's placeholder versions, the words as published (libs/legal), like the database's copies.
const LEGAL = resolve(import.meta.dirname, '../../../libs/legal');
const words = (file) => readFileSync(`${LEGAL}/${file}`, 'utf8');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const DPA_TEXT = words('dpa/dev_placeholder.md');
const DPA = {
  id: 'dev_placeholder',
  kind: 'standard',
  status: 'published',
  materiality: 'material',
  contentHash: sha256(DPA_TEXT),
  changeSummary: null,
  supersedes: null,
  effectiveFrom: null,
  version: 1,
};
const form = (name, statements, features) => {
  const text = words(`forms/${name}/v2.md`);
  // D114: the boxes, from the version's statements file, never from its words.
  const statementsFile = words(`forms/${name}/v2.statements.json`);
  return {
    form: name,
    id: 'v2',
    status: 'published',
    publishedAt: '2026-10-30T12:00:00.000Z',
    dpaVersion: 'dev_policy',
    textHash: sha256(text),
    text,
    statements,
    boxes: JSON.parse(statementsFile).statements.map((b) => ({
      statement: b.key,
      label: b.label,
      step: b.step ?? null,
    })),
    statementsHash: sha256(statementsFile),
    version: 1,
    ...(features ? { features } : {}),
  };
};
// D121, D125: the two legal documents, each a list of numbered versions, newest first, the first
// in force, as data 0007 seeds them in dev.
const DOCUMENTS = {
  privacy: [
    {
      id: 'dev_policy',
      number: 2,
      publishedAt: '2026-10-30T12:00:00.000Z',
      text: words('dpa/dev_policy.md'),
    },
    {
      id: 'dev_placeholder',
      number: 1,
      publishedAt: '2026-10-25T12:00:00.000Z',
      text: DPA_TEXT,
    },
  ],
  terms: [
    {
      id: 'dev_placeholder',
      number: 1,
      publishedAt: '2026-10-30T12:00:00.000Z',
      text: words('terms/dev_placeholder.md'),
    },
  ],
};
const versionOf = (v) => ({
  id: v.id,
  number: v.number,
  publishedAt: v.publishedAt,
  contentHash: sha256(v.text),
});
const FORMS = {
  signup: form('signup', ['age_18plus', 'account_data', 'terms_of_use']),
  testimony: form('testimony', ['special_category_religious', 'publish'], {
    requiresAcceptanceForNewSubmissions: false,
    coversPublicPublishing: true,
    draftRetentionMonths: 6,
  }),
  social: form('social', ['share_socials'], {
    shareYouTube: false,
    shareInstagram: false,
    shareTikTok: false,
    shareFacebook: false,
    allowEditingAndClipping: false,
    allowChurchAndPartnerMedia: false,
    allowPrintAndEvents: false,
    allowPaidPromotion: false,
  }),
};

/**
 * `GET /v1/legal/forms/{form}`, `GET /v1/legal/dpa` and the legal documents and their versions:
 * dev's versions, none when live.
 */
function legal(mode, url, res) {
  const notPublished = () => problem(res, 404, 'not_found');
  const [, document, rest] =
    /^\/v1\/legal\/documents\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];
  if (document) {
    const versions = DOCUMENTS[document];
    if (!versions || mode === 'live') return notPublished();
    if (!rest) {
      return json(res, 200, {
        document,
        current: { ...versionOf(versions[0]), text: versions[0].text },
        versions: versions.map(versionOf),
      });
    }
    const number = Number(/^\/versions\/([1-9][0-9]{0,8})$/.exec(rest)?.[1]);
    const v = versions.find((x) => x.number === number);
    if (!v) return notPublished();
    return json(res, 200, {
      document,
      ...versionOf(v),
      text: v.text,
      current: v === versions[0],
    });
  }
  if (url.pathname === '/v1/legal/dpa') {
    const version = url.searchParams.get('version');
    if (mode === 'live' || (version !== null && version !== DPA.id))
      return notPublished();
    return json(res, 200, {
      current: { ...DPA, text: DPA_TEXT },
      history: [DPA],
    });
  }
  const name = /^\/v1\/legal\/forms\/([^/]+)$/.exec(url.pathname)?.[1];
  if (!name || !(name in FORMS)) return problem(res, 404, 'not_found');
  if (mode === 'live') return notPublished();
  return json(res, 200, FORMS[name]);
}

/** Whether the API on this port has the story at all (withdrawn ones answer 404). */
const onPort = (mode, s) =>
  (s.slug !== WITHDRAWN || mode === 'live') && !hiddenOn[mode].has(s.slug);

/** GET /v1/stories: theme, format, q, sort, limit, cursor (bound to the filters). */
function listStories(mode, url, res) {
  const p = url.searchParams;
  // Cards by id (hearts kept on a device, M2): the public stories among them, newest first,
  // listed or not; on their own, 1 to 50.
  const ids = p.getAll('id');
  if (ids.length) {
    if (
      ids.length > 50 ||
      !ids.every((id) => /^[A-Za-z0-9_]{1,64}$/.test(id)) ||
      [...p.keys()].some((k) => k !== 'id')
    )
      return problem(res, 400, 'validation_failed');
    const asked = new Set(ids);
    return json(res, 200, {
      data: published(mode)
        .filter((s) => asked.has(s.id))
        .map(summaryOf),
      nextCursor: null,
    });
  }
  const q = p.get('q')?.toLowerCase() ?? '';
  // An id that isn't a theme shows every story (A8).
  const asked = p.get('theme');
  const theme =
    THEMES.some((t) => t.id === asked) || TEST_THEMES.includes(asked)
      ? asked
      : null;
  const format = p.get('format');
  const sort = p.get('sort') ?? (q ? 'relevance' : 'latest');
  const limit = Number(p.get('limit') ?? 20);
  const key = JSON.stringify([q, asked, format, sort]);
  let offset = 0;
  if (p.get('cursor')) {
    try {
      const c = JSON.parse(
        Buffer.from(p.get('cursor'), 'base64url').toString(),
      );
      if (c.k !== key) return problem(res, 400, 'invalid_cursor');
      offset = c.o;
    } catch {
      return problem(res, 400, 'invalid_cursor');
    }
  }
  let list = published(mode).filter(
    (s) =>
      s.slug !== RELATED_DOWN &&
      (testThemeOf(s) === null || testThemeOf(s) === theme) &&
      (!theme || s.themes.some((x) => x.id === theme)) &&
      (!format || s.primaryFormat === format) &&
      (!q ||
        `${s.title} ${s.description} ${s.body ?? ''}`
          .toLowerCase()
          .includes(q)),
  );
  if (sort === 'oldest') list = list.reverse();
  const data = list.slice(offset, offset + limit).map(summaryOf);
  const next = offset + limit < list.length;
  json(res, 200, {
    data,
    nextCursor: next
      ? Buffer.from(JSON.stringify({ k: key, o: offset + limit })).toString(
          'base64url',
        )
      : null,
  });
}

/** GET /v1/stories/{slug}/related: 3 cards, the most shared themes first, then the newest. */
function related(mode, slug, res) {
  const story = stories[slug];
  if (!story || !onPort(mode, story))
    return problem(res, 404, 'story_not_found');
  if (slug === RELATED_DOWN) return problem(res, 503, 'unavailable');
  const own = testThemeOf(story);
  const others = published(mode).filter(
    (s) => s.slug !== slug && (own ? testThemeOf(s) === own : !unlisted(s)),
  );
  const sharedWith = (s) =>
    s.themes.filter((t) => story.themes.some((x) => x.id === t.id)).length;
  // Stable: equal counts stay newest first.
  const picked = [...others]
    .sort((a, b) => sharedWith(b) - sharedWith(a))
    .slice(0, 3);
  json(res, 200, { data: picked.map(summaryOf) });
}

/**
 * GET /v1/themes: by category, A–Z with Other last; highlighted themes always, the others once
 * a story listed on this port uses them (themes plan v3).
 */
function listThemes(mode, res) {
  const used = new Set(
    published(mode)
      .filter((s) => !unlisted(s))
      .flatMap((s) => s.themes.map((t) => t.id)),
  );
  const byName = (a, b) => a.name.localeCompare(b.name);
  const data = [...CATEGORIES]
    .sort(
      (a, b) =>
        Number(a.id === 'other') - Number(b.id === 'other') || byName(a, b),
    )
    .map((c) => ({
      ...c,
      themes: THEMES.filter(
        (t) => t.category === c.id && (t.highlighted || used.has(t.id)),
      )
        .sort(byName)
        .map(({ id, name, highlighted }) => ({ id, name, highlighted })),
    }))
    .filter((c) => c.themes.length > 0);
  json(res, 200, { data });
}

const WIDE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="640" viewBox="0 0 1600 640">' +
  '<rect width="1600" height="640" fill="#336"/><text x="40" y="340" font-size="64" fill="#fff">DEV TEST 2.5:1</text></svg>';
// A stand-in for Bunny's player: its 44 px button proves nothing about the real one. The real
// player's control sizes are checked on dev (apps/dev-seed/behavioural/media.behaviour.ts).
const PLAYER_HTML =
  '<!doctype html><title>Stub player</title><body style="margin:0;background:#000;color:#fff;font:16px sans-serif">' +
  '<button style="min-width:44px;min-height:44px">Play</button></body>';

/** Site video key → stand-in GUID (site-videos.e2e.ts checks each page plays its own). */
const SITE_VIDEOS = {
  'founder-intro': '0b6f1c3e-2d4a-4c5b-8e9f-1a2b3c4d5e6f',
  'next-steps': '7c2e9a14-5b3d-4f6e-a8c1-2d3e4f5a6b7c',
};

/** `GET /v1/site-videos/{key}`: the founder's videos in dev; none set on the Go live port. */
function siteVideo(mode, key, res) {
  if (mode !== 'dev' || !Object.hasOwn(SITE_VIDEOS, key))
    return problem(res, 404, 'not_found');
  json(res, 200, {
    key,
    playbackUrl: playback(SITE_VIDEOS[key]),
    expiresAt: '2100-01-01T00:00:00.000Z',
  });
}

const handler = (mode) => (req, res) => {
  if (mode === 'down') return problem(res, 503, 'unavailable');
  if (req.url?.startsWith('/embed/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PLAYER_HTML);
  }
  const sizedMedia = /^\/media\/(\d+)x(\d+)\.svg/.exec(req.url ?? '');
  if (sizedMedia) {
    const [, w, h] = sizedMedia;
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<rect width="${w}" height="${h}" fill="#2a3d3f"/><text x="20" y="${Math.round(h / 2)}" font-size="${Math.round(w / 10)}" fill="#cfe">DEV ${w}×${h}</text></svg>`,
    );
  }
  const url = new URL(req.url ?? '/', 'http://stub');
  const hook = /^\/__test\/(hide|show)$/.exec(url.pathname);
  // A test's own story: `heart-tmp-…` (favourites.e2e.ts), listed nowhere, or `prefetch-test-…`
  // (card-playback.e2e.ts), listed under its theme; public on every port.
  if (url.pathname === '/__test/story' && req.method === 'POST') {
    const slug = url.searchParams.get('slug') ?? '';
    if (/^prefetch-test-[a-z0-9-]{1,50}$/.test(slug)) {
      prefetchStory(slug);
      res.writeHead(204);
      return res.end();
    }
    if (!/^heart-tmp-[a-z0-9-]{1,50}$/.test(slug))
      return problem(res, 400, 'validation_failed');
    stories[slug] = {
      ...base,
      id: slug.replaceAll('-', '_'),
      slug,
      title: `Heart temp story ${slug}`,
      description: 'Dummy story a hearts test made for itself.',
      body: 'Placeholder text.',
      themes: [{ id: HEART_TMP, name: 'Heart temp' }],
      publishedAt: '2026-10-22T21:00:00Z',
    };
    res.writeHead(204);
    return res.end();
  }
  if (hook && req.method === 'POST') {
    const slug = url.searchParams.get('slug') ?? '';
    if (hook[1] === 'hide') hiddenOn[mode].add(slug);
    else hiddenOn[mode].delete(slug);
    res.writeHead(204);
    return res.end();
  }
  // For the stub api-user (stub-api-user.mjs), as api-user reads publicStory: every story this
  // port has public now, listed or not, as cards.
  if (url.pathname === '/__test/cards')
    return json(res, 200, {
      data: Object.values(stories)
        .filter((s) => onPort(mode, s))
        .map(summaryOf),
    });
  if (url.pathname === '/__test/reads')
    return json(res, 200, {
      reads: reads.get(url.searchParams.get('slug')) ?? 0,
    });
  if (url.pathname.startsWith('/v1/legal/')) return legal(mode, url, res);
  const site = /^\/v1\/site-videos\/([^/]+)$/.exec(url.pathname);
  if (site) return siteVideo(mode, site[1], res);
  if (url.pathname === '/v1/stories') return listStories(mode, url, res);
  if (url.pathname === '/v1/themes') return listThemes(mode, res);
  const rel = /^\/v1\/stories\/([^/]+)\/related$/.exec(url.pathname);
  if (rel) return related(mode, rel[1], res);
  if (req.url?.startsWith('/images/wide.svg')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(WIDE_SVG);
  }
  const match = /^\/v1\/stories\/([^/?]+)$/.exec(req.url ?? '');
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      // D48 on in dev, so every page's footer note is checked on every device; off when live.
      JSON.stringify({
        status: 'ok',
        service: 'api-public-read',
        db: 'up',
        consentChecksRelaxed: mode !== 'live',
      }),
    );
  }
  if (match?.[1] === 'down') {
    res.writeHead(503, { 'content-type': 'application/problem+json' });
    return res.end(
      JSON.stringify({
        type: 'about:blank',
        title: 'Unavailable',
        status: 503,
      }),
    );
  }
  const alias = match && ALIASES[match[1]];
  if (alias) {
    res.writeHead(301, { location: `/v1/stories/${alias}` });
    return res.end();
  }
  if (match) reads.set(match[1], (reads.get(match[1]) ?? 0) + 1);
  const unreadable = match && UNREADABLE[match[1]];
  if (unreadable === 503) {
    res.writeHead(503, { 'content-type': 'application/problem+json' });
    return res.end(
      JSON.stringify({
        type: 'about:blank',
        title: 'Unavailable',
        status: 503,
      }),
    );
  }
  const story = !unreadable && match && stories[match[1]];
  if (story && onPort(mode, story)) {
    res.writeHead(200, { 'content-type': 'application/json', etag: '"1"' });
    return res.end(JSON.stringify(story));
  }
  res.writeHead(404, { 'content-type': 'application/problem+json' });
  res.end(
    JSON.stringify({
      type: 'about:blank',
      title: 'Story not found',
      status: 404,
      code: 'story_not_found',
    }),
  );
};

createServer(handler('dev')).listen(port, '127.0.0.1');
createServer(handler('live')).listen(livePort, '127.0.0.1');
createServer(handler('down')).listen(downPort, '127.0.0.1');
// The slow port: site-video requests held per key until released; a release with nothing held
// lets the key's next request through (the order of the two doesn't matter).
const dev = handler('dev');
const held = new Map();
const released = new Set();
createServer((req, res) => {
  const release = /^\/__test\/release-site-video\/([^/]+)$/.exec(req.url ?? '');
  if (release && req.method === 'POST') {
    const waiting = held.get(release[1]) ?? [];
    held.delete(release[1]);
    if (waiting.length === 0) released.add(release[1]);
    for (const go of waiting) go();
    res.writeHead(204);
    return res.end();
  }
  const site = /^\/v1\/site-videos\/([^/?]+)/.exec(req.url ?? '');
  if (!site) return dev(req, res);
  const key = site[1];
  if (released.delete(key)) return dev(req, res);
  held.set(key, [...(held.get(key) ?? []), () => dev(req, res)]);
}).listen(slowPort, '127.0.0.1');
