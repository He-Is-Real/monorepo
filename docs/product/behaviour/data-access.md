# Who can see or change what

Who: Visitor, Signed-in person, Moderator, Admin, the system.
Data: `docs/db-permissions.md`.
Next id: REQ-ACS-018

- **REQ-ACS-001** Each person's access rules are enforced by the database itself, not only by the app's code. [BE-5]
- **REQ-ACS-002** No part of the system can read more personal data than its job needs. For example, the nightly clean-up never reads a story's words. [BE-6]

## Stories

- **REQ-ACS-003** Everyone else, the public and other signed-in people, can read a story only while it is approved, and then only its published parts. [R11]
- **REQ-ACS-004** Someone who is not signed in can read only published stories, the themes, the legal texts and the site's own videos. [UNTRACED]
- **REQ-ACS-005** A person can always read their own stories, in every state. [R11]
- **REQ-ACS-006** Who sent a story, its sharing consent and when it was given, and when the story was started are private: only the owner and the parts of the system that need them can read them, apart from the email and IP address an Admin sees on its moderation page. [R11]

## A story's history

- **REQ-ACS-007** Which staff member took a step on a story is visible to staff only; the story's owner never sees it. [R6]
- **REQ-ACS-008** The staff member's email on a step is visible to staff only; the story's owner never sees it. [EM-1]
- **REQ-ACS-009** A person can read the history of their own stories, including the Moderators' decisions and notes. [R6]
- **REQ-ACS-010** Everyone else can read, of a story's history, only that it is approved and when it was first published, and only from the entry that makes it public now. [R11]

## Files

- **REQ-ACS-011** A person can read the records of their own uploaded files. [R12]
- **REQ-ACS-012** Everyone else can see a file only while a published story uses it, and then only what is needed to show it: its kind, size, length and thumbnail. [R12]

## A person's own records

- **REQ-ACS-013** A person can read their own account record and nobody else's. [D13]
- **REQ-ACS-014** A person can see their own record of recent sends. [D113]
