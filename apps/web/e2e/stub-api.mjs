// A stand-in api-public-read for the e2e tests: the dev seed's story, a story with long
// unbroken words (overflow check), a 503 for "down" and 404 problems for anything else.
import { createServer } from 'node:http';

const port = Number(process.env.STUB_PORT ?? 4310);
const base = {
  bylineName: 'Test Person',
  primaryFormat: 'written',
  media: [],
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

createServer((req, res) => {
  const match = /^\/v1\/stories\/([^/?]+)$/.exec(req.url ?? '');
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({ status: 'ok', service: 'api-public-read', db: 'up' }),
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
