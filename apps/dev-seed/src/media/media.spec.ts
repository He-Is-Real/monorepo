import { CLIPS, IMAGES } from '../app/media';
import {
  Bunny,
  clipTitle,
  recordClip,
  serialise,
  type StreamVideo,
} from './bunny';
import { exifBlock, readGps, withExif } from './exif';
import { clipArgs, imageArgs } from './ffmpeg';

/** A minimal simple-format (lossy) WebP: RIFF, WEBP and one VP8 chunk of opaque bytes. */
function simpleWebp(payload = Buffer.from([1, 2, 3])): Buffer {
  const chunk = Buffer.alloc(8);
  chunk.write('VP8 ', 0, 'latin1');
  chunk.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([
    Buffer.from('WEBP'),
    chunk,
    payload,
    Buffer.alloc(payload.length % 2),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe('EXIF GPS in WebP', () => {
  it.each([
    [51.4769, -0.0005],
    [-33.8568, 151.2153],
  ])('round-trips %f, %f', (latitude, longitude) => {
    const tagged = withExif(
      simpleWebp(),
      exifBlock('DEV TEST', { latitude, longitude }),
      1200,
      1600,
    );
    const gps = readGps(tagged);
    expect(gps?.latitude).toBeCloseTo(latitude, 5);
    expect(gps?.longitude).toBeCloseTo(longitude, 5);
  });

  it('writes a valid extended WebP: VP8X first, EXIF flag and canvas size, RIFF size', () => {
    const tagged = withExif(
      simpleWebp(),
      exifBlock('x', { latitude: 1, longitude: 1 }),
      1200,
      1600,
    );
    expect(tagged.toString('latin1', 12, 16)).toBe('VP8X');
    expect(tagged[20] & 0x08).toBe(0x08);
    expect(tagged.readUIntLE(24, 3) + 1).toBe(1200);
    expect(tagged.readUIntLE(27, 3) + 1).toBe(1600);
    expect(tagged.readUInt32LE(4)).toBe(tagged.length - 8);
    expect(tagged.toString('latin1', 30, 34)).toBe('VP8 ');
  });

  it('replaces an existing EXIF chunk instead of adding a second', () => {
    const once = withExif(
      simpleWebp(),
      exifBlock('a', { latitude: 1, longitude: 2 }),
      10,
      10,
    );
    const twice = withExif(
      once,
      exifBlock('b', { latitude: 3, longitude: 4 }),
      10,
      10,
    );
    expect(twice.toString('latin1').split('EXIF').length - 1).toBe(1);
    expect(readGps(twice)?.latitude).toBeCloseTo(3, 5);
  });

  it('finds no position in a file without EXIF', () => {
    expect(readGps(simpleWebp())).toBeNull();
  });
});

describe('ffmpeg arguments', () => {
  it('makes a labelled test pattern with a tone at the clip’s size and length', () => {
    const args = clipArgs(
      CLIPS['clip-02'],
      '/tmp/label.txt',
      '/out/clip-02.mp4',
    );
    expect(args).toContain('testsrc2=size=360x780:rate=12:duration=10');
    expect(args).toContain('sine=frequency=494:duration=10:sample_rate=44100');
    expect(args.find((a) => a.startsWith('drawtext='))).toContain(
      'textfile=/tmp/label.txt',
    );
    expect(args[args.length - 1]).toBe('/out/clip-02.mp4');
  });

  it('makes audio as a tone only', () => {
    const args = clipArgs(CLIPS['clip-10'], '/tmp/l.txt', '/out/clip-10.mp3');
    expect(args.join(' ')).not.toContain('testsrc2');
    expect(args).toContain('libmp3lame');
  });

  it('makes a still WebP at the image’s size', () => {
    const args = imageArgs(
      IMAGES['image-04'],
      '/tmp/l.txt',
      '/out/image-04.webp',
      60,
    );
    expect(args).toContain('testsrc2=size=1600x640:rate=1:duration=1');
    expect(args).toEqual(
      expect.arrayContaining(['-c:v', 'libwebp', '-quality', '60']),
    );
  });
});

describe('Bunny uploads', () => {
  const target = {
    libraryId: '123',
    libraryKey: 'library-key-not-real',
    storageZone: 'heisreal-dev-images',
    storagePassword: 'storage-password-not-real',
    storageHost: 'uk.storage.bunnycdn.com',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const video = (fields: Partial<StreamVideo>): StreamVideo => ({
    guid: 'g1',
    title: 'dev-seed/clip-01',
    status: 4,
    width: 360,
    height: 640,
    length: 12,
    thumbnailFileName: 'thumbnail.jpg',
    ...fields,
  });

  it('finds a clip by its exact title, with the library key in the header only', async () => {
    const http = jest.fn(async () =>
      json({
        items: [video({}), video({ guid: 'g2', title: 'dev-seed/clip-010' })],
      }),
    );
    const found = await new Bunny(
      target,
      http as unknown as typeof fetch,
    ).findVideo(clipTitle('clip-01'));
    expect(found.map((v) => v.guid)).toEqual(['g1']);
    const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://video.bunnycdn.com/library/123/videos?search=dev-seed%2Fclip-01&itemsPerPage=100',
    );
    expect(url).not.toContain('key');
    expect((init.headers as Record<string, string>)['AccessKey']).toBe(
      'library-key-not-real',
    );
  });

  it('creates, then uploads the bytes', async () => {
    const http = jest.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? json({ guid: 'new' }) : json({ success: true }),
    );
    const guid = await new Bunny(
      target,
      http as unknown as typeof fetch,
    ).uploadVideo('t', new Uint8Array([1]));
    expect(guid).toBe('new');
    expect(http.mock.calls.map(([url, init]) => [init?.method, url])).toEqual([
      ['POST', 'https://video.bunnycdn.com/library/123/videos'],
      ['PUT', 'https://video.bunnycdn.com/library/123/videos/new'],
    ]);
  });

  it('waits for the encode, and stops on an error status', async () => {
    const states = [video({ status: 3 }), video({ status: 4 })];
    const http = jest.fn(async () => json(states.shift()));
    const bunny = new Bunny(
      target,
      http as unknown as typeof fetch,
      async () => undefined,
    );
    await expect(bunny.waitForVideo('g1')).resolves.toMatchObject({
      status: 4,
    });
    const failing = new Bunny(target, (async () =>
      json(video({ status: 5 }))) as unknown as typeof fetch);
    await expect(failing.waitForVideo('g1')).rejects.toThrow("couldn't encode");
  });

  it('reports errors without the key', async () => {
    const http = async () => new Response('Unauthorized', { status: 401 });
    const err = await new Bunny(target, http as unknown as typeof fetch)
      .findVideo('x')
      .catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 401');
    expect(String(err)).not.toContain('library-key-not-real');
  });

  it('checks a stored image by listing its folder', async () => {
    const http = jest.fn(async (_url: string) =>
      json([{ ObjectName: 'image-01.webp', Length: 1234, IsDirectory: false }]),
    );
    const bunny = new Bunny(target, http as unknown as typeof fetch);
    await expect(bunny.storedSize('dev-seed/image-01.webp')).resolves.toBe(
      1234,
    );
    await expect(
      bunny.storedSize('dev-seed/image-02.webp'),
    ).resolves.toBeNull();
    expect(http.mock.calls[0][0]).toBe(
      'https://uk.storage.bunnycdn.com/heisreal-dev-images/dev-seed/',
    );
  });

  it('records Bunny’s size and length, and refuses ones that don’t match the spec', () => {
    expect(recordClip('clip-01', CLIPS['clip-01'], video({}))).toEqual({
      videoId: 'g1',
      thumbnailPath: 'g1/thumbnail.jpg',
      width: 360,
      height: 640,
      durationSeconds: 12,
    });
    expect(
      recordClip('clip-08', CLIPS['clip-08'], video({ width: 0, height: 0 })),
    ).toEqual({
      videoId: 'g1',
      durationSeconds: 12,
    });
    expect(() =>
      recordClip('clip-01', CLIPS['clip-01'], video({ width: 640 })),
    ).toThrow('640x640');
    expect(() =>
      recordClip('clip-01', CLIPS['clip-01'], video({ length: 20 })),
    ).toThrow('20 s');
  });

  it('serialises the record in a stable order', () => {
    const text = serialise({
      libraryId: '123',
      clips: {
        'clip-02': { videoId: 'b', durationSeconds: 1 },
        'clip-01': { videoId: 'a', durationSeconds: 1 },
      },
      images: {},
    });
    expect(text.indexOf('clip-01')).toBeLessThan(text.indexOf('clip-02'));
    expect(text.endsWith('\n')).toBe(true);
  });
});
