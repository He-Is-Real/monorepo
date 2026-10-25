import { safeReturnPath, signInHref } from './return-path';

// The return address is a query parameter anyone can write, so it must never send people to
// another site (an open redirect) or back to sign-in.
describe('safeReturnPath', () => {
  it.each([
    ['/stories/a-story?tag=hope#top', '/stories/a-story?tag=hope#top'],
    ['/about', '/about'],
  ])('keeps a path on this site: %s', (raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'https://evil.example/',
    '//evil.example/x',
    '/.//evil.example',
    '/..//evil.example',
    '/a/..//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    '/x\u0000',
    '/sign-in',
    '/sign-in?redirect_url=/about',
  ])('sends anything else home: %s', (raw) => {
    expect(safeReturnPath(raw)).toBe('/');
  });
});

describe('signInHref', () => {
  it('returns to the page it came from', () => {
    expect(signInHref('/stories/x?tag=a')).toBe(
      '/sign-in?redirect_url=%2Fstories%2Fx%3Ftag%3Da',
    );
    expect(signInHref('/')).toBe('/sign-in');
  });
});
