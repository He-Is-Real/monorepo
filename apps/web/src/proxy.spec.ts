/**
 * @jest-environment node
 */
import { proxy } from './proxy';

describe('proxy (noindex in dev)', () => {
  const saved = process.env['ROBOTS_NOINDEX'];
  afterEach(() => {
    if (saved === undefined) delete process.env['ROBOTS_NOINDEX'];
    else process.env['ROBOTS_NOINDEX'] = saved;
  });

  it('sends X-Robots-Tag: noindex, nofollow when ROBOTS_NOINDEX is on', () => {
    process.env['ROBOTS_NOINDEX'] = 'true';
    expect(proxy().headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('sends nothing extra otherwise', () => {
    delete process.env['ROBOTS_NOINDEX'];
    expect(proxy().headers.get('x-robots-tag')).toBeNull();
  });
});
