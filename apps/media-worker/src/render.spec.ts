import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BunnyLibrary } from './bunny';
import { FfmpegRenderer, type RenderPass, type SoundLinks } from './render';

// A person uploads the picture, so only a real WebP reaches ffmpeg: anything else (a playlist
// naming other files, say) is refused before ffmpeg runs, and nothing stays on the machine.
describe('a picture video’s picture', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'render-spec-'));
  });
  afterEach(() => rm(workDir, { recursive: true, force: true }));

  const pass: RenderPass = {
    renderVideoId: '11111111-1111-4111-8111-111111111111',
    title: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    upload: {
      uploadUrl: 'https://video.bunnycdn.com/tusupload',
      headers: {},
      expiresAt: '2026-11-08T19:00:00.000Z',
    },
    picture: 'stories/s1/0123456789abcdef0123456789abcdef.webp',
    pictureUrl: 'https://images.example/stories/s1/x.webp?token=t',
  };

  const soundLinks: SoundLinks = async (height) =>
    `https://sound.example/v/play_${height}p.mp4?token=t`;

  function renderer(picture: string | Uint8Array<ArrayBuffer>) {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith('https://sound.example/')
        ? new Response('sound')
        : new Response(picture),
    );
    return new FfmpegRenderer({
      bunny: {
        video: async () => ({ status: 4, availableResolutions: '720p' }),
      } as unknown as BunnyLibrary,
      workDir,
      defaultPicture: '/nonexistent/default.jpg',
      // Never runs: a missing ffmpeg would answer 'ffmpeg_missing'.
      ffmpeg: '/nonexistent/ffmpeg',
      fetcher: fetcher as unknown as typeof fetch,
    });
  }

  it('refuses a file that isn’t a WebP before ffmpeg sees it', async () => {
    const result = await renderer(
      '#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n',
    ).render('22222222-2222-4222-8222-222222222222', pass, soundLinks);
    expect(result).toEqual({ failure: 'picture_not_webp' });
    expect(await readdir(workDir)).toEqual([]);
  });

  /** A WebP's first 30 bytes, an extended one (VP8X) with this canvas. */
  const webpHead = (width: number, height: number) => {
    const head = Buffer.alloc(30) as Buffer<ArrayBuffer>;
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(22, 4);
    head.write('WEBPVP8X', 8, 'latin1');
    head.writeUInt32LE(10, 16);
    head.writeUIntLE(width - 1, 24, 3);
    head.writeUIntLE(height - 1, 27, 3);
    return head;
  };

  it('refuses a WebP whose header is over the picture limits before ffmpeg decodes it', async () => {
    const result = await renderer(webpHead(16_000, 900)).render(
      '22222222-2222-4222-8222-222222222222',
      pass,
      soundLinks,
    );
    expect(result).toEqual({ failure: 'picture_too_big' });
    expect(await readdir(workDir)).toEqual([]);
  });

  it('hands a WebP within the limits to ffmpeg', async () => {
    const webp = webpHead(1024, 1280);
    const result = await renderer(webp).render(
      '22222222-2222-4222-8222-222222222222',
      pass,
      soundLinks,
    );
    expect(result).toEqual({ failure: 'ffmpeg_missing' });
  });
});
