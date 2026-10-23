// A stand-in api-public-read for the e2e tests: the dev seed's story, a story with long
// unbroken words (overflow check), a long written story (the "Continue reading" preview),
// video, audio and image stories with stub media, a 503 for "down" and 404 problems for
// anything else.
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

const WIDE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="640" viewBox="0 0 1600 640">' +
  '<rect width="1600" height="640" fill="#336"/><text x="40" y="340" font-size="64" fill="#fff">DEV TEST 2.5:1</text></svg>';
const PLAYER_HTML =
  '<!doctype html><title>Stub player</title><body style="margin:0;background:#000;color:#fff;font:16px sans-serif">' +
  '<button style="min-width:44px;min-height:44px">Play</button></body>';

createServer((req, res) => {
  if (req.url?.startsWith('/embed/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PLAYER_HTML);
  }
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
