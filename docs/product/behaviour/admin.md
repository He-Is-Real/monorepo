# Admin pages

Who: Moderator, Admin, Visitor and Signed-in person (the navigation link, reading themes, and their own limits).
Data: `docs/db-permissions.md` ("Themes", "Settings and limits").
Next id: REQ-ADM-044

## Header and navigation

- **REQ-ADM-001** On every admin and moderation page, the staff menu, the page's title and its description are centred in the site's 1200 px container, so they stay in the same place when switching pages, on every screen size. [OQ-4]
- **REQ-ADM-002** In the staff menu, the current page is bold with a teal line under it, like the site navigation's current page. [J-2026-11-21-ADM]
- **REQ-ADM-003** Below the header, each admin page's content keeps its own width, centred: 800 px for Staff, Themes, Block list and a story under review; 1200 px for Limits; wider on big screens for Consent texts and the moderation list, with no single column over 1200 px. [OQ-4]
- **REQ-ADM-004** Text inside cards and tables on admin pages stays left-aligned. [OQ-4]
- **REQ-ADM-005** Admin and moderation pages always keep room for the scrollbar, so a page that scrolls does not shift sideways from one that does not. [J-2026-11-17-ADM]
- **REQ-ADM-006** A story's review page has the staff menu in the same place but no page title or description: its heading is the story's own title, inside the story exactly as the public will see it. [OQ-3]
- **REQ-ADM-007** Moderators and Admins see one more link, "Admin", after the public links in the site's navigation, in the same row and style with no divider, so their header is the same height as everyone else's. [J-2026-11-20-ADM]
- **REQ-ADM-008** Only where the row has no room (very large text) does the "Admin" link wrap under the other links. [J-2026-11-20-ADM]
- **REQ-ADM-032** From 1280 px the account area is a little narrower so the "Admin" link fits the row. [PR-252]
- **REQ-ADM-009** In the phone menu, the "Admin" link comes after a gap and a line. [PR-227]
- **REQ-ADM-010** The "Admin" link shows as the current page on the admin landing page and on every admin and moderation page. [J-2026-11-20-ADM]
- **REQ-ADM-011** Visitors and Signed-in people without a staff role never see the "Admin" link, and nobody sees it until api-user has said their role, so no link flashes. [J-2026-11-14-ADM]
- **REQ-ADM-012** The "Admin" link reflects the role when the page was loaded; after a role change it updates on the next full page load or sign-in. [PR-227]

## Admin landing page

- **REQ-ADM-013** The admin landing page (`/admin`, where the "Admin" link leads) shows the shared admin header with the staff menu for the person's role, no page in it chosen, the title "Admin", a one-line description, and nothing else. [J-2026-11-20-ADM]
  Example: a Moderator's staff menu shows Moderation; an Admin's shows every staff page.
- **REQ-ADM-014** When anyone other than a Moderator or an Admin opens `/admin`, they get the same refusal as on the moderation pages. [J-2026-11-20-ADM]

## Limits

- **REQ-ADM-015** The Limits page (Admins) shows the submission limits in plain words with their units, and the two deletion times: rejected stories and stories left in editing. [G3]
- **REQ-ADM-033** The Limits page shows the largest picture file in KB (1 KB = 1,024 bytes) under "Pictures". [J-2026-11-20-ADMb]
- **REQ-ADM-043** On the Limits page an Admin sets the largest upload allowed, up to 10 GB for a video, 2 GB for an audio file and 3 hours long. [BE-14]
- **REQ-ADM-016** The Limits page shows one group at a time, picked from a side list, or from a "Group" drop-down on phones. [J-2026-11-17-ADMb]
- **REQ-ADM-017** On the Limits page a changed box is outlined in teal, and a save bar lists every unsaved change with Undo and Save. [J-2026-11-17-ADMb]
- **REQ-ADM-018** When an Admin presses Save on the Limits page, it lists the changes and asks to confirm. [UNTRACED]
- **REQ-ADM-019** When another Admin saved the limits meanwhile, the Limits page asks to reload. [D29]
- **REQ-ADM-020** The limits keep the name and role of the Admin who changed them last; there is no history of changes. [DB2-R3]
- **REQ-ADM-038** Everyone can read the submission limits; only Admins change them, nobody can delete them, and a minimum can never be set above its maximum. [J-2026-10-28-DB]
- **REQ-ADM-040** A person can see their own limits; only Admins set a person's limits or trusted mark, every change (a reset too) records the Admin, and the limits go only when the account is deleted; there is no admin page for setting a person's own limits. [D112]

## Themes page

- **REQ-ADM-021** The Themes page (Admins) shows categories and themes on one page, moved by dragging on desktop and by tap or keyboard on phones, with one Save for the whole picture. [D130]
- **REQ-ADM-034** Everyone can read the themes and their categories; only Admins change them. [J-2026-10-31-DB]
- **REQ-ADM-022** A delete on the Themes page is confirmed by typing "delete <name>". [A10]
- **REQ-ADM-035** When a theme is deleted, stories lose it without their owners being asked; a story left with fewer themes than the minimum is checked only when it is next sent. [A9]
- **REQ-ADM-036** When an Admin renames a theme, every story carrying it shows the new name; when an Admin deletes a theme, it comes off every story in the same save. [D15]
- **REQ-ADM-024** When someone else saved the themes meanwhile, the Themes page says "Someone else changed themes. Reload to see their changes", and nothing the second Admin changed is saved. [A2]
- **REQ-ADM-025** Theme and category names are tidied (trimmed, single spaces, capital first letter), and a duplicate name is refused. [A4]
- **REQ-ADM-026** Deleting a category moves its themes to "Other", not highlighted. [D130]

## Other admin views

- **REQ-ADM-027** The database can list the stories hidden because their media broke or changed; there is no admin page for it. [UNTRACED]
- **REQ-ADM-028** Admins can read every story in every status, drafts included, with each story's status log and files, through api-admin; there is no admin page for it. [R15]
- **REQ-ADM-030** Before an Admin removes someone on the Staff page, the page asks "Remove …? They become a User.". [UNTRACED]
- **REQ-ADM-031** The Block list page (Admins) lists blocked emails and IP addresses newest first, each with its note (or "No note yet"), who blocked it and when. [BN-2]
- **REQ-ADM-041** When an Admin publishes a new version of a legal text and another version was published since they opened the page, the save is refused and they are told the text changed. [J-2026-11-01-DB]
