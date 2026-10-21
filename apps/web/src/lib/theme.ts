// Light/dark/system theme (Joel, 0.9). The choice lives in localStorage under THEME_KEY on
// this device; no key means "system" (follow prefers-color-scheme). The <head> script below
// applies it before first paint, so there's no flash of the wrong theme. It's a static
// string, so a future Content-Security-Policy can allow it by hash (THEME_SCRIPT_SHA256).

export const THEME_KEY = 'theme';
export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** Runs in <head>, before the body renders. Falls back to the device's setting. */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,c=null;try{c=localStorage.getItem('${THEME_KEY}')}catch(e){}var m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;d.classList.toggle('dark',c==='dark'||(c!=='light'&&!!m))})()`;

/**
 * The stored choice, or "system". Takes the storage as a getter: under some storage policies
 * merely reading `window.localStorage` throws (SecurityError), and that must not break the page.
 */
export function readThemeChoice(
  getStorage: () => Pick<Storage, 'getItem'> = () => window.localStorage,
): ThemeChoice {
  try {
    const value = getStorage().getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Whether the page should be dark for this choice and the device's preference. */
export function isDark(
  choice: ThemeChoice,
  systemPrefersDark: boolean,
): boolean {
  return choice === 'dark' || (choice === 'system' && systemPrefersDark);
}

export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  return THEME_CHOICES[
    (THEME_CHOICES.indexOf(choice) + 1) % THEME_CHOICES.length
  ];
}
