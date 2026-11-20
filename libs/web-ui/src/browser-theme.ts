/**
 * The page background, light and dark, for the browser's own bars (Next's `viewport.themeColor`
 * meta tags), which can't read CSS variables. The same values as `--background` in
 * styles/theme.css: change both together.
 */
/* eslint-disable @heisreal/web-ui/no-raw-colour -- the theme's own values, mirrored */
export const browserThemeColour = {
  light: '#ffffff',
  dark: '#111113',
} as const;
/* eslint-enable @heisreal/web-ui/no-raw-colour */
