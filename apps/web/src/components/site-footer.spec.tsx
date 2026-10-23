/**
 * @jest-environment node
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { consentChecksRelaxed } from '@/lib/site-status';
import { SiteFooter } from './site-footer';

// The footer's links and cookie notice are checked on every device by e2e/static-pages.e2e.ts;
// here only D48's note, which the e2e stub always reports as on.
jest.mock('@/lib/site-status', () => ({ consentChecksRelaxed: jest.fn() }));
const relaxed = consentChecksRelaxed as jest.Mock;

describe('SiteFooter', () => {
  it('says when consent checks are relaxed (D48, dev only)', async () => {
    relaxed.mockResolvedValue(true);
    expect(renderToStaticMarkup(await SiteFooter())).toContain(
      'Consent checks relaxed (dev)',
    );
  });

  it('has no D48 note when consent checks are strict', async () => {
    relaxed.mockResolvedValue(false);
    expect(renderToStaticMarkup(await SiteFooter())).not.toContain(
      'Consent checks relaxed',
    );
  });
});
