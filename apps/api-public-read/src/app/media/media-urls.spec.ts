import { THUMBNAIL_PATH_CASES } from '@heisreal/contracts/media-paths';
import { createMediaUrls, MediaUrls, mediaConfigFromEnv } from './media-urls';

const ENV = {
  BUNNY_STREAM_LIBRARY_ID: '786537',
  BUNNY_STREAM_CDN_HOST: 'vz-da4dce15-a49.b-cdn.net',
  BUNNY_IMAGES_CDN_HOST: 'heisreal-dev-images.b-cdn.net',
  BUNNY_STREAM_TOKEN_KEY_SECRET: 'bunny-stream-token-key',
  BUNNY_IMAGES_TOKEN_KEY_SECRET: 'bunny-images-token-key',
};
const VIDEO = 'b8a77258-abfd-469d-ba63-9b89b62fcce6';
const NOW = Date.UTC(2026, 9, 23, 10, 15);

const secrets = (values: Record<string, string>) => ({
  get: vi.fn(async (id: string) => {
    if (!(id in values)) throw new Error(`no secret ${id}`);
    return values[id];
  }),
});
const KEYS = {
  'bunny-stream-token-key': 'stream-key',
  'bunny-images-token-key': 'images-key',
};

describe('mediaConfigFromEnv', () => {
  it('refuses a partial configuration, naming what is missing', () => {
    const rest: Record<string, string | undefined> = {
      ...ENV,
      BUNNY_STREAM_CDN_HOST: undefined,
      BUNNY_IMAGES_TOKEN_KEY_SECRET: undefined,
    };
    expect(() => mediaConfigFromEnv(rest)).toThrow(
      /BUNNY_STREAM_CDN_HOST, BUNNY_IMAGES_TOKEN_KEY_SECRET/,
    );
    expect(() =>
      mediaConfigFromEnv({ ...ENV, BUNNY_IMAGES_CDN_HOST: ' ' }),
    ).toThrow(/BUNNY_IMAGES_CDN_HOST/);
  });

  it.each([
    ['BUNNY_STREAM_LIBRARY_ID', 'abc'],
    ['BUNNY_STREAM_CDN_HOST', 'https://vz-x.b-cdn.net'],
    ['BUNNY_IMAGES_CDN_HOST', 'images.b-cdn.net/path'],
    ['BUNNY_STREAM_TOKEN_KEY_SECRET', 'projects/x/secrets/y'],
  ])('refuses a malformed %s', (name, value) => {
    expect(() => mediaConfigFromEnv({ ...ENV, [name]: value })).toThrow(name);
  });
});

describe('createMediaUrls', () => {
  it('trims a trailing newline from a key', async () => {
    const plain = await createMediaUrls(secrets(KEYS), ENV, () => NOW);
    const padded = await createMediaUrls(
      secrets({
        'bunny-stream-token-key': 'stream-key\n',
        'bunny-images-token-key': ' images-key\n',
      }),
      ENV,
      () => NOW,
    );
    expect(padded.playbackUrl(VIDEO)).toBe(plain.playbackUrl(VIDEO));
    expect(padded.imageUrl('dev-seed/image-01.webp')).toBe(
      plain.imageUrl('dev-seed/image-01.webp'),
    );
  });

  it('fails when a key is empty', async () => {
    await expect(
      createMediaUrls(
        secrets({ ...KEYS, 'bunny-images-token-key': '  ' }),
        ENV,
        () => NOW,
      ),
    ).rejects.toThrow('bunny-images-token-key is empty');
  });

  it('fails when a key cannot be read', async () => {
    await expect(
      createMediaUrls(secrets({}), ENV, () => NOW),
    ).rejects.toThrow();
  });

  it('reads nothing and signs nothing when signing is off', async () => {
    const store = secrets(KEYS);
    const urls = await createMediaUrls(store, {}, () => NOW);
    expect(store.get).not.toHaveBeenCalled();
    expect(urls.playbackUrl(VIDEO)).toBeNull();
    expect(urls.thumbnailUrl(VIDEO, `${VIDEO}/thumbnail.jpg`)).toBeNull();
    expect(urls.imageUrl('dev-seed/image-01.webp')).toBeNull();
  });
});

describe('MediaUrls', () => {
  const urls = new MediaUrls(
    {
      config: mediaConfigFromEnv(ENV)!,
      streamKey: 'stream-key',
      imagesKey: 'images-key',
    },
    () => NOW,
  );

  it.each([undefined, null, ''])(
    'gives null for a missing id or path (%p)',
    (missing) => {
      expect(urls.playbackUrl(missing)).toBeNull();
      expect(urls.thumbnailUrl(missing, `${VIDEO}/thumbnail.jpg`)).toBeNull();
      expect(urls.thumbnailUrl(VIDEO, missing)).toBeNull();
      expect(urls.imageUrl(missing)).toBeNull();
    },
  );

  it('signs a thumbnail only inside its own video’s folder', () => {
    const other = '229dbd44-d1a2-4044-be13-bee63c2a0cc1';
    expect(urls.thumbnailUrl(VIDEO, `${other}/thumbnail.jpg`)).toBeNull();
    expect(urls.thumbnailUrl(VIDEO, `${VIDEO}x/thumbnail.jpg`)).toBeNull();
    expect(urls.thumbnailUrl(VIDEO, `${VIDEO}/a/b.jpg`)).toBeNull();
    // Never out of the folder (D60 trusts only frames inside it).
    for (const escape of [
      `${VIDEO}/..`,
      `${VIDEO}/.`,
      `${VIDEO}/../${other}/thumbnail.jpg`,
      `${VIDEO}/..%2f${other}%2fthumbnail.jpg`,
    ])
      expect(urls.thumbnailUrl(VIDEO, escape)).toBeNull();
    expect(urls.thumbnailUrl(VIDEO, `${VIDEO}/thumbnail_2.jpg`)).toContain(
      `/${VIDEO}/thumbnail_2.jpg?`,
    );
  });

  // The same table the database's approval rule is tested against (fn::media::own_thumbnail):
  // every thumbnail path is either signed here and approvable there, or neither.
  it.each(THUMBNAIL_PATH_CASES.map((c) => [c.why, c] as const))(
    'thumbnail path rule, shared with the database: %s',
    (_why, c) => {
      expect(urls.thumbnailUrl(c.videoId, c.path) !== null).toBe(c.ok);
    },
  );

  it('gives null for an unsafe path instead of signing it', () => {
    expect(urls.imageUrl('../other-zone/file.webp')).toBeNull();
  });
});
