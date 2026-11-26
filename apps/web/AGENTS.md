# apps/web (the website)

Rules for the Next.js website and the `libs/web-ui` pieces it uses. The root `AGENTS.md` still applies.
`apps/web` uses Jest (the Nest apps and libs use Vitest).

## Every screen size

Every page and view is mobile-first and works from 320 px phones through foldables, tablets (both
orientations) and 1920 px+ desktops: no horizontal scroll, 44 px touch targets, readable line lengths,
safe-area insets. Cover each new page in `apps/web/e2e` (device matrix in `devices.ts`): its "fits the
screen" checks run on every device; whole flows and other behaviour run on `BEHAVIOUR_DEVICES` (one phone,
one desktop) only.

## Web UI building blocks

Pages use the pieces in `libs/web-ui` (`@heisreal/web-ui`, see its `README.md`) instead of their own
styled copies:

- every drop-down is its `Select`, every text box its `Input`, every text area its `Textarea`, with
  `Field`, `FieldLabel`, `FieldHint` and `FieldError` for the label, hint and error wiring;
- every bordered panel is its `Card`, every pop-up menu panel its `PopoverPanel`, every dialog its
  `Dialog`;
- headings, text and links are its `Heading`, `Text`, `Quote` and `TextLink` (a text colour, size or
  weight class in page code fails lint);
- buttons whose words may wrap are `Button wrap`.

Pages pass layout classes only (width, margins, padding, grid placement); a copied field class string
fails lint. The library also owns the theme (`libs/web-ui/src/styles/theme.css`: colours light and dark,
font, radii, widths) and these lint checks (`@heisreal/web-ui/eslint`). Colours are named by meaning
(`danger`, `warning`, `success`, `info`, `brand`, `media`…); a hex, rgb() or Tailwind palette colour
(`red-600`, `bg-white`) in page code fails lint.

## Styling order

When building or changing UI:

1. Use the library's pieces and its colours (named by meaning) as they are.
2. If no piece quite fits, adjust the design to use a common existing piece, accepting a small compromise,
   rather than adding something new.
3. If no existing piece can do the job, add a new piece to `libs/web-ui` (never a page-local styled copy).
4. Only as a last resort, style in `apps/web` page code, and say why in the PR.
