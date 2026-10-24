/**
 * @jest-environment node
 */
import React from 'react';
import { prerender } from 'react-dom/static';
import { SiteHeader } from './site-header';

/** The header with its streamed account area resolved (renderToStaticMarkup can't wait). */
async function renderHeader(): Promise<string> {
  const { prelude } = await prerender(<SiteHeader />);
  return new Response(prelude).text();
}

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
jest.mock('next/navigation', () => ({ usePathname: () => '/' }));

describe('SiteHeader', () => {
  const saved = process.env['CLERK_PUBLISHABLE_KEY'];
  afterEach(() => {
    if (saved === undefined) delete process.env['CLERK_PUBLISHABLE_KEY'];
    else process.env['CLERK_PUBLISHABLE_KEY'] = saved;
  });

  it('links home and offers the theme toggle', async () => {
    const html = await renderHeader();
    expect(html).toMatch(
      /<a[^>]*aria-label="He Is Real Today, home"[^>]*href="\/"/,
    );
    expect(html).toContain('<button>theme</button>');
  });

  it('has the main navigation, a phone menu and Share your story', async () => {
    const html = await renderHeader();
    expect(html).toContain('aria-label="Main navigation"');
    expect(html).toMatch(/<a[^>]*href="\/stories"[^>]*>Stories<\/a>/);
    expect(html).toContain('<span class="sr-only">Menu</span>');
    expect(html).toMatch(
      /<a[^>]*href="\/get-ready"[^>]*>Share your story<\/a>/,
    );
  });

  it('hands the publishable key, read at request time, to Clerk in the browser', async () => {
    process.env['CLERK_PUBLISHABLE_KEY'] = 'pk_test_abc123';
    const html = await renderHeader();
    expect(html).toContain(
      '<div data-clerk="pk_test_abc123"><span>account</span></div>',
    );
  });

  it('shows no sign-in control without a key', async () => {
    delete process.env['CLERK_PUBLISHABLE_KEY'];
    const html = await renderHeader();
    expect(html).not.toContain('account');
    expect(html).toContain('<button>theme</button>');
  });
});
