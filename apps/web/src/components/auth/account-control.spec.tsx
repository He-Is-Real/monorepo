import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useUser } from '@clerk/react';
import { AccountControl } from './account-control';

jest.mock('@clerk/react', () => ({
  useUser: jest.fn(),
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

  it('offers sign-in when signed out', () => {
    mockUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
      user: null,
    });
    render(<AccountControl />);
    expect(
      screen.getByTestId('clerk-sign-in').querySelector('button')?.textContent,
    ).toBe('Sign in');
  });

  it('shows the signed-in person’s first name, and their full name with Clerk’s sign-out in its panel', async () => {
    mockUseUser.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: { fullName: 'Ann Example', firstName: 'Ann' },
    });
    render(<AccountControl />);
    const account = screen.getByRole('button', {
      name: 'Account: Ann Example',
    });
    expect(account.textContent).toContain('Ann');
    await act(async () => fireEvent.click(account));
    expect(screen.getByRole('dialog').textContent).toContain(
      'Signed in as Ann Example',
    );
    expect(
      screen.getByTestId('clerk-sign-out').querySelector('button')?.textContent,
    ).toBe('Sign out');
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
