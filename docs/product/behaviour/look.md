# How the site looks

Who: Visitor, Signed-in person, Moderator, Admin.
Data: none.
Next id: REQ-LOOK-047

## Every page

- **REQ-LOOK-036** Every page works from 320 px phones to large desktops, in light or dark (following the device, with a switch), with text enlarged to 200%. [J-2026-10-21-BRW]
- **REQ-LOOK-037** Body text sits in a reading column of at most about 80 characters a line. [R1]
- **REQ-LOOK-038** A page laid out in columns may be wider than the site's 1200 px content width, as long as no single column is wider than 1200 px. [J-2026-11-17-BRW]
- **REQ-LOOK-039** In the header at 1280 px and wider with large text, the main links wrap onto more lines instead of running over the logo. [PR-257]

## Pieces

- **REQ-LOOK-001** Closed, a drop-down shows the site's field and chevron; opened on a computer (a mouse or trackpad), it shows the site's own list. [U3]
- **REQ-LOOK-035** On a computer the site's own open list shows in every browser. [UNTRACED]
- **REQ-LOOK-002** On phones and tablets, and before the page's scripts run or without them, a drop-down is the device's own picker, so forms still work. [UNTRACED]
- **REQ-LOOK-003** Every search box has a magnifier button inside it, and Enter searches too. [UNTRACED]
- **REQ-LOOK-004** Every chip a person presses has one look, the browse chip's, with a tick when chosen. [CH-1]
- **REQ-LOOK-005** A label that only says something is a grey tag; a story's status is a dot and a word, coloured by meaning. [CH-2]
- **REQ-LOOK-006** A story card's "NEW" pill has its own look, not the grey tag's. [UNTRACED]
- **REQ-LOOK-044** Every button, and every link that looks like one, is 44 px tall (48 px for the home page's large calls to action), with semibold words, the site's keyboard outline and 8 px corners. [BT-1]
- **REQ-LOOK-007** Every "Are you sure?" step has one look, in place of the button that opened it: a bold question, what will happen, the action button named for what it does and the way out, side by side, stacked full width on phones. [CD-1]
  Example: saving the submission limits, removing a staff member, Delete on My submissions.
- **REQ-LOOK-040** The way out of an "Are you sure?" step says "Keep it" when deleting and "Cancel" for saves and edits. [CD-2]
- **REQ-LOOK-041** When an "Are you sure?" step opens, keyboard focus lands on the question, never on the action button, so a second Enter does nothing; Escape means no and puts focus back on the button that opened it. Screen readers hear it as an alert dialog named by the question. [CD-1]
- **REQ-LOOK-008** Every delete for good (an Admin's Delete on the moderation review page, "Delete my account" on Your data, Delete on My submissions) sits in a red-outlined "Danger zone" box with a warning sign, one look everywhere. [DL-2]
- **REQ-LOOK-042** A delete-for-good button is solid danger red with a bin icon and says "Delete", or "Delete my account". Reject stays a plain red button among the moderation decisions. [DL-1]
- **REQ-LOOK-009** Every open/close section has one look: closed, it is link-coloured underlined words after a small triangle that turns down when open. Open, a short helper hangs from a grey bar on its left, and long reading sits in a light panel with a fine edge. [DS-1]
  Example: "See all versions" and "How to format it" are short helpers; "Read the full version 3" is long reading.
- **REQ-LOOK-043** Open/close sections are the browser's own open/close element: they work before the page's JavaScript loads, and Enter or Space opens and closes them. [DS-1]
- **REQ-LOOK-010** Every check box has one look: one 22 px box, and pressing its words ticks it too. [CB-1]
- **REQ-LOOK-011** Every switch has one look, its knob showing a ✓ when on, and is used only where pressing it changes the page at once ("Favourites only" on Stories). A choice saved later is a check box ("★ Highlighted" in the Themes panel). [SW-1]
- **REQ-LOOK-012** Every set of tabs is underlined tabs. [TB-1]
- **REQ-LOOK-013** A message that is not news (the weekly limit line, an empty list) sits in a plain grey box, not a notice. [NT-2]
- **REQ-LOOK-014** Where the page knows why, a greyed-out button says so in a short line of its own underneath. [OT-2]
  Example: "Write a reason first." under Take down before a reason is typed; "Write a note first." for Send back and Reject.
- **REQ-LOOK-015** Text boxes come in two sizes: a compact one beside drop-downs, a standard one wherever people type. [TF-1]
- **REQ-LOOK-016** A notice comes in four kinds by meaning: danger, something went wrong (red); warning, needs a second look (amber); success, done (green); information, worth knowing (teal). [NT-1]
- **REQ-LOOK-045** A notice (something happened or needs attention) is a tinted box with a coloured bar on the left and its kind's icon, with an optional bold first line ("What our team said"). [NT-1]
- **REQ-LOOK-046** Screen readers hear an error notice at once and any other notice when the screen reader is free. [NT-1]
- **REQ-LOOK-017** Every dialog has the Stories Filters panel's look: a bottom sheet on phones, a centred box on wider screens, a title bar with ×. [MG-3]
  Example: the Stories Filters panel and the Admin themes dialogs.
- **REQ-LOOK-018** The FAQ page's questions are bordered boxes with a chevron. [MG-2]
- **REQ-LOOK-019** Donate has a One-off / Monthly tray. [MG-1]

## Colours

- **REQ-LOOK-020** There is one red, the one checked for moderation, in light and dark: the danger button and every red word use it. [OT-1]
- **REQ-LOOK-021** Moderation's Send back button is the warning amber. [OT-1]

## Text

- **REQ-LOOK-022** Quieter text has one grey. [TX-1]
- **REQ-LOOK-023** Every page title is one size (32 px, 44 px wider); Home and Greatest Story use one hero size. [TX-2]
- **REQ-LOOK-024** A section heading has one look everywhere: 24 px, 28 px wider, normal weight. [TX-3]
- **REQ-LOOK-025** A heading inside a panel or dialog is the 18 px semibold sub-heading. [TX-3]
- **REQ-LOOK-026** Intros and a story's text are 18 px. [TX-4]
- **REQ-LOOK-027** Small text is 14 px; card paragraphs are normal 16 px text. [TX-5]
- **REQ-LOOK-028** A link inside a sentence is always underlined; a link on its own is semibold, underlined on hover, and 44 px to press. [TX-6]
- **REQ-LOOK-029** The pull quotes share one look, a brand bar and 22 px italic. [TX-8]
- **REQ-LOOK-030** "In their words" is a heading, not a link: the teal eyebrow heading. [TX-6]
- **REQ-LOOK-031** Italic is for quotes, speech and subtle hints only: the pull quotes, and lines such as Greatest Story's prayer lines and the block list's "No note yet". [TX-8]
  Example: moderation history's quoted note to the person, and the thumbnail crop's spoken line.

## Looks of shared pieces

- **REQ-LOOK-032** Radio dots are the check box's 22 px. [MG-4]
- **REQ-LOOK-033** Every pressable piece shows the same keyboard outline; text boxes keep their glow. [MG-4]
- **REQ-LOOK-034** A field label has one look: semibold. [MG-5]
