# Accounts and sign-in

Who: Visitor, Signed-in person, Moderator, Admin, the system.
Data: `docs/db-permissions.md#people-schema-02-peoplesurql`
Next id: REQ-ACC-066

## Contents

- Signing in
- Roles
- Staff
- Block list
- Block list notes
- Blocking at sign-up and at send
- Who sent a story

## Signing in

- **REQ-ACC-001** A Visitor reads, watches and listens to public stories without an account. [UNTRACED]
- **REQ-ACC-002** When a Visitor signs up or signs in, they use Google or their email address; with email they use a one-time code or, if they choose, a password of at least 8 characters checked against known leaked passwords. [D2]
- **REQ-ACC-003** When a person signs in with Google on an email that already has an account, the system joins them to that same account: one account per verified email. [D2]
- **REQ-ACC-004** CAPTCHA and lockout after repeated failed sign-ins are on; two-step sign-in and passkeys are off. [D2]
  Why: two-step sign-in and passkeys need Clerk's paid plan, so turning them on is a cost decision.
- **REQ-ACC-005** Moderators and Admins sign in the same way as everyone else; there is no Google-only sign-in and no two-step verification for staff. [G7]
  Why: staff are protected by the staff email rule, REQ-ACC-015.
- **REQ-ACC-006** When a Visitor signs up, they confirm they are 18 or over only by agreeing to the terms of use; no date of birth is stored, and reading needs no age check. [D77]
- **REQ-ACC-007** Clerk keeps the person's email, name and password; the database keeps only a link to their Clerk account. [D16]
- **REQ-ACC-008** A Signed-in person changes their name, email and password in Clerk's own account panel, opened from My profile; there is no country, display name or notification setting. [D81]
- **REQ-ACC-009** The parts of a page about the Signed-in person (hearts, their stories, their profile) are filled in by the browser, with space kept so nothing jumps; pages for signed-in people need JavaScript. [D83]
- **REQ-ACC-010** When another person signs in on the same browser while a form is open, including in another tab, nothing is saved under the new person's name: the form starts again for them. [UNTRACED]
- **REQ-ACC-011** When a Signed-in person signs out, the system clears what the share page kept in the tab. [UNTRACED]
- **REQ-ACC-012** When an account is deleted, its Clerk sign-in can never create an account again; signing up afresh with the same email makes a new, empty account. [D82]
- **REQ-ACC-056** When the sign-in service says a person's sign-in is over, they are treated as signed out; when the sign-in service does not answer, they are asked to try again later. [DEC-T]

## Roles

- **REQ-ACC-013** The roles, lowest to highest, are Viewer (a Visitor), User, Moderator and Admin; a Signed-in person with no role set is a User. [G8]
- **REQ-ACC-014** A role is set in Clerk on the person's account (`publicMetadata.role`) and travels in their sign-in token, which api-admin reads on every request. [G8]
- **REQ-ACC-015** A Moderator or Admin role counts only while the sign-in token also carries a verified `@heisreal.today` email as the account's primary email; otherwise the person is a User in api-admin, api-user and the site's staff menu. [S-5]
- **REQ-ACC-016** When the `@heisreal.today` email is taken off a staff account, the person loses staff powers at the next sign-in token, within about a minute. [S-5]
- **REQ-ACC-017** A User shares stories, hearts stories and manages their own account. [G24]
- **REQ-ACC-018** A Moderator works the moderators' list (every story not on the site, except drafts never sent): approve, send back, reject, take down and show again. [G24]
- **REQ-ACC-019** An Admin does everything a Moderator does, plus drafts never sent on the moderators' list, deleting a story, themes, submission limits, legal texts, "approve anyway", the block list and the Staff page. [G24]

## Staff

- **REQ-ACC-020** On the Staff page (`/admin/staff`), an Admin adds, changes and removes Moderators and Admins. [S-1]
- **REQ-ACC-059** Only Admins can see or change the staff list. [S-1]
- **REQ-ACC-021** Only `@heisreal.today` emails can be staff. [G7]
- **REQ-ACC-057** The staff list holds, for each staff member, their work email (only addresses at heisreal.today), their role (Moderator or Admin), who added them and when. [S-1]
- **REQ-ACC-058** Who added a staff member, and when, is recorded once, as the adding Admin's email, and a change of role keeps it. [S-6]
- **REQ-ACC-065** On the Staff page, a baseline admin the system added itself reads "Added by the deploy" with the day it was added. [PR-214]
- **REQ-ACC-022** When an Admin adds or changes someone who has no account with that email, the page refuses with "Ask them to create an account first, then add them."; there are no invitations. [S-7]
- **REQ-ACC-023** When an Admin removes a listed person who has no account, the system only takes them off the staff list. [S-7]
- **REQ-ACC-024** When an Admin saves a staff change, the system writes the role to Clerk first, then to the staff list in the database; it takes effect within about a minute, the sign-in token's lifetime. [S-1]
- **REQ-ACC-025** When an Admin removes or demotes the last Admin, the system refuses: there is always at least one Admin. [S-1]
- **REQ-ACC-060** When two Admins remove or demote each other at the same moment and no other Admin would be left, the second change is refused. [S-1]
- **REQ-ACC-026** When Clerk fails, or can't be confirmed to agree with the staff list after a save, the page says it couldn't save; saving that person again puts Clerk and the list back in step. [S-1]
- **REQ-ACC-027** Each time api-admin starts (every deploy, and after it has been idle), it makes each baseline admin (`info@heisreal.today`, `joel@heisreal.today`) an Admin on the staff list, adding them back if missing, and in Clerk where an account has that email. [S-6]
- **REQ-ACC-028** When a baseline admin has no account yet, api-admin logs it and gives them the role at a later start once they have signed up; start-up never fails over it and never removes anyone. [S-6]
- **REQ-ACC-029** When an Admin removes a baseline admin on the Staff page, it lasts only until api-admin next starts, and the page says so. [S-6]

## Block list

- **REQ-ACC-030** On the Block list page (`/admin/block-list`), an Admin keeps a list of blocked email addresses and IP addresses in plain text; only Admins read or change it, never Moderators. [G21]
- **REQ-ACC-031** A blocked email can't create an account or send a story; a blocked IP address can't send a story. Reading the site is never blocked. [G21]
- **REQ-ACC-032** A block stays until an Admin removes it, even after the person deletes their account. [G21]
- **REQ-ACC-033** Each block list entry keeps which Admin added it and when. [G21]

## Block list notes

- **REQ-ACC-034** Under the email or address box is a "Why is it blocked?" box with the grey suggestion "Note the reason, so other Admins know why." [BN-1]
- **REQ-ACC-035** Under the note box is the hint "Only Admins see this note. Write only what explains the block, as if the person could read it. Don't copy their story." [BN-6]
- **REQ-ACC-036** The note is optional, plain text, at most 500 characters and trimmed; blank, or only spaces, is no note. [BN-2]
- **REQ-ACC-037** Each entry shows its note in full on its own line, on every screen, or "No note yet" when it has none. [BN-3]
- **REQ-ACC-038** Any Admin can change a note later (Edit note, then Save or Cancel); a blank note clears it, the later save wins, and who edited it isn't recorded. [BN-4]
- **REQ-ACC-061** Once a block list entry is added, its blocked email or address, who added it and when never change; only its note can be edited. [BN-4]
- **REQ-ACC-039** When an Admin blocks something already on the list, the entry keeps its first note. [UNTRACED]
- **REQ-ACC-040** Only Admins read a note: api-user's block check never sees it, and it goes when its entry is removed. [BN-6]

## Blocking at sign-up and at send

- **REQ-ACC-041** When api-user first sees a new Clerk account (its first call, which makes the person's database record) and the token's verified email is blocked, no record is made and every call is refused. [G21]
- **REQ-ACC-042** When an email is blocked after its account exists, the account stays: the person can read, edit, delete and download their things but can't send a story. Clerk still lets them sign in. [G21]
- **REQ-ACC-043** When a Signed-in person sends a story and the token's verified email or the request's IP address is blocked, api-user refuses it and the person sees only "Something went wrong. Please try again later." [G21]
- **REQ-ACC-044** The block check runs just before the story is written, after the file checks at Bunny, so a block added meanwhile counts; a retry of a send that already went through (same Idempotency-Key) still gets its success back. [G21]
- **REQ-ACC-062** When the system checks the block list at sign-up or at send, it can only ask whether one given email or address is blocked; it never lists the entries. [G21]

## Who sent a story

- **REQ-ACC-045** When a story is sent, api-user keeps the IP address it came from on the story's "sent" status entry, so an Admin can block a recent abuser's address. [G21]
- **REQ-ACC-063** The IP address a story was sent from is kept only on that send, never on any other step of the story's history. [G21]
- **REQ-ACC-046** While the address is kept, an Admin sees it on the story's moderation view, with a link that fills it in on the Block list page; Moderators never see it, and no other staff page shows it. [G21]
- **REQ-ACC-047** The address is the last entry of `X-Forwarded-For`, the one Google's front end appends; earlier entries come from the client and can say anything. [G21]
  Why: api-user runs on Cloud Run with no load balancer, so only Google's own entry can be trusted.
- **REQ-ACC-048** IP addresses are compared exactly, in one form: IPv6 short and lower-case. [G21]
- **REQ-ACC-049** When a story is sent, api-user keeps on the same "sent" entry the email it was sent with: the sign-in token's verified email, the one the block check uses, never anything the browser sends. [EM-1]
- **REQ-ACC-064** The email a story was sent with is kept only on that send, never on any other step of the story's history. [EM-1]
- **REQ-ACC-050** An Admin sees that email on the moderation view next to the address; Moderators never do. [EM-1]
- **REQ-ACC-051** Next to "Sent with email …" and "Sent from IP address …" an Admin has a Block button; without leaving the page it asks "Block …? It stays until an Admin removes it." with the note box, then Block / Cancel. [EM-2]
- **REQ-ACC-052** That note box starts with the story's title and the day it was sent, `Story "…" (sent <day> <month> <year>): `, with the cursor at the end; the Admin can clear it. [BN-7]
- **REQ-ACC-053** After Block, the system adds the email or address to the block list with that note, and the line says "Blocked", as it does whenever the page opens on one already blocked. [EM-2]
- **REQ-ACC-054** Once the address is cleared, only the email shows. [EM-2]
- **REQ-ACC-055** When Block fails on the moderation view, the Admin sees the generic error message. [EM-2]
