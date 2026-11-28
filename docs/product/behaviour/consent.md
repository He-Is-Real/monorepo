# Consent, privacy and terms

Who: Visitor, Signed-in person, Admin, the system.
Data: `docs/db-permissions.md#legal-texts-and-agreements-schema-05-legal-textssurql-plan-4e`
Next id: REQ-CON-048

## The four texts

- **REQ-CON-001** There are four texts: the terms of use (which include being 18 or over), the testimony consent (keeping and publishing a person's stories, special-category data under GDPR Article 9), the social media sharing consent (per story, optional) and the privacy notice. [J-2026-11-01-CON]
- **REQ-CON-002** Each text has numbered versions from 0; a saved version can never be changed or deleted. [J-2026-11-01-CON]
- **REQ-CON-044** Each version of a text keeps its full text and when it was published. [J-2026-11-01-DB]
- **REQ-CON-047** Visitors and Signed-in people never see which Admin published a version of a text. [PR-182]
- **REQ-CON-045** Everyone, signed in or not, can read every version of each text; only an Admin publishes a new version, and it always takes the next number. [J-2026-11-01-DB]
- **REQ-CON-003** Version 0 of each text is a draft written from how the system works today, marked "Draft, to be reviewed before go-live". [J-2026-11-01-CON]
- **REQ-CON-004** The testimony consent and the privacy notice say who sees a story before it is public: while it is a draft, the person and a small number of admins (for support and safety); while it is waiting for review, the person and our moderators. [J-2026-11-05-CON]
- **REQ-CON-005** The terms of use (section 5) say we may permanently block the email and IP addresses of someone who breaks them. [LT-1]
- **REQ-CON-006** The testimony consent says we may use automated tools, including AI, for transcripts, captions and summaries. [G18]
- **REQ-CON-007** The privacy notice lists the address a story was sent from (30 days) and the block list under what we collect, how long we keep them and our legitimate interest, and AI tools under where it's stored. [LT-1]
- **REQ-CON-008** The privacy notice lists the email each story is sent with under what we collect, our legitimate interest and how long we keep it (as long as the story). [EM-1]
- **REQ-CON-009** The privacy notice's block list line under what we collect includes "and a short note on why". [BN-6]
- **REQ-CON-010** The privacy notice is written to the people who use the site and doesn't cover staff, so staff members' emails on their actions aren't in it. [EM-1]

## Agreeing

- **REQ-CON-011** When a Visitor signs up, they tick one box: "I am 18 or over and agree to the terms of use". [J-2026-11-01-CON]
- **REQ-CON-012** Before their first story, a Signed-in person agrees to the testimony consent, once for their account; agreeing to a newer version covers their earlier stories too. [D85]
- **REQ-CON-013** At the end of sharing a story, an optional, unticked box lets us share that story on social media, naming every platform; it is chosen per story. [J-2026-11-01-CON]
- **REQ-CON-015** The privacy notice is shown and linked next to every box. [J-2026-11-01-CON]
- **REQ-CON-038** Nobody ticks a box for the privacy notice. [J-2026-11-01-CON]
- **REQ-CON-039** Nobody is recorded as having read the privacy notice. [PCA-P1]
- **REQ-CON-040** The privacy notice is called "privacy notice" everywhere. [J-2026-11-01-CON]
- **REQ-CON-016** Boxes are never ticked in advance. [J-2026-11-01-CON]
- **REQ-CON-017** The database refuses to start, edit, upload or submit a story until the person has agreed to the latest terms of use and testimony consent, and refuses a heart until they have agreed to the latest terms of use. [J-2026-11-01-CON]
- **REQ-CON-018** A person can agree only to the latest version, and only to the version the page showed them; the time recorded is the database's. [J-2026-11-01-CON]
- **REQ-CON-041** When a person agrees again to a version they have already agreed to, nothing changes. [J-2026-11-01-DB]
- **REQ-CON-042** Nobody can agree or consent on another person's behalf. [J-2026-11-01-DB]
- **REQ-CON-019** Withdrawing their own story (pressing Edit, which takes it down) or deleting it never needs a new agreement. [J-2026-11-01-CON]
- **REQ-CON-020** Nothing is shared beyond heisreal.today until the story is public there. [J-2026-11-01-CON]
- **REQ-CON-021** Agreeing to the testimony consent doesn't waive the person's right to object to how their story is edited or presented. [J-2026-11-01-CON]
- **REQ-CON-022** Deleting the account withdraws everything; deleting a story withdraws consent for that story, and taking it down to edit stops its use until it is approved again. There is no other withdrawal. [J-2026-11-01-CON]
- **REQ-CON-043** Deleting the account never needs an agreement. [J-2026-11-01-DB]

## When a text changes

- **REQ-CON-023** When a text changes, the person sees what changed (the old words struck through, the new ones marked) and the full text, and agrees again before carrying on. [J-2026-11-01-CON]
- **REQ-CON-024** When the testimony consent changes, a banner after sign-in asks the person to agree again; it never shows on the share page, which asks within the flow, and "Not now" hides it for that page only. [J-2026-11-01-CON]
- **REQ-CON-025** When an upload is refused because the person hasn't agreed to the latest text, the same agree-again screen opens, and the upload carries on once they agree. [J-2026-11-01-UPL]
- **REQ-CON-027** When the sharing text changes while someone is submitting, the submit is refused, the draft is kept, and they see the new text and decide again. [J-2026-11-01-CON]
- **REQ-CON-028** Published stories stay up when a text changes. [J-2026-11-01-CON]

## Consent texts page

- **REQ-CON-029** On the consent texts page an Admin publishes a new version of any of the four texts: a text box, the changes against the current version, a preview, then confirm. [J-2026-11-01-CON]
- **REQ-CON-030** A saved version is in force at once. [PCA-P6]
- **REQ-CON-031** From 1280 px wide, the editor below the page's header is twice the standard content width, so the text box and the preview side by side each get up to the standard width; narrower screens keep the standard column. [J-2026-11-14-CON]
- **REQ-CON-032** From 768 px wide the text box grows to its whole text, so it never scrolls inside and the page scrolls instead; on phones it is a 20-line box that scrolls inside. [J-2026-11-17-CON]
- **REQ-CON-033** The texts are picked with underlined tabs, each giving its current version and the date it came into force ("v0 · 14 Nov"): one row from 768 px, two rows of two on phones. [CS-1]
- **REQ-CON-034** The chosen text is in the page's address (`?text=privacy-notice`), so a link opens it and Back returns to the one before. [CS-1]

## Cookies and contact

- **REQ-CON-035** The site uses only essential cookies and storage (sign-in, the light or dark choice, the video player's own settings), so there is no cookie banner, only a footer note linking to the privacy notice. [UNTRACED]
- **REQ-CON-036** Anything non-essential (for example analytics or error replay) needs the Visitor's opt-in first. [UNTRACED]
- **REQ-CON-037** Contact is an email link (info@heisreal.today), not a form, until emails exist. [UNTRACED]
