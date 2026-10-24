/**
 * @jest-environment node
 */
import { proxy } from './proxy';

describe('proxy (noindex unless indexing is explicitly allowed)', () => {
  const saved = {
    INDEXING: process.env['INDEXING'],
    SITE_URL: process.env['SITE_URL'],
  };
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('sends X-Robots-Tag: noindex, nofollow by default (dev)', () => {
    delete process.env['INDEXING'];
    process.env['SITE_URL'] = 'https://web-abc-nw.a.run.app';
    expect(proxy().headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('sends it for a misspelled switch too', () => {
    process.env['INDEXING'] = 'allowed';
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    expect(proxy().headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('sends nothing extra once INDEXING=allow and a site URL (Go live)', () => {
    process.env['INDEXING'] = 'allow';
    process.env['SITE_URL'] = 'https://www.heisreal.today';
    expect(proxy().headers.get('x-robots-tag')).toBeNull();
  });
});
