import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BunnyStreamApi } from './bunny-stream';

// The library key (AccessKey) goes to Bunny's API only (Codex #133 round 1): if an answer
// redirects, the call fails rather than sending the key on to wherever it points. Real fetch,
// against a local server standing in for video.bunnycdn.com that redirects every call.
describe('Bunny Stream calls never follow a redirect with the library key', () => {
  const ID = '0f0e0d0c-0b0a-4908-8706-000000000001';
  let server: Server;
  let origin: string;
  const reachedElsewhere: (string | undefined)[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/elsewhere')) {
        reachedElsewhere.push(req.headers['accesskey'] as string | undefined);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ guid: ID, status: 4, length: 30 }));
        return;
      }
      res.writeHead(307, { location: '/elsewhere' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const api = new BunnyStreamApi('42', 'library-key', (url, init) =>
    fetch(String(url).replace('https://video.bunnycdn.com', origin), init),
  );

  it.each([
    ['create', () => api.createVideo('story-id')],
    ['read', () => api.video(ID)],
    ['delete', () => api.deleteVideo(ID)],
  ])('%s', async (_, call) => {
    await expect(call()).rejects.toThrow();
    expect(reachedElsewhere).toEqual([]);
  });
});
