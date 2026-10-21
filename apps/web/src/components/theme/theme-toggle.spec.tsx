import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ThemeToggle } from './theme-toggle';

describe('ThemeToggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    window.matchMedia = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }) as never;
  });

  it('is one 44 px button that cycles light → dark → system and remembers it', async () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('size-11');
    expect(button.getAttribute('aria-label')).toBe(
      'Theme follows your device. Switch to light theme',
    );

    await act(async () => fireEvent.click(button));
    expect(window.localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await act(async () => fireEvent.click(button));
    expect(window.localStorage.getItem('theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await act(async () => fireEvent.click(button));
    expect(window.localStorage.getItem('theme')).toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false); // device: light
  });

  it('starts from the stored choice', async () => {
    window.localStorage.setItem('theme', 'dark');
    render(<ThemeToggle />);
    expect(await screen.findByTitle('Dark theme')).toBeTruthy();
  });
});

describe('ThemeToggle when storage is blocked', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  beforeEach(() => {
    // Some storage policies make the getter itself throw a SecurityError (#45 review).
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(window, 'localStorage', original);
  });

  it('renders as "system" and still switches the theme for this page', async () => {
    render(<ThemeToggle />);
    const button = await screen.findByTitle('Theme follows your device');
    await act(async () => fireEvent.click(button));
    expect(button.getAttribute('data-theme-choice')).toBe('light');
    await act(async () => fireEvent.click(button));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
