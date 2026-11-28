# My profile, edit and delete

Who: Signed-in person, Moderator, the system.
Data: `docs/db-permissions.md#person-linked-tables`
Next id: REQ-PRO-037

## My submissions

- **REQ-PRO-001** My submissions lists the Signed-in person's stories, each with its status in plain words: "Draft", "Being edited", "Sent back", "Waiting for review", "Published", "Not on the site right now", "Taken down by our team" and "Not accepted". [J-2026-11-11-PRO]
  Example: "Draft" is a story never sent; "Being edited" is one taken down with Edit.
- **REQ-PRO-002** A "Sent back" story shows the moderator's note under "What our team said"; a "Not accepted" story shows the moderator's note too. [J-2026-11-11-PRO]
- **REQ-PRO-003** When the site took a video or audio story off itself while its media is fixed, its owner sees "Not on the site right now" and "We're fixing your video. It will be back by itself." [G2]
- **REQ-PRO-004** When a Moderator took a story down, its owner sees "Taken down by our team" with the reason under "What our team said", never "back by itself". [MD-2]
- **REQ-PRO-005** Drafts and stories being edited or sent back have "Continue" ("Continue editing" once sent before), and each says the date after which the nightly clean-up deletes it if nobody touches it; each rejected story says the date the nightly clean-up deletes it. [G3]
- **REQ-PRO-006** Every story that isn't on the site has "Preview", the person's own "see it as others will" page; a published one has "View" instead. [J-2026-11-10-PRO]

## Needs a new file

- **REQ-PRO-007** When the video host couldn't use a story's video or audio file, the site sends it back with "We couldn't use your video. Please upload another file." ("your recording" for audio) and "Upload another file". [J-2026-11-10-PRO]
- **REQ-PRO-008** When it was an audio story's picture video that failed, the story says "We couldn't use your picture. Please upload your recording again, and a picture if you like." with "Upload your recording again". [P1-6]
- **REQ-PRO-009** That button opens the story at its upload, which says the same until a new file is in, then "Thanks, your new file is in. Send it when you're ready."; the person replaces the file with the usual upload and sends it again. [J-2026-11-10-PRO]
- **REQ-PRO-010** "Your new file is in" needs an upload after the failure: a file the tab uploaded before it was judged unusable doesn't count. [J-2026-11-10-PRO]
- **REQ-PRO-012** Once a new file is on a story the site sent back for its file, My submissions shows "Ready to send again", "Thanks, your new file is in. Send it when you're ready." and "Send again", which opens the story to send it. [P1-1]

## Edit

- **REQ-PRO-014** A story waiting for review, published or not on the site right now can be edited; pressing Edit takes it down at once, asking first when it is published, as it leaves the public site. [ED-1]
- **REQ-PRO-015** Edit opens the story in the share flow, where everything can change: words, themes, video or audio, picture. [M3-6]
- **REQ-PRO-016** An edited story goes back to Moderators only when the person sends it again, and back on the site only once a Moderator approves it. [ED-1]
- **REQ-PRO-017** An edited story keeps its hearts. [ED-1]
- **REQ-PRO-020** Until a story is first approved, its address follows its title; from its first approval on, its address never changes, even when its title does. [J-2026-11-12-PRO]

## Delete

- **REQ-PRO-021** A Signed-in person can delete their own story in any state, after one "This can't be undone" question. [ED-3]
- **REQ-PRO-022** Deleting a story deletes its videos and pictures and everyone's hearts on it, and takes it off the site at once. [ED-3]
- **REQ-PRO-023** When a story is deleted, its videos and pictures are deleted at the outside services at once, waiting at most 8 seconds; if one fails or is still busy then, the delete still succeeds and the nightly clean-up removes them. [OD-1]
- **REQ-PRO-024** Delete my account is the one account-wide withdrawal: the page says what goes and what stays and asks the person to type "delete". [D82]
- **REQ-PRO-025** Deleting an account also deletes the person's sign-in account, which signs them out everywhere. [D82]
- **REQ-PRO-026** What is left of a deleted account is marked deleted, with no date and no reason. [DB2-R3]
- **REQ-PRO-027** Deleting the person in the sign-in service's own dashboard does the same as Delete my account. [D82]

## Download my data

- **REQ-PRO-028** Download my data gives one file of everything we hold about the Signed-in person, explained in plain words: their stories in every status, what they agreed to and when, their hearts, their limits and their sign-in details from the sign-in service. [UNTRACED]
- **REQ-PRO-029** The file holds each story's whole status history: their own sends and edits, moderators' decisions with their comments, signed as REQ-MOD-016 says, never with who made them, and the site's own hides and shows while a video can't play. [R6]
- **REQ-PRO-030** On their own sends, the file holds the IP address they sent from while it is still kept. [BL-4]
- **REQ-PRO-031** On their own sends, the file holds the email they sent it with. [EM-1]
- **REQ-PRO-032** Videos, audio and pictures come as links that last 7 days, in dev and production. [G16]
  Why: this is a named exception to the one-hour rule for links to files that aren't public.
- **REQ-PRO-033** Each video or audio item also has a link to download it as an MP4 file, a copy the video host makes when it encodes the video, not the original upload the video host keeps. [J-2026-11-06-PRO]
- **REQ-PRO-034** A video encoded before MP4 copies were turned on has no MP4 copy, and the file says so. [J-2026-11-06-PRO]
- **REQ-PRO-035** The file says what it leaves out: who moderated, the sign-in service's sessions and devices, and anyone else's data. [UNTRACED]
- **REQ-PRO-036** When the sign-in service, or the video host asked which MP4 copies the person's videos have, can't answer, there is no file rather than a partial one. [UNTRACED]
