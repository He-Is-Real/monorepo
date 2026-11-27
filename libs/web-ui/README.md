# @heisreal/web-ui

The He Is Real web library: the site's theme (colours, font, shapes), its building blocks (React
components that `apps/web` pages use instead of their own styled copies) and the lint checks that
keep pages on them (direction REQ-DIR-020 in `docs/system/direction.md`; the looks people see are in
`docs/product/behaviour/look.md`). Another website gets the whole look from it.

## Styling order (Joel, 2026-11-21)

When building or changing UI:

1. Use the library's pieces and its colours (named by meaning) as they are.
2. If no piece quite fits, prefer adjusting the design to use a common existing piece, accepting a
   small compromise, over adding something new.
3. If no existing piece can do the job, add a new piece to `libs/web-ui` (never a page-local styled
   copy).
4. Only as a last resort, style in `apps/web` page code, and say why in the PR.

Pages otherwise pass layout only (width, spacing, placement).

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

   - `@heisreal/web-ui/no-text-look` (TX-7 A, Joel, 21 November 2026): a text colour, size,
     weight, line height, letter spacing, capitals or italics class (`text-sm`,
     `text-secondary-text`, `font-semibold`, `leading-relaxed`, `tracking-wide`, `uppercase`,
     `italic`) in page code fails; use `Heading`, `Text`, `Quote` or `TextLink`. Only strings that
     read as class lists count. Alignment and wrapping (`text-center`, `text-balance`,
     `line-clamp-2`) are layout and pass. A page that truly needs its own look (the styling
     order's last step) wraps it in `/* eslint-disable-next-line @heisreal/web-ui/no-text-look --
why */`. Box looks (borders, corners, fills, shadows) get their check next round.

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
| `secondary-text`                       | Quieter text (hints, captions, dates, card text): one grey (TX-1 A). Pages use `Text tone="quiet"`.                     |
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
| `success`, `success-text`              | Done or added (a legal text's added words); `success-text` for words on a success tint (the Published badge).           |
| `info`                                 | A neutral note (the link colour).                                                                                       |
| `brand`                                | The logo teal: decoration, edges, a chosen item's mark. Never small text on white (3.2:1).                              |
| `brand-strong`, `brand-bright`         | The brand's stronger and brighter steps (an avatar's fill; the hero's words and hovers).                                |
| `logo`                                 | The logo: brand teal on light, white on dark.                                                                           |
| `media`, `on-media`                    | Black behind pictures and video and the veil over them; white for what sits on them (play buttons, captions, initials). |
| `hero`                                 | The home page's hero, always dark.                                                                                      |
| `overlay`                              | The veil behind a `Dialog` (`backdrop:bg-overlay`).                                                                     |
| `--art-1-…` to `--art-5-…`             | A story card without a picture: five quiet artworks (`-from`, `-to`, `-accent`), CSS variables only.                    |

## Components

Text (round 3, TX-1 to TX-6 A, Joel, 21 November 2026): pages hold no text looks, only layout.

- `Heading`: `level` (1–6) picks the tag; `size` picks the look, with a default per level:
  `display` (the two hero pages, Home and Greatest Story: 40 px on a phone growing to 64 px),
  `title` (every other page's title, level 1's default: 32 px, 44 px wider, normal weight),
  `section` (level 2's default: 24 px, 28 px wider, normal weight, public and admin pages alike),
  `sub` (levels 3 and 4: 18 px semibold, a heading inside a panel, dialog or list), `small` (the
  grey capitals over filters and list groups) and `eyebrow` (the teal capitals above a title, or
  naming a section: "In their words"). `as` draws the look on another element (a `p`, a
  `legend`). `headingVariants({ size })` gives the classes.
- `Text`: `size` `intro` (the paragraph under a title, 18 px), `story` (a story's text and Greatest
  Story's, 18 px with roomy lines), `body` (default, 16 px, card paragraphs too), `small` (14 px:
  hints, captions, dates, tables) or `inherit`; `tone` `normal`, `quiet` (the one grey for quieter
  text), `danger`, `success`, `warning`, `media` / `media-quiet` (white words on pictures, video and the dark
  hero), or the colour around it (default); `weight` `bold` for a name, count or label that stands
  out, `regular` for words inside a bold line ("(optional)") (bold words inside a sentence stay plain `<strong>`); `italic` for
  quotes, speech and subtle hints only (TX-8 C, Joel, 24 November 2026: a prayer, a quoted note, a
  spoken line, "No note yet"). A `p` unless `as` says otherwise;
  `asChild` puts the look on its child. `textVariants(…)` gives the classes.
- `Quote`: a pull quote (a written story's page, About, Greatest Story's verses): a brand bar on the
  left, 22 px italic in the normal text colour; `source` adds who said it as a small caption.
  Italic is for quotes, speech and subtle hints only: `Quote`, or `Text italic`; never an `italic`
  class or `font-style` in a page.
- `TextLink` and `textLinkVariants`: a link that looks like a link (TX-6 A): `kind` `inline` (in a
  sentence: always underlined, so it never relies on colour) or `standalone` (on its own or beside a
  value, "Back to the list", "Change": semibold, underlined on hover, at least 44 px). An `<a>`, or
  `asChild` round a router's link (`apps/web`'s `TextLink` does this for internal and external
  links). The site's menus and footer keep their own links.
- `proseClasses`: the looks of text written in Markdown, one class string per element (`apps/web`'s
  renderer for the legal texts and consents).

- `Select`: the site's drop-down. Every drop-down is this one. Closed, a theme field with the
  theme's chevron. Open on a computer (mouse or trackpad) once JavaScript runs: the themed list
  (Radix Select) in every browser. Before that, without JavaScript, and on phones and tablets: a
  native `<select>` (forms work without JavaScript; touch screens keep their own picker).
  Options are passed as `options={[{ value, label }]}`; `onValueChange` reports a choice;
  `submitOnChange` submits the surrounding form once the new value is in it.
- `Input`: the site's text box (TF-1 B, Joel, 20 November 2026): one look in two sizes. `size`
  `compact` (default; small text, for a search box beside drop-downs) or `standard` (normal text,
  everywhere people type: Share, admin forms, "Delete my account"). The theme-naming box keeps its
  round ends (`rounded-full`), as it stands in for a theme chip while you type.
- `RadioGroup`: radio buttons as a fieldset with its legend as a small heading over 44 px rows,
  each a drawn 22 px round button (the check box's size, MG-4 A) filled teal when chosen (the moderators' list's sort, and the Stories
  page's since Joel, 2026-11-20). Controlled (`value`) or in a form (`name`, `defaultValue`,
  `submitOnChange`).
- `SearchBox`: the search box (BS-2 A, Joel 2026-11-20): the compact `Input` with a magnifier submit
  button inside it, named "Search" (`buttonLabel`). Enter searches too. The Stories page and the
  moderators' list both use it (BS-4 B).
- `Textarea`: the standard text box, taller (set the height with a `min-h-*` class).
- `Field`, `FieldLabel`, `FieldHint`, `FieldError`: the label, hint and error of one control. One
  label look everywhere, semibold (MG-5 A); outside a `Field`, `FieldLabel` takes `htmlFor`. `Field`
  adds no element: inside it, the label points at the control, and the `Input`, `Textarea` or
  `Select` takes the id, `aria-describedby` (hint, any `describedBy` ids, error) and `aria-invalid`
  (while there is an error). A control given its own `id` keeps it and takes nothing from the field.
  `FieldError` shows only while the field has an error.
- `Card`: a bordered panel on the card colour, one look (its unused coloured edges went in round
  3). `asChild` puts the look on its child (a `section`, `form`, `ul`).
- `Dialog`: a panel over the page (MG-3 A, the Stories Filters panel's look, for every dialog): on
  a phone it rises from the bottom, from 640 px a centred box (40 rem; a page may pass a width). A
  title bar (`title`, the sub-heading look) with a × (`closeLabel` names it), a scrolling body and
  an optional `footer` of buttons. `open` and `onClose`; the browser's modal `<dialog>`, so focus
  stays inside, Escape or the × close it and focus goes back; `closeOnOutsideClick` lets a click on
  the veil close it too (the Filters panel; off for the Admin themes dialogs, which hold edits).
  `initialFocus` takes a ref to what gets focus on opening (otherwise the ×). `ref` reaches
  the `<dialog>`; `bodyRef` the body (the Stories filters move in with a portal). The Stories
  Filters panel and the Admin themes dialogs.
- `Accordion`: questions that open one at a time (MG-2 B, the FAQ page's look): a bordered box per
  question with a chevron on the right, the WAI-ARIA accordion pattern (a button in a heading,
  `headingLevel` 3 by default, controlling a region). Answers are in the server's HTML, hidden
  until opened. `items` of `{ id, title, content }`; `idPrefix` starts the ids. For one "show
  more", use `Disclosure`.
- `PopoverPanel`: the panel of a pop-up menu (Radix Popover content, in a portal). Inside a
  `Popover.Root`; pass padding only.
- `Button` and `buttonVariants`: the site's buttons (BT-1 A, Joel, 20 November 2026): 44 px tall
  by default, semibold words, 8 px corners and the site's keyboard focus (the 2 px outline with a
  gap) on every kind. `variant`: `default`, `danger` (can't be undone: delete, reject), `caution`
  (moderation's Send back), `outline` (the stronger edge, teal on hover), `secondary`, `ghost`,
  `link`. `size`: `default` (44 px), `lg` (48 px, the home page's large calls to action), `icon`
  (a square 44 px). `wrap`: words may wrap, at least 44 px tall, full width on phones. A link that
  looks like a button is `Button asChild` round the link (`apps/web`'s `ButtonLink` does this for
  internal and external links); `buttonVariants()` gives the same look (classes already merged, so
  `wrap` wins over the base) to an element that can't take `asChild`. Pages don't set a button's height or padding.
  `disabledReason`: while it's disabled, a short line under it says why (OT-2 A: "Write a reason
  first."), read with it; only where the page has a reason.
- `Chip` and `chipVariants`: a chip you press (CH-1 A): the browse chip everywhere (browse, a
  story's page, Share's theme picker, chosen filters, Admin themes). `chosen`: the brand outline,
  the pale brand fill, bold words and a ✓ (`ChipTick` when `asChild` puts the look on a `Link` or
  a `label`). `add`: the dashed "+ Add" chip. A chip of several controls (an Admin theme's name and
  ×) puts `chipVariants({ padding: 'none' })` on a wrapper.
- `Tag`: a grey label that only says something (a card's themes, "Coming soon"). Not pressable.
- `StatusBadge`: a story's status, a dot and a word coloured by meaning (`tone`): `neutral`
  (Draft, Being edited), `brand` (Waiting for review, Sent back, Ready to send again, Needs a new
  file), `success` (Published), `warning` (Taken down, Hidden), `danger` (Not accepted). My
  submissions and the moderators' list.
- `Confirm`: the one "Are you sure?" step (CD-1 A, CD-2 B), shown in place of the buttons that
  opened it: a bold `question`, the detail (children: a line, a list), the action
  (`confirmLabel`, `onConfirm`) and the way out (`onCancel`; "Keep it" for `danger`, "Cancel"
  otherwise). Focus lands on the question, never the action; Escape is the way out; it's an
  `alertdialog` named by the question and described by the detail; after the way out focus goes
  back to `returnFocus` (pass the opening button; the step usually replaces it, so the page's new
  one), or else to whatever had focus when the step opened, if it's still there. `disabled`: the
  action can't go ahead now (a stale page), so its button waits while the way out still works.
  `danger`: a danger outline and button. Used for Limits save, Consent & legal save, removing
  staff, and My submissions' Edit.
- `DangerZone`: every delete that can't be undone (DL-1 A as changed, DL-2 A): a red-outlined,
  faintly red box with a warning sign in its title ("Danger zone", "Danger zone (Admins)") and a
  solid danger button with a bin ("Delete"). Pressing it shows a danger `Confirm` in its place
  (`question`, `detail`, `confirmLabel`, `onConfirm`), or the page's own step (`children`, with
  `open`/`onOpenChange`: "Delete my account" asks for a word typed first). Focus comes back to the
  button when the step closes. `disabled` (a stale page, another action running) holds both the
  Delete button and the step's action button. An Admin's Delete in moderation, "Delete my
  account", and Delete on My submissions.
- `Checkbox`: the site's check box (CB-1 A): a 22 px box with the field edge, dark brand when
  ticked, the whole line pressable. `card` puts the line in a pale brand box (the agreement step,
  Share's sharing box; its edge turns danger with `aria-invalid`); `boxAfter` puts the box at the
  line's end (the Themes panel's "★ Highlighted").
- `Switch`: on/off (SW-1 B), only where it acts at once ("Favourites only"). A ✓ in the knob when
  on, the field edge when off. `checked`, `onCheckedChange`, its words as children.
- `Tabs` and `tabId`: underlined tabs (TB-1 A, Consent & legal): one row, two rows of two on
  phones; arrow keys move and choose. The page draws the panel with `aria-labelledby={tabId(…)}`.
- `ChoiceCards`: big radio cards (CB-2 B, Share's Written / Video / Audio), the chosen one with a
  2 px brand edge.
- `SegmentedChoice`: a rounded tray of radios, the chosen one filled (CB-2 B, donate's One-off /
  Monthly; kept, MG-1 B).
- `Disclosure`: an open/close section (DS-1 A+E 4) on the native `<details>`: closed, link
  words with a solid triangle; open, `variant` `short` (default; the content hangs from a grey
  bar: "See all versions", "How to format it") or `long` (words and content in a light panel:
  "Read the full version 3"). `summary` is the words to press.
- `Notice`: something that just happened or needs attention (NT-1 A1): a tinted box, the whole
  box rounded, a 4 px bar on the left and the kind's plain icon. `kind`: `danger` (it went
  wrong), `warning` (needs a second look), `success` (done), `info` (worth knowing); `title`: a
  bold first line. It adds no role: pass `role="alert"` or `role="status"` as the page announces
  it, and for a live region that's in the page before its words, keep the role on a wrapper with
  the Notice inside. `as="p"` for one line; `ref` and `tabIndex={-1}` to move focus to it.
  Not for messages drawn on top of a story's picture or video (a card's "Something went wrong"
  while playing): those keep the media overlay (`media`/`on-media`), since a tinted box over a
  picture would clash. Plain one-line messages inside lists and red error words under a field
  aren't notices either, and neither is a page whose whole content is that the thing isn't here
  ("This draft isn't available", a preview or a story under review that's gone): that is the
  page's state, a plain `Card`. Padding and gap are in px (A1's), so large text grows the
  words, not the space.
- `Quiet`: quiet context that isn't news (NT-2 B): a plain grey box (Share's weekly limit line,
  an empty My submissions).
- `fieldVariants`: the field look, for a control the library doesn't have yet.
- `cn`: class names, with later Tailwind utilities overriding earlier ones.
- `browserThemeColour`: the page background, light and dark, for `theme-color` meta tags.

Keyboard focus is one look on everything pressable (MG-4 A): the site's 2 px outline with a gap
(the theme's `:focus-visible`, or `has-[:focus-visible]:outline-*` on a label round a hidden
input). Text boxes keep their glow.

Pages pass layout classes only (width, margins, padding, grid placement).

## Tests

No unit tests for the components: they are checked through the pages that use them, in
Playwright (`apps/web/e2e`, e.g. `themed-select.e2e.ts`). The lint rules have probes
(`eslint/rules.test.mjs`).
