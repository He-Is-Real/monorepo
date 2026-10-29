import {
  LINK_BUCKET_SECONDS,
  LINK_TTL_SECONDS,
  linkExpiry,
  signCdnUrl,
  signEmbedUrl,
} from './bunny-tokens';

// Known answers: Bunny's reference implementation (BunnyWay/BunnyCDN.TokenAuthentication,
// nodejs/token.js) and its test key and expiry.
const KEY = 'SecurityKey';
const EXPIRES = 1598024587;
const VIDEO = 'eb1c4f77-0cda-46be-b47d-1118ad7c2ffe';
// Public test vectors (not secrets): what the reference code returns for KEY and EXPIRES.
const EMBED_SHA256 =
  'a1767bba437b0bf2024aa138a9dc887c2119fd108dea7dbb6443c072a0deab00';
const CDN_300KB = 'HS256-o10JRWlsAItyAsdKS6jJKjabHN4FrFsplDHPV1idcX4';
const CDN_THUMB = 'HS256-PUH5x68kuR4px232wvUeMNF352BGPHQAu8aYigRB8TA';
const query = (signature: string) =>
  `?${new URLSearchParams({ token: signature, expires: String(EXPIRES) })}`;

describe('linkExpiry', () => {
  it('leaves at least 6 hours, rounded up to the next hour', () => {
    const now = Date.UTC(2026, 9, 23, 10, 15, 30);
    const expires = linkExpiry(now);
    expect(expires % LINK_BUCKET_SECONDS).toBe(0);
    expect(expires).toBe(Date.UTC(2026, 9, 23, 17) / 1000);
    expect(expires - now / 1000).toBeGreaterThanOrEqual(LINK_TTL_SECONDS);
    expect(expires - now / 1000).toBeLessThanOrEqual(
      LINK_TTL_SECONDS + LINK_BUCKET_SECONDS,
    );
  });

  it('keeps exactly 6 hours on an hour boundary', () => {
    const now = Date.UTC(2026, 9, 23, 10);
    expect(linkExpiry(now)).toBe(now / 1000 + LINK_TTL_SECONDS);
  });

  it('is the same all hour, so responses (and their ETags) stay stable', () => {
    expect(linkExpiry(Date.UTC(2026, 9, 23, 10, 0, 1))).toBe(
      linkExpiry(Date.UTC(2026, 9, 23, 10, 59, 59)),
    );
  });
});

describe('signEmbedUrl', () => {
  it('signs sha256_hex(key + video id + expires) on Bunny’s player URL', () => {
    expect(signEmbedUrl('759', VIDEO, KEY, EXPIRES)).toBe(
      `https://player.mediadelivery.net/embed/759/${VIDEO}${query(EMBED_SHA256)}`,
    );
  });

  it.each([
    ['not a UUID', 'abc'],
    ['a path', `../${VIDEO}`],
    ['empty', ''],
  ])('refuses a video id that is %s', (_, id) => {
    expect(signEmbedUrl('759', id, KEY, EXPIRES)).toBeNull();
  });

  it('refuses a library id that is not a number', () => {
    expect(signEmbedUrl('75/9', VIDEO, KEY, EXPIRES)).toBeNull();
  });
});

describe('signCdnUrl', () => {
  it('matches Bunny’s reference token (HMAC-SHA256, no parameters)', () => {
    expect(
      signCdnUrl('token-tester.b-cdn.net', '300kb.jpg', KEY, EXPIRES),
    ).toBe(`https://token-tester.b-cdn.net/300kb.jpg${query(CDN_300KB)}`);
  });

  it('signs a Stream thumbnail path', () => {
    expect(
      signCdnUrl(
        'vz-da4dce15-a49.b-cdn.net',
        'b8a77258-abfd-469d-ba63-9b89b62fcce6/thumbnail.jpg',
        KEY,
        EXPIRES,
      ),
    ).toBe(
      'https://vz-da4dce15-a49.b-cdn.net/b8a77258-abfd-469d-ba63-9b89b62fcce6/thumbnail.jpg' +
        query(CDN_THUMB),
    );
  });

  it.each([
    ['a leading slash', '/dev-seed/a.webp'],
    ['a parent segment', 'dev-seed/../secret.webp'],
    ['a dot segment', 'dev-seed/./a.webp'],
    ['an empty segment', 'dev-seed//a.webp'],
    ['a space', 'dev seed/a.webp'],
    ['percent-encoding', 'dev-seed/a%2Fb.webp'],
    ['a query', 'a.webp?x=1'],
    ['a fragment', 'a.webp#x'],
    ['a backslash', 'dev-seed\\a.webp'],
    ['non-ASCII', 'café.webp'],
    ['empty', ''],
  ])('refuses a path with %s', (_, path) => {
    expect(signCdnUrl('token-tester.b-cdn.net', path, KEY, EXPIRES)).toBeNull();
  });

  it('refuses an over-long path', () => {
    expect(
      signCdnUrl('token-tester.b-cdn.net', 'a'.repeat(501), KEY, EXPIRES),
    ).toBeNull();
  });
});
