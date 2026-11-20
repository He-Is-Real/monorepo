# @heisreal/web-ui

The He Is Real web library: the site's theme (colours, font, shapes), its building blocks (React
components that `apps/web` pages use instead of their own styled copies) and the lint checks that
keep pages on them (`docs/how-the-app-works.md`, layout and UI rules; LB-1 and OT-1, Joel,
20 November 2026). Another website gets the whole look from it.

## Using it in a website

The website needs React 19, Tailwind CSS v4 (`@tailwindcss/postcss`) and `tw-animate-css`, and
depends on `"@heisreal/web-ui": "workspace:*"`.

1. **The theme: one import.** At the top of the website's main stylesheet:

   ```css
   @import '@heisreal/web-ui/theme.css';
   ```

   It brings Tailwind, the colours light and dark, the radii and widths, the base styles (body,
   links, focus ring, reduced motion, safe areas), the drop-down's native CSS, and tells Tailwind
   to read the library's classes. Light is the default; `dark` on `<html>` switches to dark
   (`apps/web/src/lib/theme.ts` sets it before first paint), and `light` on an element keeps it
   light inside a dark page. Rules for the website's own pages follow the import.

2. **The font.** Set `--font-brand` on `<html>` to the font family (DM Sans). In Next.js:
   `DM_Sans({ variable: '--font-brand', … })` and its `.variable` class on `<html>`.

3. **The browser's bar colour.** `browserThemeColour.light` and `.dark` (the page background) for
   the `theme-color` meta tags, which can't read CSS variables.

4. **The lint checks.** In the website's `eslint.config.mjs`:

   ```js
   import webUi from '@heisreal/web-ui/eslint';
   export default [...yourConfig, ...webUi.configs.pages];
   ```

   - `@heisreal/web-ui/field-look`: a class string with the field look (input border, input
     background and a focus ring) fails; use `Input` or `Textarea`.
   - `@heisreal/web-ui/no-raw-colour`: a hex colour, an `rgb()`/`hsl()`/`oklch()` colour, a
     Tailwind palette class (`red-600`, `bg-white`, `text-black/50`, `border-teal`) or `white` or
     `black` in an arbitrary value fails; use the colour names below. A colour a third party
     dictates (a brand's logo) is the one exception: wrap it in
     `/* eslint-disable @heisreal/web-ui/no-raw-colour -- why */` and `eslint-enable`
     (`apps/web` share-menu.tsx: WhatsApp, Facebook and Instagram).

   Tests, e2e and config files are skipped. `eslint/rules.test.mjs` probes both rules (the
   `lint-rules` target, run before `lint`).

## Colours

Every colour is defined once, in `src/styles/theme.css`, light and dark, and named by what it
means. Pages use only these names, as Tailwind classes (`bg-danger`, `text-danger-text`,
`border-brand`, `bg-media/55`) or CSS variables (`var(--danger)`). Opacity modifiers make tints
(`bg-warning/10`, `border-warning/50`). Contrast for each is in the theme file's header.

| Name                                   | Means                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `background`, `foreground`             | The page and its text.                                                                                                  |
| `raised`, `card`, `surface`, `popover` | Surfaces above the page: raised strips, bordered panels, filled areas, pop-up menus.                                    |
| `secondary-text`, `muted-foreground`   | Quieter text (hints, captions).                                                                                         |
| `faint`                                | The quietest: large text, placeholders and icons only.                                                                  |
| `link`, `link-hover`                   | Links.                                                                                                                  |
| `primary`, `primary-foreground`        | The main action (filled buttons) and its text.                                                                          |
| `secondary`, `muted`, `accent`         | Secondary fills; `accent` is the brand tint behind a chosen or hovered item.                                            |
| `border`, `border-hover`               | Dividers and panel edges; the stronger edge (outlined buttons).                                                         |
| `input`, `input-background`            | A field's edge and fill.                                                                                                |
| `ring`                                 | The keyboard focus ring.                                                                                                |
| `danger`                               | Errors and what can't be undone (delete, reject): fills, edges, rings. One red everywhere: moderation's checked red.    |
| `danger-foreground`                    | Text on a danger fill.                                                                                                  |
| `danger-text`                          | Red words (errors, "overdue"). In dark, the red lightened 25% so it reads on every surface.                             |
| `warning`, `warning-foreground`        | Needs attention soon (late, send back, a notice): amber, and text on an amber fill.                                     |
| `success`                              | Done or added (a legal text's added words).                                                                             |
| `info`                                 | A neutral note (the link colour).                                                                                       |
| `brand`                                | The logo teal: decoration, edges, a chosen item's mark. Never small text on white (3.2:1).                              |
| `brand-strong`, `brand-bright`         | The brand's stronger and brighter steps (an avatar's fill; the hero's words and hovers).                                |
| `logo`                                 | The logo: brand teal on light, white on dark.                                                                           |
| `media`, `on-media`                    | Black behind pictures and video and the veil over them; white for what sits on them (play buttons, captions, initials). |
| `hero`                                 | The home page's hero, always dark.                                                                                      |
| `--art-1-…` to `--art-5-…`             | A story card without a picture: five quiet artworks (`-from`, `-to`, `-accent`), CSS variables only.                    |

## Components

- `Select`: the site's drop-down. Every drop-down is this one. Closed, a theme field with the
  theme's chevron. Open on a computer (mouse or trackpad) once JavaScript runs: the themed list
  (Radix Select) in every browser. Before that, without JavaScript, and on phones and tablets: a
  native `<select>` (forms work without JavaScript; touch screens keep their own picker).
  Options are passed as `options={[{ value, label }]}`; `onValueChange` reports a choice;
  `submitOnChange` submits the surrounding form once the new value is in it.
- `Input`: the site's text box. `size`: `compact` (default; the drop-down's field: search boxes and
  filters), `form` (admin forms) or `writing` (sharing a story). The three sizes are the looks the
  pages had before WL-1, kept until one is chosen.
- `Textarea`: the text box's look, taller (`size` `writing`, the default, or `form`; set the
  height with a `min-h-*` class).
- `Field`, `FieldLabel`, `FieldHint`, `FieldError`: the label, hint and error of one control. `Field`
  adds no element: inside it, the label points at the control, and the `Input`, `Textarea` or
  `Select` takes the id, `aria-describedby` (hint, any `describedBy` ids, error) and `aria-invalid`
  (while there is an error). A control given its own `id` keeps it and takes nothing from the field.
  `FieldError` shows only while the field has an error.
- `Card`: a bordered panel on the card colour (`tone`: `default`, `danger`, `primary`, `link`).
  `asChild` puts the look on its child (a `section`, `form`, `ul`).
- `PopoverPanel`: the panel of a pop-up menu (Radix Popover content, in a portal). Inside a
  `Popover.Root`; pass padding only.
- `Button` and `buttonVariants`: the site's buttons (shadcn/ui, cva). `variant`: `default`,
  `danger` (can't be undone: delete, reject), `caution` (moderation's Send back), `outline`,
  `secondary`, `ghost`, `link`. `wrap`: words may wrap, at least 44 px tall, full width on phones.
- `fieldVariants`: the field look, for a control the library doesn't have yet.
- `cn`: class names, with later Tailwind utilities overriding earlier ones.
- `browserThemeColour`: the page background, light and dark, for `theme-color` meta tags.

Pages pass layout classes only (width, margins, padding, grid placement).

## Tests

No unit tests for the components: they are checked through the pages that use them, in
Playwright (`apps/web/e2e`, e.g. `themed-select.e2e.ts`). The lint rules have probes
(`eslint/rules.test.mjs`).
