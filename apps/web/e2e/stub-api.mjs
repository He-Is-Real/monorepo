// A stand-in api-public-read for the e2e tests: the dev seed's story, a story with long
// unbroken words (overflow check), a long written story (the "Continue reading" preview),
// video, audio and image stories with stub media, 48 generated browse stories (every kind and
// shape, D53/D55), the list, related and tags endpoints (step 6a's contract, cursors bound to
// the filters), a 503 for "down" and 404 problems for anything else.
import { createServer } from 'node:http';

const port = Number(process.env.STUB_PORT ?? 4310);
const base = {
  bylineName: 'Test Person',
  primaryFormat: 'written',
  media: [],
  image: null,
  tags: [],
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
    tags: [
      { slug: 'doubt', name: 'Doubt', category: 'journey', version: 1 },
      { slug: 'healing', name: 'Healing', category: 'theme', version: 1 },
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
    mediaItem({
      format: 'audio',
      playbackUrl: playback('5f801563-6d21-40cf-b76e-48712e3eeda6'),
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

// The browse tags (apps/dev-seed's list) and 48 generated published stories, newest first:
// every kind (video, audio, written with and without an image) and shape, from 1:3 (beyond the
// card clamp) to 2.5:1, with short and long titles and excerpts.
const TAGS = [
  ['healing', 'Healing', 'theme'],
  ['addiction', 'Addiction', 'theme'],
  ['loss', 'Loss', 'theme'],
  ['depression', 'Depression', 'theme'],
  ['relationships', 'Relationships', 'theme'],
  ['loneliness', 'Loneliness', 'theme'],
  ['illness', 'Illness', 'theme'],
  ['parenting', 'Parenting', 'theme'],
  ['faith', 'Faith', 'journey'],
  ['answered-prayers', 'Answered Prayers', 'journey'],
  ['forgiveness', 'Forgiveness', 'journey'],
  ['salvation', 'Salvation', 'journey'],
  ['doubt', 'Doubt', 'journey'],
  ['hope', 'Hope', 'emotion'],
  ['peace', 'Peace', 'emotion'],
  ['grief', 'Grief', 'emotion'],
  ['joy', 'Joy', 'emotion'],
].map(([slug, name, category]) => ({ slug, name, category, version: 1 }));
const tag = (slug) => TAGS.find((t) => t.slug === slug);
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
  const tagSlugs = [
    TAGS[i % 8].slug,
    ...(i % 3 === 0 ? [TAGS[8 + (i % 5)].slug] : []),
    ...(i % 4 === 0 ? [TAGS[13 + (i % 4)].slug] : []),
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
    tags: tagSlugs.map(tag),
    publishedAt: day.toISOString().replace('.000', ''),
    media:
      kind.format === 'written'
        ? []
        : [
            mediaItem({
              format: kind.format,
              playbackUrl: playback(`00000000-0000-4000-8000-0000000000${n}`),
              thumbnailUrl:
                kind.format === 'video' ? sized(kind.w, kind.h) : null,
              width: kind.w ?? null,
              height: kind.h ?? null,
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

/** `StorySummary` (libs/contracts): a card, never a player link. */
function summaryOf(s) {
  const media = s.media?.[0];
  const video = media?.format === 'video';
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    excerpt: (s.description || s.body || '').slice(0, 240),
    bylineName: s.bylineName,
    primaryFormat: s.primaryFormat,
    durationSeconds: media?.durationSeconds ?? null,
    thumbnailUrl: video ? media.thumbnailUrl : null,
    thumbnailWidth: video ? media.width : null,
    thumbnailHeight: video ? media.height : null,
    image: s.image,
    textLength: (s.body ?? '').length,
    tags: s.tags.map(
      (t) => tag(t.slug) ?? { ...t, category: 'theme', version: 1 },
    ),
    publishedAt: s.publishedAt,
  };
}
const published = () =>
  Object.values(stories).sort(
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

/** GET /v1/stories: tag (all of), format, q, sort, limit, cursor (bound to the filters). */
function listStories(url, res) {
  const p = url.searchParams;
  const q = p.get('q')?.toLowerCase() ?? '';
  const tags = p.getAll('tag');
  const format = p.get('format');
  const sort = p.get('sort') ?? (q ? 'relevance' : 'latest');
  const limit = Number(p.get('limit') ?? 20);
  const key = JSON.stringify([q, [...tags].sort(), format, sort]);
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
  let list = published().filter(
    (s) =>
      tags.every((t) => s.tags.some((x) => x.slug === t)) &&
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

/** GET /v1/stories/{slug}/related: 3 cards sharing a tag, then the newest. */
function related(slug, res) {
  const story = stories[slug];
  if (!story) return problem(res, 404, 'story_not_found');
  const others = published().filter((s) => s.slug !== slug);
  const shared = others.filter((s) =>
    s.tags.some((t) => story.tags.some((x) => x.slug === t.slug)),
  );
  const picked = [
    ...shared,
    ...others.filter((s) => !shared.includes(s)),
  ].slice(0, 3);
  json(res, 200, { data: picked.map(summaryOf) });
}

const WIDE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="640" viewBox="0 0 1600 640">' +
  '<rect width="1600" height="640" fill="#336"/><text x="40" y="340" font-size="64" fill="#fff">DEV TEST 2.5:1</text></svg>';
// A stand-in for Bunny's player: its 44 px button proves nothing about the real one. The real
// player's control sizes are checked on dev (apps/dev-seed/behavioural/media.behaviour.ts).
const PLAYER_HTML =
  '<!doctype html><title>Stub player</title><body style="margin:0;background:#000;color:#fff;font:16px sans-serif">' +
  '<button style="min-width:44px;min-height:44px">Play</button></body>';

createServer((req, res) => {
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
  if (url.pathname === '/v1/stories') return listStories(url, res);
  if (url.pathname === '/v1/tags') return json(res, 200, { data: TAGS });
  const rel = /^\/v1\/stories\/([^/]+)\/related$/.exec(url.pathname);
  if (rel) return related(rel[1], res);
  if (req.url?.startsWith('/images/wide.svg')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    return res.end(WIDE_SVG);
  }
  const match = /^\/v1\/stories\/([^/?]+)$/.exec(req.url ?? '');
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      // D48 on, so every page's footer note is checked on every device.
      JSON.stringify({
        status: 'ok',
        service: 'api-public-read',
        db: 'up',
        consentChecksRelaxed: true,
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
  const story = match && stories[match[1]];
  if (story) {
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
}).listen(port, '127.0.0.1');
