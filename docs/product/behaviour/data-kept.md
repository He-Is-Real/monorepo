# Data kept and deleted

Who: the system, Admin.
Data: `docs/db-permissions.md#person-linked-tables`, `docs/db-permissions.md#erasure`
Next id: REQ-DAT-050

## Stories

- **REQ-DAT-001** When a draft (a story never sent for review) has had no edit and no resumed upload for 186 days, the nightly clean-up deletes it with its files. [D71]
- **REQ-DAT-003** Before the nightly clean-up deletes a draft, the person gets an emailed warning. (planned) [J-2026-10-30-DAT]
- **REQ-DAT-004** When a story has been rejected for 90 days, the nightly clean-up deletes it with its files. [G3]
- **REQ-DAT-029** When a rejection is overturned, the story's rejected-time clock stops: only a story that is still rejected is deleted for being rejected. [G3]
- **REQ-DAT-024** Until the nightly clean-up deletes a rejected story, the person can read the Moderator's note and download the story with their data. [G3]
- **REQ-DAT-005** When a story sent at least once (sent back, or taken down with Edit) is left in editing untouched for 186 days, the nightly clean-up deletes it with its files. [G3]
- **REQ-DAT-006** For REQ-DAT-005, the last edit, a resumed upload, being sent back and being taken down each count as a touch. [G3]
- **REQ-DAT-007** On the Limits page an Admin sets the rejected time and the editing time, each 7 to 3,650 days; a change moves every story's deletion date at once. [G3]
- **REQ-DAT-008** The nightly clean-up never deletes a story that is waiting for review, published or hidden. [G3]
- **REQ-DAT-009** My submissions shows the deletion date on each rejected story, as it does for drafts and stories left in editing. [G3]
- **REQ-DAT-030** The nightly clean-up deletes a story only once the deletion date its owner sees on My submissions has passed. [G3]
- **REQ-DAT-031** Deleting a story deletes its history, every heart on it, its place in search and its pictures. [D39]
- **REQ-DAT-032** No entry in a story's history is deleted while the story exists. [R6]
- **REQ-DAT-033** Clearing the IP address a story was sent from (REQ-DAT-016) is the only change ever made to an entry in a story's history. [G21]
- **REQ-DAT-034** The email a story was sent with is never changed or cleared while the story exists. [EM-1]
- **REQ-DAT-036** A Moderator's work email on a story's history is kept with that story and deleted with it; it is not removed when the staff member's own account is deleted. [EM-1]

## Files, records and logs

- **REQ-DAT-010** The nightly clean-up runs at 03:30 London time. [PR-141]
- **REQ-DAT-011** When a video at Bunny is older than 48 hours and no story uses it, the nightly clean-up deletes it. [J-2026-10-30-DAT]
- **REQ-DAT-025** The clean-up of leftover videos deletes at most 50 of each kind a night. [PR-141]
- **REQ-DAT-012** On dev, the clean-up of leftover videos only reports what it would delete. [PR-141]
- **REQ-DAT-013** When deleting an account's files at Bunny fails, the system retries it. [D40]
- **REQ-DAT-026** When deleting an account's Clerk account fails, the system retries it. [D39]
- **REQ-DAT-014** The record of what a person submitted, for the weekly limit, is kept 7 days and deleted with the account. [D113]
- **REQ-DAT-027** Upload records stay when a story is deleted, so the upload limits still count them. [R12]
- **REQ-DAT-046** The record of an upload is deleted with the account; otherwise the nightly clean-up deletes it once it is over 7 days old and its file has been removed or its story is gone. [R12]
- **REQ-DAT-015** Request keys (which stop a resent request being applied twice) expire 24 hours after the request, and the nightly clean-up deletes expired ones. [R4]
- **REQ-DAT-047** A request key keeps only who sent the request, a fingerprint of the request and the id of the answer. [R4]
- **REQ-DAT-016** The IP address a story was sent from is cleared by the nightly clean-up 30 days after it was sent, keeping the status entry, and goes with the story. [G21]
- **REQ-DAT-017** The email a story was sent with is kept as long as the story and goes with the story or with the account. [EM-1]
- **REQ-DAT-018** A block list entry is kept until an Admin removes it, even after the person deletes their account. [G21]
- **REQ-DAT-019** Backups age out; they are never edited after a deletion, and restoring one replays the erasures logged since it was taken (`docs/restore-runbook.md`). [D40]
- **REQ-DAT-028** Backups are taken nightly and kept in the UK. [UNTRACED]
- **REQ-DAT-020** Our services' logs are kept 30 days in Google's London location, and a copy 30 days in Axiom in Frankfurt. [LG-3]
- **REQ-DAT-048** There is no audit log. A setting that can be changed records only who changed it last, and a legal text version records who published it. [DB2-R3]

## Deleting an account

- **REQ-DAT-037** Deleting an account deletes the person's stories with their history, their hearts and others' hearts on their stories, their uploaded files, their limits and their saved requests. [D39]
- **REQ-DAT-035** A story and its history are special-category personal data: both are deleted when the person's account is deleted. [D39]
- **REQ-DAT-038** After an account is deleted, the person's videos, audio, pictures and sign-in account are deleted at the outside services straight away; any that fail are tried again every night until done. [D40]
- **REQ-DAT-039** After an account is deleted, only two things remain: an empty record with its creation date and the word "deleted", and a one-way fingerprint of the old sign-in id that cannot be turned back into it. [D37]
- **REQ-DAT-040** The fingerprint of a deleted account's sign-in holds no date and no link to anything else, and nobody can change or remove it. [D82]
- **REQ-DAT-041** The fingerprint is kept so that sign-in can never come back; it still counts as personal data, and the privacy policy says so. [D82]
- **REQ-DAT-042** A staff member who deletes their account is deleted like anyone else; places that named them then name no one. [D37]
- **REQ-DAT-043** Staff work emails on the staff list are not story data: they are not linked to a person's account and are not deleted when an account is deleted. [S-1]
- **REQ-DAT-044** Nothing new can be stored for a person whose account has been deleted, even from a page they still had open. [D39]
- **REQ-DAT-045** Each account deletion is logged with internal ids only, no personal data. Backups are deleted after a set number of days, so a deleted person is gone from them too. [D40]

## Where data is held outside the UK

- **REQ-DAT-021** Video and audio files are held at Bunny in Frankfurt. [D89]
- **REQ-DAT-022** Clerk, which holds sign-in data, is hosted in the US. [D6]
- **REQ-DAT-023** Bunny's delivery network serves files worldwide. [D103]

## Running costs

- **REQ-DAT-049** The monthly hosting budget is £15, with alert emails at £3, £7.50 and £15; nothing is stopped automatically. [DEC-10]
