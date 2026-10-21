'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  isDark,
  nextThemeChoice,
  readThemeChoice,
  THEME_KEY,
  type ThemeChoice,
} from '@/lib/theme';

const LABELS: Record<ThemeChoice, string> = {
  light: 'Light theme',
  dark: 'Dark theme',
  system: 'Theme follows your device',
};

const prefersDark = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

function apply(choice: ThemeChoice) {
  document.documentElement.classList.toggle(
    'dark',
    isDark(choice, prefersDark()),
  );
}

/**
 * One 44 px button that cycles light → dark → system (Joel, 0.9). The choice is remembered on
 * this device; "system" follows the device, also when it changes while the page is open.
 */
export function ThemeToggle() {
  // Before hydration the stored choice is unknown; "system" renders the same everywhere.
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => {
    setChoice(readThemeChoice(window.localStorage));
  }, []);

  useEffect(() => {
    if (choice !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => apply('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [choice]);

  const cycle = useCallback(() => {
    setChoice((current) => {
      const next = nextThemeChoice(current);
      try {
        if (next === 'system') window.localStorage.removeItem(THEME_KEY);
        else window.localStorage.setItem(THEME_KEY, next);
      } catch {
        // Storage unavailable (private mode): the choice lasts for this page only.
      }
      apply(next);
      return next;
    });
  }, []);

  const upcoming = LABELS[nextThemeChoice(choice)].toLowerCase();
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`${LABELS[choice]}. Switch to ${upcoming}`}
      title={LABELS[choice]}
      data-theme-choice={choice}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-secondary-text transition-colors hover:bg-accent hover:text-foreground"
    >
      <ThemeIcon choice={choice} />
    </button>
  );
}

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (choice === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (choice === 'dark') {
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
