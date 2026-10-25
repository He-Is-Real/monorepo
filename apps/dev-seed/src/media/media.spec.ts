import { Bunny, clipTitle, type StreamVideo } from './bunny';
import { exifBlock, readGps, withExif } from './exif';

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

describe('Bunny uploads', () => {
  const target = {
    libraryId: '123',
    libraryKey: 'library-key-not-real',
    storageZone: 'heisreal-dev-image-store',
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
    const http = vi.fn(async () =>
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

  it('reports errors without the key', async () => {
    const http = async () => new Response('Unauthorized', { status: 401 });
    const err = await new Bunny(target, http as unknown as typeof fetch)
      .findVideo('x')
      .catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 401');
    expect(String(err)).not.toContain('library-key-not-real');
  });
});
