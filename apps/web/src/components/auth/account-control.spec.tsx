import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { useUser } from '@clerk/react';
import { AccountControl } from './account-control';

let mockAuthUserId: string | null = null;

jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@clerk/react', () => ({
  useUser: jest.fn(),
  useAuth: () => ({ userId: mockAuthUserId, getToken: async () => null }),
  SignInButton: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="clerk-sign-in">{children}</div>
  ),
  SignOutButton: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="clerk-sign-out">{children}</div>
  ),
}));

const mockUseUser = useUser as unknown as jest.Mock;

describe('AccountControl', () => {
  it('shows nothing interactive while Clerk loads', () => {
    mockUseUser.mockReturnValue({ isLoaded: false });
    render(<AccountControl />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('falls back to the email address when there is no name', () => {
    mockUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: {
        fullName: null,
        firstName: null,
        primaryEmailAddress: { emailAddress: 'ann@example.com' },
      },
    });
    render(<AccountControl />);
    expect(
      screen.getByRole('button', { name: 'Account: ann@example.com' }),
    ).toBeTruthy();
  });
});

describe('what the submit flow kept in the tab, for anyone but the person signed in now', () => {
  const keep = () => {
    window.sessionStorage.setItem(
      'heisreal:share:user_a:new',
      '{"local":"words"}',
    );
    window.sessionStorage.setItem('heisreal:share:user_a:submit:d1', '{}');
    window.sessionStorage.setItem('heisreal:share:user_b:new', '{}');
    window.sessionStorage.setItem('theme', 'dark');
  };
  const left = () =>
    Object.keys(window.sessionStorage)
      .filter((k) => k.startsWith('heisreal:share:'))
      .sort();
  const signedIn = (id: string) => ({
    isLoaded: true,
    isSignedIn: true,
    user: { fullName: id, firstName: id, primaryEmailAddress: null },
  });
  afterEach(() => {
    mockAuthUserId = null;
    window.sessionStorage.clear();
  });

  // Real Clerk's sign-out leaves the page before it reports anyone signed out, so this never
  // waits to see the change: the first render of the next page is enough.
  it('a page that loads with nobody signed in forgets everyone’s', () => {
    keep();
    mockAuthUserId = null;
    mockUseUser.mockReturnValue({ isLoaded: true, isSignedIn: false });
    render(<AccountControl />);
    expect(left()).toEqual([]);
    expect(window.sessionStorage.getItem('theme')).toBe('dark');
  });

  it('a page that loads signed in as B forgets A’s and keeps B’s', () => {
    keep();
    mockAuthUserId = 'user_b';
    mockUseUser.mockReturnValue(signedIn('user_b'));
    render(<AccountControl />);
    expect(left()).toEqual(['heisreal:share:user_b:new']);
  });

  it('nothing is forgotten while Clerk is still loading', () => {
    keep();
    mockUseUser.mockReturnValue({ isLoaded: false });
    render(<AccountControl />);
    expect(left()).toHaveLength(3);
  });

  it('Sign out forgets them on the click, before Clerk signs out', () => {
    mockAuthUserId = 'user_b';
    mockUseUser.mockReturnValue(signedIn('user_b'));
    render(<AccountControl />);
    keep(); // written after the page loaded, e.g. by the submit flow
    fireEvent.click(screen.getByRole('button', { name: 'Account: user_b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(left()).toEqual([]);
  });
});
