# My profile, edit and delete

Who: Signed-in person, Moderator, the system.
Data: `docs/db-permissions.md#person-linked-tables`
Next id: REQ-PRO-037

## My submissions

- **REQ-PRO-001** My submissions lists the Signed-in person's stories, each with its status in plain words: "Draft", "Being edited", "Sent back", "Waiting for review", "Published", "Not on the site right now", "Taken down by our team" and "Not accepted". [J-2026-11-11-PRO]
  Example: "Draft" is a story never sent; "Being edited" is one taken down with Edit.
- **REQ-PRO-002** A "Sent back" story shows the moderator's note under "What our team said"; a "Not accepted" story shows the moderator's note too. [J-2026-11-11-PRO]
- **REQ-PRO-003** When the site took a video or audio story off itself while its media is fixed, its owner sees "Not on the site right now" and "We're fixing your video. It will be back by itself." [G2]
- **REQ-PRO-004** When a Moderator took a story down, its owner sees "Taken down by our team" with the reason, never "back by itself". [MD-2]
- **REQ-PRO-005** Drafts and stories being edited or sent back have "Continue" ("Continue editing" once sent before), and each says the date after which the nightly clean-up deletes it if nobody touches it. [G3]
- **REQ-PRO-006** Every story that isn't on the site has "Preview", the person's own "see it as others will" page; a published one has "View" instead. [J-2026-11-10-PRO]

## Needs a new file

- **REQ-PRO-007** When Bunny couldn't use a story's video or audio file, the site sends it back with "We couldn't use your video. Please upload another file." ("your recording" for audio) and "Upload another file". [J-2026-11-10-PRO]
- **REQ-PRO-008** When it was an audio story's picture video that failed, the story says "We couldn't use your picture. Please upload your recording again, and a picture if you like." with "Upload your recording again". [P1-6]
- **REQ-PRO-009** That button opens the story at its upload, which says the same until a new file is in, then "Thanks, your new file is in. Send it when you're ready."; the person replaces the file with the usual upload and sends it again. [J-2026-11-10-PRO]
- **REQ-PRO-010** "Your new file is in" needs an upload after the failure: a file the tab uploaded before it was judged unusable doesn't count. [J-2026-11-10-PRO]
- **REQ-PRO-011** Like any story being edited, a story showing "Needs a new file" or "Ready to send again" says when it will be deleted if nobody changes it. [G3]
- **REQ-PRO-012** Once a new file is on a story the site sent back for its file, My submissions shows "Ready to send again", "Thanks, your new file is in. Send it when you're ready." and "Send again", which opens the story to send it. [P1-1]
- **REQ-PRO-013** api-user gives the owner `mediaProblem: unusable`, worked out from the current file, and `unusableFile: recording | picture`, set while the story's current status entry is the site's "file unusable" one; neither is stored on the story. [P1-1]

## Edit

- **REQ-PRO-014** A story waiting for review, published or not on the site right now can be edited; pressing Edit takes it down at once, asking first when it is published, as it leaves the public site. [ED-1]
- **REQ-PRO-015** Edit opens the story in the share flow, where everything can change: words, themes, video or audio, picture. [M3-6]
- **REQ-PRO-016** An edited story goes back to Moderators only when the person sends it again, and back on the site only once a Moderator approves it. [ED-1]
- **REQ-PRO-017** An edited story keeps its hearts, its first publication date and its address. [ED-1]
- **REQ-PRO-018** A sent-back story is edited the same way. [ED-1]
- **REQ-PRO-019** A rejected story can't be edited, only deleted, unless a Moderator overturns the rejection: then it is in its new state. [OV-1]
- **REQ-PRO-020** Until a story is first approved, its address follows its title; after that, changing the title keeps the address. [J-2026-11-12-PRO]

## Delete

- **REQ-PRO-021** A Signed-in person can delete their own story in any state, after one "This can't be undone" question. [ED-3]
- **REQ-PRO-022** Deleting a story deletes its videos and pictures and everyone's hearts on it, and takes it off the site at once. [ED-3]
- **REQ-PRO-023** When a story is deleted, its videos and pictures are deleted at Bunny at once, waiting at most 8 seconds; if Bunny fails or is still busy then, the delete still succeeds and the nightly clean-up removes them. [OD-1]
- **REQ-PRO-024** Delete my account is the one account-wide withdrawal: the page says what goes and what stays and asks the person to type "delete". [D82]
- **REQ-PRO-025** Deleting an account deletes the person's stories, videos, pictures, hearts, limits and records, deletes them at Clerk (which signs them out everywhere), and keeps a fingerprint of their sign-in so it can't create a new account. [D82]
- **REQ-PRO-026** What is left of a deleted account is marked deleted, with no date and no reason. [DB2-R3]
- **REQ-PRO-027** Deleting the person in Clerk's dashboard does the same as Delete my account. [D82]

## Download my data

- **REQ-PRO-028** Download my data gives one file of everything we hold about the Signed-in person, explained in plain words: their stories in every status, what they agreed to and when, their hearts, their limits and their sign-in details from Clerk. [UNTRACED]
- **REQ-PRO-029** The file holds each story's whole status history: their own sends and edits, moderators' decisions with their comments signed "moderator" and never who made them, and the site's own hides and shows while a video can't play. [R6]
- **REQ-PRO-030** On their own sends, the file holds the IP address they sent from while it is still kept. [BL-4]
- **REQ-PRO-031** On their own sends, the file holds the email they sent it with; it never holds a staff member's email. [EM-1]
- **REQ-PRO-032** Videos, audio and pictures come as links that last 7 days, in dev and production. [G16]
  Why: this is a named exception to the one-hour rule for links to files that aren't public.
- **REQ-PRO-033** Each video or audio item also has a link to download it as an MP4 file, a copy Bunny makes when it encodes the video, not the original upload Bunny keeps. [J-2026-11-06-PRO]
- **REQ-PRO-034** A video encoded before MP4 copies were turned on has no MP4 copy, and the file says so. [J-2026-11-06-PRO]
- **REQ-PRO-035** The file says what it leaves out: who moderated, Clerk's sessions and devices, and anyone else's data. [UNTRACED]
- **REQ-PRO-036** When Clerk, or Bunny asked which MP4 copies the person's videos have, can't answer, there is no file rather than a partial one. [UNTRACED]
