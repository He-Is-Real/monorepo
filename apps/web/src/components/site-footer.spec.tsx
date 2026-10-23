/**
 * @jest-environment jsdom
 */
import { render, screen, within } from '@testing-library/react';
import { consentChecksRelaxed } from '@/lib/site-status';
import { SiteFooter } from './site-footer';

jest.mock('@/lib/site-status', () => ({ consentChecksRelaxed: jest.fn() }));
const relaxed = consentChecksRelaxed as jest.Mock;

async function renderFooter(isRelaxed: boolean) {
  relaxed.mockResolvedValue(isRelaxed);
  render(await SiteFooter());
}

describe('SiteFooter', () => {
  it('is the page’s contentinfo landmark, with the site’s pages', async () => {
    await renderFooter(false);
    const footer = screen.getByRole('contentinfo');
    const nav = within(footer).getByRole('navigation', { name: 'Footer' });
    const links = within(nav)
      .getAllByRole('link')
      .map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Browse stories', '/stories'],
      ['About us', '/about'],
      ['The Greatest Story', '/greatest-story'],
      ['FAQs', '/faqs'],
      ['Get ready to share', '/get-ready'],
      ['Next steps', '/next-steps'],
      ['Contact us', '/contact'],
    ]);
  });

  it('links the privacy policy and terms', async () => {
    await renderFooter(false);
    const href = (name: string) =>
      screen.getByRole('link', { name }).getAttribute('href');
    expect(href('Privacy policy')).toBe('/privacy');
    expect(href('Terms')).toBe('/terms');
  });

  it('says the site only uses essential cookies and storage, and where to read more (PECR)', async () => {
    await renderFooter(false);
    expect(
      screen.getByText(/We only use essential cookies and storage\./),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'How we use cookies' })
        .getAttribute('href'),
    ).toBe('/privacy#cookies');
  });

  it('describes who we are', async () => {
    await renderFooter(false);
    expect(
      screen.getByText(/A collection of God Stories from everyday people/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'UK-based not-for-profit. Charity registration pending.',
      ),
    ).toBeTruthy();
  });

  it('says when consent checks are relaxed (D48, dev only)', async () => {
    await renderFooter(true);
    expect(screen.getByText('Consent checks relaxed (dev)')).toBeTruthy();
  });

  it('has no D48 note when consent checks are strict', async () => {
    await renderFooter(false);
    expect(screen.queryByText('Consent checks relaxed (dev)')).toBeNull();
  });
});
