# @heisreal/web-ui

The He Is Real web building blocks: React components that `apps/web` pages use instead of their
own styled copies (`docs/how-the-app-works.md`, layout and UI rules).

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
- `Card`: a bordered panel on the card colour (`tone`: `default`, `destructive`, `primary`, `link`).
  `asChild` puts the look on its child (a `section`, `form`, `ul`).
- `PopoverPanel`: the panel of a pop-up menu (Radix Popover content, in a portal). Inside a
  `Popover.Root`; pass padding only.
- `Button` and `buttonVariants`: the site's buttons (shadcn/ui, cva). `wrap`: words may wrap, at
  least 44 px tall, full width on phones.
- `fieldVariants`: the field look, for a control the library doesn't have yet.
- `cn`: class names, with later Tailwind utilities overriding earlier ones.

Pages pass layout classes only (width, margins, padding, grid placement). A page class string with
the field look (input border, input background and a focus ring) fails `apps/web`'s lint.

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
