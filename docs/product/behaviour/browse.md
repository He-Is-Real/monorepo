# Browse and themes

Who: Visitor, Signed-in person, the system.
Data: `docs/db-permissions.md` ("Stories", "Themes").
Next id: REQ-BRW-089

## Contents

- Home
- Browse filters
- Browse layout
- Search
- Themes
- Story pages
- How fresh public pages are

## Home

- **REQ-BRW-002** Home shows the 3 newest stories under "Recently shared". [M1O-A4]
- **REQ-BRW-082** Home shows a row of highlighted themes per category. [D130]
- **REQ-BRW-003** No public page shows story counts: no totals and no counts per theme. [D62]
- **REQ-BRW-087** No public page or public answer shows any count of views, hearts or other engagement, and no public answer gives a total number of stories. [UNTRACED]
- **REQ-BRW-004** Home's impact numbers stay hidden until real figures exist. [UNTRACED]
- **REQ-BRW-005** For 7 days after a story is published, its cards show a "NEW" badge. [D72]
- **REQ-BRW-081** Nothing is stored per person: there is no personalised home and no "New for you". [D72]
- **REQ-BRW-006** When a written card without a picture is too narrow for the "NEW" badge beside the heart (narrow columns with large text), the card's top line moves below the heart and the card grows a little. [J-2026-11-08-BRW]

## Browse filters

- **REQ-BRW-007** The Stories page has a search box, sort, format and theme filters: one format at a time, and themes stacked. [BS-6]
- **REQ-BRW-008** When a Visitor chooses themes, each theme turns on and off on its own and shows ✓ when chosen, and a story shows only if it has every chosen theme. [BS-6]
- **REQ-BRW-009** Once any theme is chosen, a "Clear themes" link appears. [BS-6]
- **REQ-BRW-010** The address repeats `theme` once per chosen theme (`/stories?theme=a&theme=b`): the order does not matter, a repeat counts once, and a link with a single `theme` still works. [BS-6]
- **REQ-BRW-011** A chosen theme that does not exist (deleted, or never existed) filters nothing; the other chosen themes still filter. [UNTRACED]
- **REQ-BRW-012** At most 10 themes filter at once, and the API refuses more. With 10 chosen, another stays unchosen and a note near the themes says "You can choose up to 10 themes.", read out by screen readers, until a theme is taken off. [J-2026-11-21-BRW]
- **REQ-BRW-013** Sort is a set of radio buttons. [J-2026-11-20-BRW]
- **REQ-BRW-015** The search, the sort and every filter stay in the address. [BS-1]
- **REQ-BRW-016** What is chosen (each theme, the format, a sort other than the default, "Favourites only") shows under the search box as chips, each removed with one tap, plus "Clear all", which keeps the search. [BS-1]

## Browse layout

- **REQ-BRW-017** On screens at least 1024 px (64rem) wide whose page content is at least 50rem wide, "Favourites only", sort, format and every theme are a column on the left, and only the search box sits above the stories. [J-2026-11-21-BRWb]
  Example: at the browser's "Very large" or doubled text the content is narrower than 50rem, so the Filters button (REQ-BRW-022) shows instead.
- **REQ-BRW-018** Beside the filters column, the stories take 2 columns until screens of about 1200 px (page content 70rem), then 3, a little narrower than without the column. [BS-5]
- **REQ-BRW-019** From screens of about 1480 px (page content 87.5rem), the filters column and 3 story columns as wide as Home's content are centred together, with the heading lined up with the filters. [UNTRACED]
- **REQ-BRW-020** From screens of about 1760 px (105rem), the search box and 3 story columns are as wide as Home's content and centred on the screen, with the heading lined up with them, and the filters column sits to their left, outside the site's width. [BS-8]
- **REQ-BRW-021** The Stories page's layout widths are in rem, so larger text keeps the narrower layouts. [PR-265]
- **REQ-BRW-022** Where the filters column does not show (below 1024 px, or REQ-BRW-017's example), a "Filters" button beside the search box, with a count of what is on, opens the same filters in a panel (a sheet from the bottom on phones) with "Clear all" and "Show stories". [BS-5]
- **REQ-BRW-023** In the Filters panel each choice applies at once; Escape closes the panel and focus goes back to the "Filters" button. [BS-1]
- **REQ-BRW-024** Without JavaScript, the filters show above the stories at every width, with their own "Show stories" button. [BS-1]
- **REQ-BRW-025** Story grids (the Stories page, with or without "Favourites only") have 3 columns from 1024 px wide screens, 2 from 640 px and 1 below. The count follows the screen's width only: larger text makes cards narrower, never fewer columns, except the 2 columns beside the filters column (REQ-BRW-018). [J-2026-11-08-BRWb]
- **REQ-BRW-027** Cards are laid out in balanced columns at each picture's own shape, limited between tall 9:16 and wide 2:1, and never move once shown. [D55]
- **REQ-BRW-028** As the reader nears the end of the Stories page, more stories load on their own, to the end of the list, which ends with a message. [J-2026-10-31-BRW]
- **REQ-BRW-029** Without JavaScript, the Stories page shows a link to the next page. [UNTRACED]
- **REQ-BRW-030** When a Visitor presses a video or audio card, it plays in place, one card at a time on the page. Nothing ever plays on its own. [J-2026-10-24-BRW]

## Search

- **REQ-BRW-031** Search looks at published stories only. Its "best match" order compares each story only with the other published stories, so drafts and unpublished stories never change a score, the order or where loading more carries on. [J-2026-11-06-BRW]
- **REQ-BRW-033** A story's search words are its title, description, written text and the current names of its themes, all counting equally; category names are not included. [J-2026-11-06-BRWb]
- **REQ-BRW-034** When a theme is renamed or deleted, the search words of the stories that carry it change at once. [J-2026-11-06-BRWb]

## Themes

- **REQ-BRW-035** Themes are grouped in categories that Admins manage (REQ-ADM-021). [D130]
- **REQ-BRW-036** The category "Other" is fixed: it cannot be renamed or deleted. [D130]
- **REQ-BRW-037** A theme with no published stories is hidden. [D63]
- **REQ-BRW-083** The exception: a highlighted theme still shows when it has no published stories. [A14]

## Story pages

- **REQ-BRW-038** A story page shows the player, picture or text, and 3 related stories: shared themes first, then newest. [UNTRACED]
- **REQ-BRW-039** A long written story shows about its first 600 characters with "Continue reading", unless that would hide fewer than 100 characters. [M1O-A1]
- **REQ-BRW-088** A story keeps the date it was first published (its place in newest first) through every later approval or showing again, also after an edit. [R6]
- **REQ-BRW-041** A withdrawn, erased or unknown story, or a legal-text version that does not exist, shows the "not found" page, which tells search engines not to index it ("noindex"). [PC-1]
- **REQ-BRW-042** The "not found" page answers as a found page, not "not found"; only its "noindex" keeps it out of search engines. [PC-1]
- **REQ-BRW-043** The page shown when a page fails to build ("Something went wrong. Please try again later.") or crashes in the browser ("This page stopped working. Reloading it usually fixes this.") tells search engines not to index it and answers as a found page. [PC-3]
- **REQ-BRW-044** Sharing links show the site's brand picture, not the story's. [UNTRACED]
- **REQ-BRW-045** Video, audio and pictures load only through signed links that expire, after 6 to 7 hours on dev. [D64]
- **REQ-BRW-046** The About and Next Steps pages play the founder's videos. [J-2026-10-29-BRW]

## How fresh public pages are

- **REQ-BRW-047** A story that is taken down to edit, deleted, hidden, new or edited can take up to 30 seconds to disappear or appear on a story page. [PC-2]
- **REQ-BRW-048** Browsers and caches between us and the reader never keep a public answer past REQ-BRW-047's 30 seconds, and never keep anything personal. [PC-2]
- **REQ-BRW-050** Pages that change only with a new release (FAQs, Greatest story, Get ready, Contact, Donate) are kept until the next release, in dev and production. [PC-1]
- **REQ-BRW-051** Home, Stories, About, Next steps, Privacy and Terms (and their earlier versions) are not kept in dev and are kept 30 seconds in production. [PC-2]
- **REQ-BRW-052** In production, a story that is taken down can show for up to 60 seconds in total on Home and Stories, and up to 30 seconds on its story page. [PC-2]
- **REQ-BRW-053** Single story pages are never kept. Signed-in, staff, moderation, account, share, consent and sign-in pages can never be kept. [PC-1]
- **REQ-BRW-054** A saved page is never shown after its time, even if making a fresh one fails: the Visitor gets the "try again later" message instead. [PC-1]
- **REQ-BRW-055** A page whose stories or texts could not be read is never saved: the Visitor sees the usual message, and the next visit tries again. [PC-1]
- **REQ-BRW-085** A page whose founder's video could not be read is never saved: the Visitor sees "Video coming soon", and the next visit tries again. [UNTRACED]
- **REQ-BRW-056** Saved pages hold nothing personal (sign-in runs in the browser), and the "noindex" still applies to them. [PC-1]
- **REQ-BRW-057** While the database restarts, public browsing answers from its last answers, kept for 30 minutes, instead of the restarting message, and tells browsers and caches not to keep them. [J-2026-11-07-BRW]
- **REQ-BRW-058** During a database restart, a story deleted in the last 30 minutes can still show; this rare case is accepted. [J-2026-11-07-BRW]
