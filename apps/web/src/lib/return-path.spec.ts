import { safeReturnPath, signInHref, stepReturnPath } from './return-path';

// The return address is a query parameter anyone can write, so it must never send people to
// another site (an open redirect) or back to sign-in.
describe('safeReturnPath', () => {
  it.each([
    ['/stories/a-story?theme=hope#top', '/stories/a-story?theme=hope#top'],
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
    expect(signInHref('/stories/x?theme=a')).toBe(
      '/sign-in?redirect_url=%2Fstories%2Fx%3Ftheme%3Da',
    );
    expect(signInHref('/')).toBe('/sign-in');
  });
});

// An agreement step returns to the page the person started from, never to a step: asked again on
// a step (the account check and a refused request can both send them), it keeps that page.
describe('stepReturnPath', () => {
  it.each([
    ['/stories?theme=hope', '/stories?theme=hope'],
    [
      '/consent/terms?redirect_url=%2Fstories%3Ftheme%3Dhope',
      '/stories?theme=hope',
    ],
    ['/consent/testimony?redirect_url=%2Fshare', '/share'],
    ['/consent/terms', '/'],
    ['/consent/terms?redirect_url=%2Fconsent%2Fterms', '/'],
    ['/consent/terms?redirect_url=https%3A%2F%2Fevil.example', '/'],
  ])('%s returns to %s', (here, expected) => {
    expect(stepReturnPath(here)).toBe(expected);
  });
});
