import {
  CACHE_PUBLIC,
  collectionETag,
  ifNoneMatchHits,
  publicCacheControl,
  representationETag,
} from './caching';

describe('ETags', () => {
  it('hashes the representation: strong for a resource, weak for a collection', () => {
    const body = { data: [1, 2] };
    expect(representationETag(body)).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(collectionETag(body)).toBe(`W/${representationETag(body)}`);
    expect(collectionETag({ data: [1] })).not.toBe(collectionETag(body));
  });

  it.each([
    ['W/"abc"', 'W/"abc"', true],
    ['"abc"', 'W/"abc"', true],
    ['W/"abc"', '"abc"', true],
    ['"x", W/"abc"', 'W/"abc"', true],
    ['*', 'W/"abc"', true],
    ['W/"abd"', 'W/"abc"', false],
    [undefined, 'W/"abc"', false],
  ])(
    'If-None-Match %s against %s: %s (weak comparison)',
    (header, etag, hit) => {
      expect(ifNoneMatchHits(header, etag)).toBe(hit);
    },
  );
});

describe('publicCacheControl (D51)', () => {
  const saved = process.env['PUBLIC_RESPONSE_CACHING'];
  afterEach(() => {
    if (saved === undefined) delete process.env['PUBLIC_RESPONSE_CACHING'];
    else process.env['PUBLIC_RESPONSE_CACHING'] = saved;
  });

  it('is no-store unless shared caching is turned on: a hidden story disappears at once', () => {
    delete process.env['PUBLIC_RESPONSE_CACHING'];
    expect(publicCacheControl()).toBe('no-store');
  });

  it('lets shared caches keep public reads when turned on (Go live, D56)', () => {
    process.env['PUBLIC_RESPONSE_CACHING'] = 'on';
    expect(publicCacheControl()).toBe(CACHE_PUBLIC);
  });

  it.each(['true', 'ON', '1', 'yes', ''])(
    'fails safe to no-store for %j',
    (value) => {
      process.env['PUBLIC_RESPONSE_CACHING'] = value;
      expect(publicCacheControl()).toBe('no-store');
    },
  );
});
