import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import { MobileNav, NAV_LINKS, NavLinks } from './site-nav';

jest.mock('next/navigation', () => ({ usePathname: jest.fn(() => '/') }));
const pathname = usePathname as jest.Mock;

describe('NavLinks', () => {
  it('lists the site’s sections in the mockup’s order', () => {
    render(<NavLinks />);
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual(NAV_LINKS.map((l) => [l.label, l.href]));
    expect(NAV_LINKS.map((l) => l.label)).toEqual([
      'Stories',
      'About',
      'FAQs',
      'Greatest Story',
      'Contact',
      'Donate',
    ]);
  });

  it('marks the current section, story pages included', () => {
    pathname.mockReturnValue('/stories/a-story');
    render(<NavLinks />);
    expect(
      screen
        .getByRole('link', { name: 'Stories' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen.getByRole('link', { name: 'About' }).getAttribute('aria-current'),
    ).toBeNull();
  });
});

describe('MobileNav', () => {
  beforeEach(() => pathname.mockReturnValue('/'));

  it('opens and closes its menu with a 44 px button', async () => {
    render(<MobileNav />);
    const button = screen.getByRole('button', { name: 'Menu' });
    expect(button.className).toContain('size-11');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const menu = document.getElementById(button.getAttribute('aria-controls')!);
    expect(menu?.hidden).toBe(true);

    await act(async () => fireEvent.click(button));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(menu?.hidden).toBe(false);
    expect(
      within(menu!)
        .getByRole('link', { name: 'Share your story' })
        .getAttribute('href'),
    ).toBe('/get-ready');
  });

  it('closes on Escape and gives focus back to its button', async () => {
    render(<MobileNav />);
    const button = screen.getByRole('button', { name: 'Menu' });
    await act(async () => fireEvent.click(button));
    const link = screen.getAllByRole('link', { name: 'About' })[0];
    link.focus();
    await act(async () => fireEvent.keyDown(link, { key: 'Escape' }));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('closes when the page changes', async () => {
    const { rerender } = render(<MobileNav />);
    const button = screen.getByRole('button', { name: 'Menu' });
    await act(async () => fireEvent.click(button));
    pathname.mockReturnValue('/about');
    rerender(<MobileNav />);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});
