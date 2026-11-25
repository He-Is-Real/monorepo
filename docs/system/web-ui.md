# Web UI library

Who: the people who build pages in `apps/web` and pieces in `libs/web-ui`. Data: none; `libs/web-ui/README.md` lists the pieces.
Next id: REQ-WEB-042

## Contents

- The library
- Which piece for what
- Colours
- Text
- Looks of shared pieces

## The library

- **REQ-WEB-001** The website's building blocks live in one library, `libs/web-ui` (`@heisreal/web-ui`), and pages use its pieces instead of their own styled copies. [J-2026-11-17-WEB]
- **REQ-WEB-002** The library also holds the theme (colours light and dark, font, radii, widths, base styles and shared CSS, in `libs/web-ui/src/styles/theme.css`) and the lint checks (`@heisreal/web-ui/eslint`). [LB-1]
  Why: another website then gets the whole look from one stylesheet import and one lint config.
- **REQ-WEB-003** Pages add layout classes only: width, margins, padding, grid placement. [WL-1]
- **REQ-WEB-004** When building or changing UI, a builder first uses the library's pieces and colours as they are. [TX-7]
- **REQ-WEB-005** When no piece quite fits, a builder adjusts the design to use a common existing piece, accepting a small compromise, before adding anything new. [TX-7]
- **REQ-WEB-006** When no existing piece can do the job, a builder adds a new piece to `libs/web-ui`, never a page-local styled copy. [TX-7]
- **REQ-WEB-007** Styling in `apps/web` page code is the last resort, and the pull request says why. [TX-7]

## Which piece for what

- **REQ-WEB-008** Every drop-down is the library's `Select`. [J-2026-11-17-WEB]
- **REQ-WEB-040** Closed, a `Select` shows the theme's field and chevron; opened on a computer (a mouse or trackpad), it shows the site's themed list in every browser. [J-2026-11-17-WEB]
- **REQ-WEB-041** On phones and tablets, and before the page's JavaScript runs or without it, a `Select` is a native drop-down (the phone's own picker), so forms still work. [J-2026-11-17-WEB]
- **REQ-WEB-009** Text boxes are `Input`, text areas `Textarea`, and the label, hint and error under a field are its `Field` parts. [WL-1]
- **REQ-WEB-010** Bordered panels are `Card`, pop-up menu panels `PopoverPanel`, and buttons whose words may wrap `Button wrap`. [WL-1]
- **REQ-WEB-011** Search boxes are `SearchBox`, with a magnifier button inside. [BS-2]
- **REQ-WEB-012** Radio buttons are `RadioGroup`. [J-2026-11-20-WEB]
- **REQ-WEB-013** Each of these has one look, as a library piece: the pressable `Chip` (✓ when chosen), the grey `Tag`, the `StatusBadge` (a dot and a word coloured by meaning), the `Confirm` step and the `DangerZone`. [WL-2]
- **REQ-WEB-014** These too are library pieces with one look each: the `Checkbox`, the `Switch`, the `Tabs`, the `Disclosure`, the plain grey `Quiet` box and a `Button`'s greyed-out reason. [WL-2]
- **REQ-WEB-015** Share's format cards are `ChoiceCards`, and Donate's One-off / Monthly switcher is `SegmentedChoice`. [WL-2]
- **REQ-WEB-016** Text boxes come in two sizes: `compact` beside drop-downs, `standard` wherever people type. [WL-2]
- **REQ-WEB-017** A notice is the library's `Notice`, in four kinds: `danger`, `warning`, `success`, `info`. [NT-1]
- **REQ-WEB-018** Every dialog is the library's `Dialog`, in the Stories Filters panel's look: a bottom sheet on phones, a centred box wider, a title bar with ×. [MG-3]
  Example: the Stories Filters panel and the Admin themes dialogs.
- **REQ-WEB-019** Dialog backdrops use the `overlay` colour. [WL-2]
- **REQ-WEB-020** The FAQ page's questions are the library's `Accordion`: bordered question boxes with a chevron. [MG-2]
- **REQ-WEB-021** Donate keeps its One-off / Monthly tray, the `SegmentedChoice`. [MG-1]

## Colours

- **REQ-WEB-022** Every colour is named by its meaning (`danger`, `warning`, `success`, `info`, `brand`, `media` and the rest in `libs/web-ui/README.md`), and pages use only those names. [OT-1]
- **REQ-WEB-023** Lint refuses a hex, `rgb()` or Tailwind palette colour in page code, except a colour a third party sets. [OT-1]
  Example: the share menu's network logos.
- **REQ-WEB-024** There is one red, moderation's checked one, in light and dark: the library's `danger` button and every red word use it. [OT-1]
- **REQ-WEB-025** Moderation's Send back is the library's `caution` button, in the warning amber. [OT-1]

## Text

- **REQ-WEB-026** Headings, text and links are the library's `Heading`, `Text`, `Quote` and `TextLink`. [TX-7]
- **REQ-WEB-027** Lint refuses text colours, sizes, weights, line heights, letter spacing, capitals and italics in page code. [TX-7]
- **REQ-WEB-028** Quieter text has one grey. [TX-1]
- **REQ-WEB-029** Every page title is one size (32 px, 44 px wider); Home and Greatest Story use one hero size. [TX-2]
- **REQ-WEB-030** A section heading has one look everywhere: 24 px, 28 px wider, normal weight. [TX-3]
- **REQ-WEB-031** A heading inside a panel or dialog is the 18 px semibold sub-heading. [TX-3]
- **REQ-WEB-032** Intros and a story's text are 18 px. [TX-4]
- **REQ-WEB-033** Small text is 14 px; card paragraphs are normal 16 px text. [TX-5]
- **REQ-WEB-034** A link inside a sentence is always underlined; a link on its own is semibold, underlined on hover, and 44 px to press. [TX-6]
- **REQ-WEB-035** The pull quotes share one look, a brand bar and 22 px italic; "In their words" is a teal eyebrow heading; story cards' "NEW" pill keeps its own look. [TX-6]
- **REQ-WEB-036** Italic is for quotes, speech and subtle hints only: the pull quotes, and `Text italic` for lines such as Greatest Story's prayer lines and the block list's "No note yet". [TX-8]
  Example: moderation history's quoted note to the person, and the thumbnail crop's spoken line.

## Looks of shared pieces

- **REQ-WEB-037** Radio dots are the check box's 22 px. [MG-4]
- **REQ-WEB-038** Every pressable piece shows the same keyboard outline; text boxes keep their glow. [MG-4]
- **REQ-WEB-039** A field label has one look: semibold. [MG-5]
