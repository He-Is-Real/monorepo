import React from 'react';
import { render, screen } from '@testing-library/react';
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
