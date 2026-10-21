import {
  isDark,
  nextThemeChoice,
  readThemeChoice,
  THEME_SCRIPT,
} from './theme';

describe('theme', () => {
  it('cycles light → dark → system', () => {
    expect(nextThemeChoice('light')).toBe('dark');
    expect(nextThemeChoice('dark')).toBe('system');
    expect(nextThemeChoice('system')).toBe('light');
  });

  it('follows the device only on "system"', () => {
    expect(isDark('system', true)).toBe(true);
    expect(isDark('system', false)).toBe(false);
    expect(isDark('light', true)).toBe(false);
    expect(isDark('dark', false)).toBe(true);
  });

  it('reads the stored choice, defaulting to system (also when storage throws)', () => {
    expect(readThemeChoice(() => ({ getItem: () => 'dark' }))).toBe('dark');
    expect(readThemeChoice(() => ({ getItem: () => null }))).toBe('system');
    expect(readThemeChoice(() => ({ getItem: () => 'purple' }))).toBe('system');
    expect(
      readThemeChoice(() => ({
        getItem: () => {
          throw new Error('denied');
        },
      })),
    ).toBe('system');
    // Under some storage policies the localStorage getter itself throws (SecurityError).
    expect(
      readThemeChoice(() => {
        throw new DOMException('denied', 'SecurityError');
      }),
    ).toBe('system');
  });

  describe('the pre-paint script', () => {
    const run = (stored: string | null, prefersDark: boolean) => {
      document.documentElement.className = '';
      window.localStorage.clear();
      if (stored) window.localStorage.setItem('theme', stored);
      window.matchMedia = jest
        .fn()
        .mockReturnValue({ matches: prefersDark }) as never;
      new Function(THEME_SCRIPT)();
      return document.documentElement.classList.contains('dark');
    };

    it('applies the stored choice, else the device preference', () => {
      expect(run(null, true)).toBe(true);
      expect(run(null, false)).toBe(false);
      expect(run('light', true)).toBe(false);
      expect(run('dark', false)).toBe(true);
    });
  });
});
