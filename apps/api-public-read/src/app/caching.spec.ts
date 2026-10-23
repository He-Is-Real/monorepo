import { collectionETag, ifNoneMatchHits, representationETag } from './caching';

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
