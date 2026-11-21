/** @jest-environment node */
import { PAGE_CACHE } from '@/page-cache.config';
import { checkPageCacheTable } from './page-cache';

// The config file can't cache a personal or staff page (Joel, 2026-11-21: signed-in, staff and
// moderator pages, Share, Account and Consent are never cached). The server refuses such a table
// too, when it first loads it; this catches it before a deploy.

describe('page-cache.config.ts', () => {
  it('caches only public pages, with valid times', () => {
    expect(() => checkPageCacheTable(PAGE_CACHE)).not.toThrow();
  });

  it.each([
    '/account',
    '/account/stories/[id]/preview',
    '/admin',
    '/admin/consent',
    '/moderation/[id]',
    '/share',
    '/consent/terms',
    '/sign-in',
    '/stories/[slug]',
  ])('refuses a row for %s', (path) => {
    expect(() =>
      checkPageCacheTable({ [path]: { dev: 'off', prod: 30 } }),
    ).toThrow('must never be cached');
  });

  it.each([0, -1, 1.5, 86_401, '30', undefined])(
    'refuses %p as a time',
    (time) => {
      expect(() =>
        checkPageCacheTable({ '/faqs': { dev: time, prod: 'off' } }),
      ).toThrow('needs a dev time');
    },
  );
});
