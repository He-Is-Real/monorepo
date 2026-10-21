/**
 * @jest-environment node
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteHeader } from './site-header';

jest.mock('next/server', () => ({
  connection: jest.fn(async () => undefined),
}));
jest.mock('@/components/auth/clerk-browser', () => ({
  ClerkBrowser: ({
    publishableKey,
    children,
  }: {
    publishableKey: string;
    children: React.ReactNode;
  }) => <div data-clerk={publishableKey}>{children}</div>,
}));
jest.mock('@/components/auth/account-control', () => ({
  AccountControl: () => <span>account</span>,
}));
jest.mock('@/components/theme/theme-toggle', () => ({
  ThemeToggle: () => <button>theme</button>,
}));
jest.mock('@/components/logo', () => ({ Logo: () => <span>logo</span> }));

describe('SiteHeader', () => {
  const saved = process.env['CLERK_PUBLISHABLE_KEY'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CLERK_PUBLISHABLE_KEY'];
    else process.env['CLERK_PUBLISHABLE_KEY'] = saved;
  });

  it('links home and offers the theme toggle', async () => {
    const html = renderToStaticMarkup(await SiteHeader());
    expect(html).toMatch(
      /<a[^>]*aria-label="He Is Real Today, home"[^>]*href="\/"/,
    );
    expect(html).toContain('<button>theme</button>');
  });

  it('hands the publishable key, read at request time, to Clerk in the browser', async () => {
    process.env['CLERK_PUBLISHABLE_KEY'] = 'pk_test_abc123';
    const html = renderToStaticMarkup(await SiteHeader());
    expect(html).toContain(
      '<div data-clerk="pk_test_abc123"><span>account</span></div>',
    );
  });

  it('shows no sign-in control without a key', async () => {
    delete process.env['CLERK_PUBLISHABLE_KEY'];
    const html = renderToStaticMarkup(await SiteHeader());
    expect(html).not.toContain('account');
    expect(html).toContain('<button>theme</button>');
  });
});
