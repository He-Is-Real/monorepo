import React from 'react';
import { render } from '@testing-library/react';
import { ClerkProvider } from '@clerk/react';
import { ClerkBrowser } from './clerk-browser';

jest.mock('@clerk/react', () => ({
  ClerkProvider: jest.fn(({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  )),
}));

describe('ClerkBrowser', () => {
  it('turns Clerk’s optional product telemetry off (not strictly necessary under PECR)', () => {
    render(
      <ClerkBrowser publishableKey="pk_test_abc">
        <span>child</span>
      </ClerkBrowser>,
    );
    expect(jest.mocked(ClerkProvider).mock.calls[0][0]).toMatchObject({
      publishableKey: 'pk_test_abc',
      telemetry: false,
    });
  });
});
