/**
 * @jest-environment node
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { consentChecksRelaxed } from '@/lib/site-status';
import { SiteFooter } from './site-footer';

jest.mock('@/lib/site-status', () => ({ consentChecksRelaxed: jest.fn() }));
const relaxed = consentChecksRelaxed as jest.Mock;

describe('SiteFooter', () => {
  it('says when consent checks are relaxed (D48, dev only)', async () => {
    relaxed.mockResolvedValue(true);
    const html = renderToStaticMarkup(await SiteFooter());
    expect(html).toContain('<footer');
    expect(html).toContain('Consent checks relaxed (dev)');
  });

  it('renders nothing otherwise', async () => {
    relaxed.mockResolvedValue(false);
    expect(await SiteFooter()).toBeNull();
  });
});
