# @heisreal/web-ui

The He Is Real web building blocks: React components that `apps/web` pages use instead of their
own styled copies (`docs/how-the-app-works.md`, layout and UI rules).

- `Select`: the site's drop-down. Every drop-down is this one. Closed, a theme field with the
  theme's chevron. Open on a computer (mouse or trackpad) once JavaScript runs: the themed list
  (Radix Select) in every browser. Before that, without JavaScript, and on phones and tablets: a
  native `<select>` (forms work without JavaScript; touch screens keep their own picker).
  Options are passed as `options={[{ value, label }]}`; `onValueChange` reports a choice;
  `submitOnChange` submits the surrounding form once the new value is in it.
- `Button` and `buttonVariants`: the site's buttons (shadcn/ui, cva).
- `cn`: class names, with later Tailwind utilities overriding earlier ones.

## It relies on the site's theme

The components use the site's theme tokens as Tailwind classes and CSS variables (`bg-popover`,
`border-input`, `bg-input-background`, `text-link`, `--radius`, `--teal`, …). Those tokens stay
defined in `apps/web/src/app/global.css`, and so does the `.native-select` style the native drop-down
uses. Any app using this library must define them too.

Tailwind only generates classes it finds in its sources, so `global.css` has an `@source` line for
this library. Keep it when moving files.

## Tests

No unit tests: the components are checked through the pages that use them, in Playwright
(`apps/web/e2e`, e.g. `themed-select.e2e.ts`).
