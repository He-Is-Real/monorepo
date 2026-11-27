# Data kept and deleted

Who: the system, Admin.
Data: `docs/db-permissions.md#person-linked-tables`, `docs/db-permissions.md#erasure`
Next id: REQ-DAT-029

## Stories

- **REQ-DAT-001** When a draft (a story never sent for review) has had no edit and no resumed upload for 186 days, the nightly clean-up deletes it with its files. [D71]
- **REQ-DAT-003** Before the nightly clean-up deletes a draft, the person gets an emailed warning. (planned) [J-2026-10-30-DAT]
- **REQ-DAT-004** When a story has been rejected for 90 days, the nightly clean-up deletes it with its files. [G3]
- **REQ-DAT-024** Until the nightly clean-up deletes a rejected story, the person can read the Moderator's note and download the story with their data. [G3]
- **REQ-DAT-005** When a story sent at least once (sent back, or taken down with Edit) is left in editing untouched for 186 days, the nightly clean-up deletes it with its files. [G3]
- **REQ-DAT-006** For REQ-DAT-005, the last edit, a resumed upload, being sent back and being taken down each count as a touch. [G3]
- **REQ-DAT-007** On the Limits page an Admin sets the rejected time and the editing time, each 7 to 3,650 days; a change moves every story's deletion date at once. [G3]
- **REQ-DAT-008** The nightly clean-up never deletes a story that is waiting for review, published or hidden. [G3]
- **REQ-DAT-009** My submissions shows the deletion date on each rejected story, as it does for drafts and stories left in editing. [G3]

## Files, records and logs

- **REQ-DAT-010** The nightly clean-up runs at 03:30 London time. [PR-141]
- **REQ-DAT-011** When a video at Bunny is older than 48 hours and no story uses it, the nightly clean-up deletes it. [J-2026-10-30-DAT]
- **REQ-DAT-025** The clean-up of leftover videos deletes at most 50 of each kind a night. [PR-141]
- **REQ-DAT-012** On dev, the clean-up of leftover videos only reports what it would delete. [PR-141]
- **REQ-DAT-013** When deleting an account's files at Bunny fails, the system retries it. [D40]
- **REQ-DAT-026** When deleting an account's Clerk account fails, the system retries it. [D39]
- **REQ-DAT-014** The record of what a person submitted, for the weekly limit, is kept 7 days and deleted with the account. [D113]
- **REQ-DAT-027** Upload records stay when a story is deleted, so the upload limits still count them. [R12]
- **REQ-DAT-015** Request keys (which stop a resent request being applied twice) expire 24 hours after the request, and the nightly clean-up deletes expired ones. [R4]
- **REQ-DAT-016** The IP address a story was sent from is cleared by the nightly clean-up 30 days after it was sent, keeping the status entry, and goes with the story. [G21]
- **REQ-DAT-017** The email a story was sent with is kept as long as the story and goes with the story or with the account. [EM-1]
- **REQ-DAT-018** A block list entry is kept until an Admin removes it, even after the person deletes their account. [G21]
- **REQ-DAT-019** Backups age out; they are never edited after a deletion, and restoring one replays the erasures logged since it was taken (`docs/restore-runbook.md`). [D40]
- **REQ-DAT-028** Backups are taken nightly and kept in the UK. [UNTRACED]
- **REQ-DAT-020** Our services' logs are kept 30 days in Google's London location, and a copy 30 days in Axiom in Frankfurt. [LG-3]

## Where data is held outside the UK

- **REQ-DAT-021** Video and audio files are held at Bunny in Frankfurt. [D89]
- **REQ-DAT-022** Clerk, which holds sign-in data, is hosted in the US. [D6]
- **REQ-DAT-023** Bunny's delivery network serves files worldwide. [D103]
