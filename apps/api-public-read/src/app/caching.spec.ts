import { ifNoneMatchHits, publicCacheControl } from './caching';

describe('ETags', () => {
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

  it.each(['true', 'ON', '1', 'yes', ''])(
    'fails safe to no-store for %j',
    (value) => {
      process.env['PUBLIC_RESPONSE_CACHING'] = value;
      expect(publicCacheControl()).toBe('no-store');
    },
  );
});
