# Sharing a story

Who: Signed-in person (sharing their own story and its files), Admin (limits), Moderator, the system.
Data: `docs/db-permissions.md`.
Next id: REQ-SHR-141

## Contents

- When sharing opens
- Story types
- The share page's steps
- Review and submit
- Drafts and autosave
- Limits
- Uploading files
- Upload limits
- Pictures
- Checking a picture on send
- A video's thumbnail
- A video's picture at Bunny
- An audio story's picture video
- Attached files on the page
- Media storage

## When sharing opens

- **REQ-SHR-125** Public submissions open only once confirmation emails work, so nobody shares a story without a confirmation; the site may go live first, as the 24 imported stories need no emails. [D95]

## Story types

- **REQ-SHR-001** A story is one of three types: written (text, with an optional picture), video (one video, with optional text) or audio (one audio file, with optional text). [D53]
- **REQ-SHR-126** A story's video is one uploaded to us; linking a YouTube video is a later feature. [D8]
- **REQ-SHR-127** A written story needs text that is not blank and has no video or audio; it may have a picture. [D53]
- **REQ-SHR-128** From the moment it is sent, a video or audio story has exactly one file of its own kind. [D53]
- **REQ-SHR-002** When a Signed-in person shares a story, they choose the name shown on it, an optional first name; a story without one shows "Anonymous". [J-2026-10-25-SHR]

## The share page's steps

- **REQ-SHR-003** The share page goes: choose the type, the testimony consent (only if the person has not agreed to the latest), preparation prompts, write or upload the file, details (optional first name, themes), review (with the optional social media box), then "waiting for review". [UNTRACED]
- **REQ-SHR-004** The preparation prompts are guidance only and are never stored. [J-2026-10-25-SHR]
- **REQ-SHR-005** When the person presses an earlier step in the steps at the top of the share page, it opens at once, with nothing lost (drafts save as the person goes). [J-2026-11-10-SHR]
- **REQ-SHR-006** A later step opens only once every step before it would pass its own Continue; otherwise the page stops at the first step that still needs something and shows that step's usual message. [J-2026-11-10-SHR]
- **REQ-SHR-007** The later steps at the top open once a story is started or a draft is carried on. [J-2026-11-10-SHR]
- **REQ-SHR-008** When the person chooses a later step while the story is saving, the page decides again once it has saved, from what is on screen then; if they chose another file meanwhile, they stay on the upload step with its usual message. [J-2026-11-10-SHR]
- **REQ-SHR-009** When the person presses submit twice, the system creates neither two drafts nor two submissions. [D29]
- **REQ-SHR-010** After the person sends a story for review, the page promises no email and says "Our team reads every story before it's published". [J-2026-10-28-SHRb]
- **REQ-SHR-011** When a theme the person picked is deleted while they are sharing, submit asks them to choose again. [A7]

## Review and submit

- **REQ-SHR-012** Once Bunny has processed the story's video or audio file, the review step plays it in Bunny's player, beside the picture. [J-2026-11-10-SHRb]
- **REQ-SHR-013** Until Bunny has processed it, the file's row is one status line: a tick, the file's name (when the tab knows it) and "Uploaded. Its preview will be ready later.", with no waiting or checking again. [RP-3]
- **REQ-SHR-014** While the preview is not ready, the person can still send the story, or press "Save Draft and Exit" and come back later. [J-2026-11-10-SHRb]
- **REQ-SHR-015** After a submission whose answer was lost, "Save Draft and Exit" first sends that same submission again: if it went through, the page shows "Thank you"; if that cannot be known yet, it confirms nothing and asks the person to try again. [UNTRACED]
  Why: the person already asked to send it, and our server may still be working on it.
- **REQ-SHR-016** The review step has a "See your story as others will" button, a link styled as an outline button with an eye icon, full width on phones, with "Opens in a new tab" under it, that opens `/account/stories/{id}/preview` in a new tab. [J-2026-11-14-SHRb]
- **REQ-SHR-017** The preview page shows the public story page's own parts, with a banner "Only you can see this preview", and no heart, share or related stories. Only the story's owner can open it. [J-2026-11-10-SHRb]
- **REQ-SHR-018** My submissions links every one of the person's stories that is not on the site to its preview page. [J-2026-11-10-SHRb]
- **REQ-SHR-019** The links to the person's own video, audio and picture are signed only when that one story is read (never in the list, never publicly) and last one hour; reloading gets fresh ones. [J-2026-11-10-SHRb]
- **REQ-SHR-020** An answer carrying signed media links is never "not modified", so the page never keeps expired links. [J-2026-11-10-SHRb]
- **REQ-SHR-021** "Review and submit" shows the answers as aligned rows: label, answer and its link on one line on wider screens; on phones the label and link share the top line and the answer sits under them. [RP-1]
- **REQ-SHR-022** Each link on "Review and submit" keeps its 44 px tap area and its full name, for example "Change title". [RP-1]
- **REQ-SHR-023** On "Review and submit", an empty description reads "None added (optional)" in grey with an "Add" link, and no themes chosen reads "None chosen" with an "Add" link. [RP-2]
- **REQ-SHR-024** On "Review and submit", the picture or thumbnail is a small picture, 120 px wide, in its row. There is no story card: the "See your story preview" button shows the result. [RP-1]

## Drafts and autosave

- **REQ-SHR-025** "Save Draft and Exit" sits right of Back on every step from writing to review, with Continue or Submit on the far right. [J-2026-11-22-SHR]
- **REQ-SHR-026** While a save is under way, "Save Draft and Exit" reads "Saving…" and is greyed; when ready it reads "Save Draft and Exit". Screen readers hear "Saving…" and "Draft saved". [J-2026-11-22-SHR]
- **REQ-SHR-027** Save warnings stay as text under the step: kept on this device until it can be saved, offline, a save error, or a clash with another tab. [J-2026-11-14-SHR]
- **REQ-SHR-028** When the person presses "Save Draft and Exit", the page waits for the save, then goes to My submissions, where the draft is listed with "Continue". [J-2026-11-14-SHR]
- **REQ-SHR-029** Before a draft can be saved (a written story needs its title and some text, a video or audio story its title), "Save Draft and Exit" stays and says what is needed, also for text brought back after a reload. [J-2026-11-14-SHR]
- **REQ-SHR-030** "Save Draft and Exit" leaves straight away only when nothing has been typed; if the save fails, it stays and says so. [J-2026-11-14-SHR]
- **REQ-SHR-031** On "Save Draft and Exit", a picture still uploading is waited for; a video or audio upload stops, and carries on when the person comes back and chooses the same file. [J-2026-11-14-SHR]
- **REQ-SHR-032** Autosave saves the draft once it has a title and text, then after each pause. [D70]
- **REQ-SHR-033** When the same draft is open in two tabs, each keeps its own changes, and the person is asked only when both changed the same thing. [D70]
- **REQ-SHR-034** Text stays in the tab until the server has it, through reloads and outages. [D70]
- **REQ-SHR-129** A person can start a draft only as themselves, with an existing account, after agreeing to the latest terms of use and testimony consent. [J-2026-11-01-DB]
- **REQ-SHR-130** Only the person can change their story's content (title, words, name, story type, themes, picture and file), and only while it is in editing; staff and the system never change it, apart from an audio story's picture video (REQ-SHR-106). [D41]

## Limits

- **REQ-SHR-035** An Admin can change each limit in this section; the numbers given are the values in force. [D112]
- **REQ-SHR-131** A story's text is never over 50,000 characters and it never has more than 20 themes, whatever the settings. [PR-118]
- **REQ-SHR-132** When an Admin changes a limit, only the one save already in progress may finish under the old value; every later save uses the new one. [PR-118]
- **REQ-SHR-036** A written story's text is 200 to 10,000 characters; a video or audio story's text has no minimum and is at most 10,000. [M1-A3]
- **REQ-SHR-037** Invisible zero-width characters count towards the 200-character minimum. [M1O-A2]
- **REQ-SHR-038** A story's title is at most 140 characters. [UNTRACED]
- **REQ-SHR-039** A story has 1 to 5 themes, counted when it is submitted. [J-2026-10-28-SHR]
- **REQ-SHR-040** A person has at most 3 open drafts; only never-sent stories count. [J-2026-10-25-SHR]
- **REQ-SHR-133** The open-drafts limit applies only to what the person does themselves. [D112]
- **REQ-SHR-041** A person sends at most 1 story for review in any 7 days. [D94]
- **REQ-SHR-134** Only a story's first send counts towards the weekly limit; sending it again after editing does not, and the limit applies only to what the person does themselves. [D113]
- **REQ-SHR-135** Each first send of a story counts towards the weekly limit for 7 days, even if the story is deleted meanwhile. [D113]
- **REQ-SHR-042** When a limit changes, it applies to everyone at once: every later action must meet the limits in force. [J-2026-10-30-SHRb]
- **REQ-SHR-136** When a limit changes, a story already sent or published is never checked against it again. [UNTRACED]
- **REQ-SHR-043** An edit over a maximum is accepted only if it does not make it worse, so a long draft can still be trimmed; submitting needs every current minimum and maximum. [J-2026-10-30-SHRb]
- **REQ-SHR-044** Trusted submitters have no open-drafts or weekly limits, only the hourly upload limit. [UNTRACED]
- **REQ-SHR-140** Trusted submitters get the largest video and audio sizes and lengths an Admin could set. [BE-14]
- **REQ-SHR-045** An Admin can also set a person's own limits; there is no admin page for that. [D112]
- **REQ-SHR-046** Before a limit is reached, the share page shows what's left this week ("2 of 3 stories left…"). [UNTRACED]
- **REQ-SHR-047** At a limit, the share page explains kindly, says when the person can carry on, and holds that step back. [UNTRACED]

## Uploading files

- **REQ-SHR-048** Files go straight from the person's browser to Bunny.net; our servers never handle the files. [D80]
- **REQ-SHR-049** Video and audio uploads show progress, can pause and resume, and carry on after a reload. [UNTRACED]
- **REQ-SHR-050** Our server, never the browser, decides which file belongs to a story, so nobody can point their story at someone else's media. [D80]
- **REQ-SHR-137** A file can be uploaded only to the person's own story, only while it is in editing and unchanged since the page loaded it, and only if it is the story's kind. [D80]
- **REQ-SHR-138** A picture's or video's width and height are above zero, and it is never taller than 1:3 or wider than 3:1. [D53]
- **REQ-SHR-051** A story has one video or audio file; replacing it deletes the old one at Bunny at once. [J-2026-10-25-SHR]
- **REQ-SHR-052** When a story is sent for review, the system checks that its file arrived and is within the limits. [UNTRACED]
- **REQ-SHR-053** When the person leaves the upload step while a video, audio file or picture is still uploading, by Back or the steps at the top, the step changes and the upload stops, with no question and no message. [J-2026-11-11-SHR]
- **REQ-SHR-054** A stopped video or audio upload carries on from where it stopped when the person chooses the same file again; a stopped picture is chosen again. [J-2026-11-11-SHR]
- **REQ-SHR-055** Going forward past the upload step, and sending, wait until its file and picture are complete. [J-2026-11-11-SHR]

## Upload limits

- **REQ-SHR-056** An Admin can change each limit in this section; the numbers given are the values in force. [D112]
- **REQ-SHR-057** A person makes at most 5 video and audio uploads in any 7 days; pictures never count towards it. [PR-140]
- **REQ-SHR-058** A person makes at most 10 upload requests, for any file, an hour. [J-2026-10-25-SHR]
- **REQ-SHR-139** Replacing a file or deleting a story frees no upload limit: the limits count every upload made. [D113]
- **REQ-SHR-059** A video file is at most 4 GB. [M2-A4]
- **REQ-SHR-122** An audio file is at most 500 MB. [M2-A4]
- **REQ-SHR-123** A video file is at most 15 minutes long. [M2-A4]
- **REQ-SHR-124** An audio file is at most 15 minutes long. [PR-133]
- **REQ-SHR-060** The largest picture file is 3 MB; an Admin sets it between 200 KB and 20 MB. [J-2026-11-20-SHR]
- **REQ-SHR-061** The largest picture file is the same for everyone, trusted submitters too, and covers every picture: a written story's, an audio story's and a video's thumbnail. [J-2026-11-20-SHR]
- **REQ-SHR-062** The largest picture file is measured after the browser has made the picture smaller. [J-2026-11-20-SHR]
  Example: most photos come to 200 KB to 1 MB; a 2048-pixel picture of pure noise, the worst case, is just under 3 MB.
- **REQ-SHR-063** The browser checks the largest picture file before uploading ("This picture is too large: … Please choose a smaller one."); api-user and the database check it again when the upload is asked for, and api-user once more when the story is sent. [J-2026-11-20-SHR]
- **REQ-SHR-064** Lowering the largest picture file does not touch stories already sent. [J-2026-11-20-SHR]

## Pictures

- **REQ-SHR-065** An audio story's picture and a video's own thumbnail can be uploaded, as a written story's picture can. [J-2026-10-30-SHR]
- **REQ-SHR-066** Before upload, the browser converts every picture to WebP, at most 2048 pixels on the long side, no bigger than the largest picture file, and no more extreme than 1:3 or 3:1, so no location or camera data leaves the device. [UNTRACED]
- **REQ-SHR-067** A picture has no smallest size: the browser, api-user and the database take anything from 1 pixel up. [TC-7]
  Why: someone may want to share pixel art.
- **REQ-SHR-068** Before upload, the browser enlarges every picture under about 1,000 pixels on its longer side by a whole number, with hard pixel edges, until its longer side is at least about 1,000 pixels. [TC-7]
  Why: so it stays crisp on cards and in Bunny's player rather than smeared.
- **REQ-SHR-069** Only the browser handles a picture's pixels; our servers see only its size in bytes, width and height. [TC-1]
- **REQ-SHR-070** When the person chooses a picture, it is added straight away, as a video or audio file uploads once chosen, with no "Add" button; a video's thumbnail is the exception (REQ-SHR-083). [J-2026-11-09-SHR]
- **REQ-SHR-071** While a picture is added, a line says whether it is being prepared, uploading or added; Continue waits while it uploads, and a failed upload keeps one "Try again" button. [J-2026-11-09-SHR]
- **REQ-SHR-072** A picture has no description: there is no "describe the picture" box, and none is stored or sent anywhere. [J-2026-11-14-SHRc]
- **REQ-SHR-073** Readers' pages give every story picture the same neutral alternative text, "A photo shared with this story"; the story's own optional description stays. [J-2026-11-14-SHRc]
- **REQ-SHR-074** Audio and written stories' pictures are not cropped; they keep their own shape. [TC-5]

## Checking a picture on send

- **REQ-SHR-075** When a story with a picture is sent for review, the server reads only the first 40 bytes of the stored picture. [R3]
- **REQ-SHR-076** The picture passes only if it is all there (its exact size as recorded at upload), a WebP of the width and height recorded, and has no EXIF or XMP metadata and no animation; a colour profile and transparency are allowed. [R3]
  Why: a picture our page made never has metadata or animation; Chrome adds a standard colour profile to every picture.
- **REQ-SHR-077** When the picture fails that check, the story stays a draft and the person is told "Your picture hasn't finished uploading. Add it again, or remove it, then submit your story." [R3]
- **REQ-SHR-078** When the picture is bigger than the largest picture file now in force, the story stays a draft and the person is told "Your picture is larger than we can take now. Add a smaller one, or remove it, then submit your story." [J-2026-11-20-SHR]
- **REQ-SHR-079** When the picture storage cannot be reached, the story stays a draft and the person tries again later; a picture never passes unchecked. [R3]
- **REQ-SHR-080** A picture that passes counts as processed, so a Moderator can approve the story. [R3]
  Why: until scanning is built, this check and the Moderator seeing every picture are what stand between an upload and the public.

## A video's thumbnail

- **REQ-SHR-081** On a video story's upload step, once the video is chosen, "Add a thumbnail (optional)" offers two tabs: "A picture" and "A moment from your video". [TC-1]
- **REQ-SHR-082** In "A picture", the chosen photo opens in a crop box with the video's own shape (kept within 1:3 to 3:1) that cannot be resized; the person moves and zooms the photo under it, which starts centred and as large as it can be. [TC-2]
- **REQ-SHR-083** Nothing is uploaded or saved to the draft until "Use this thumbnail"; Cancel goes back. Below the crop box, small previews show the Browse card and the story page's player. [TC-6]
- **REQ-SHR-084** When the person presses Continue while a crop is open, the page says "Use this thumbnail, or cancel it, before you go on." [TC-6]
- **REQ-SHR-085** Only the cropped picture leaves the device, never the original photo; once added, "Change how it's cropped" reopens the cropper on the same photo while this tab still has it. [TC-1]
- **REQ-SHR-086** In "A moment from your video", a slider moves through the video and "Use this moment" grabs that frame in the browser and adds it like any picture; the tab appears only when this browser can play the chosen video. [TC-1]
- **REQ-SHR-087** The crop picture is one stop in the Tab order ("Thumbnail crop: arrow keys move the picture, plus and minus zoom"): arrow keys move it (with Shift, further), + and − zoom, and 0 centres it. [TC-8]
- **REQ-SHR-088** A labelled zoom slider with − and + buttons and "Centre" sit beside the crop, and after a move a polite spoken line says where the crop is ("Zoom 1.5 times. Showing the top left of your picture."). [TC-8]
- **REQ-SHR-089** The browser reads the video's shape from the chosen file, as it reads its length, with a phone's "turn this" note applied; if the browser cannot play the file, it reads an MP4 or MOV file's header. [TC-4]
- **REQ-SHR-090** When the shape is still unknown (another format, or a draft carried on in another tab or on another device), the thumbnail chooser waits with a plain line until Bunny reports the shape; the person can carry on and come back. [TC-4]
- **REQ-SHR-091** When the person chooses a new video, whatever its shape, the thumbnail is taken off and the page says "We've taken your thumbnail off because you changed your video. Choose one again if you still want it." [TC-3]
- **REQ-SHR-092** The database write that accepts a new video takes the thumbnail off in that same write, with no second request from the browser; the nightly clean-up deletes the old picture file, as it does a removed picture's. [TC-9]
- **REQ-SHR-093** Carrying on with the same video's upload keeps the thumbnail. [TC-3]

## A video's picture at Bunny

- **REQ-SHR-094** When a video story is sent, also after Edit, the system tells Bunny to show the story's picture for the video, or Bunny's own frame if the person took their picture off, and reads the video back, in the same request, after the picture's own check. [P1-13]
- **REQ-SHR-095** Bunny downloads the picture through a link made just before it is asked, which expires 15 seconds later, before the 20 seconds the site waits for Bunny run out. [RE-4]
  Why: Bunny refuses an expired link, so a request the site has given up on cannot change the picture afterwards.
  Not: a page's own picture links; they keep their usual lifetime.
- **REQ-SHR-096** When Bunny downloads the picture in time but takes over 20 seconds to save it, and meanwhile the person removes or changes the picture and sends again, the old picture can land; a Moderator or Admin then takes the story down and the person sends it again. [RE-5]
- **REQ-SHR-097** Nothing goes to Bunny only when the picture is the one Bunny was last confirmed to show and Bunny still shows that recorded file, or when there is no picture, nothing recorded, and Bunny still shows the video's first, untouched thumbnail. [UNTRACED]
- **REQ-SHR-098** When Bunny shows any other file (a late change from an earlier send, or another tab), the system sets the picture, or Bunny's own frame, again and reads it back; a file name our own confirmed set did not produce is never recorded. [UNTRACED]
- **REQ-SHR-099** When Bunny refuses, cannot be reached, takes over 20 seconds or does not show the new picture, the story is not sent and stays as it was, and the person is told "We couldn't add your picture. Please add it again, then submit." [P1-13]
- **REQ-SHR-100** A failed picture set at Bunny has no retry in the background and no picture job. [P1-13]
- **REQ-SHR-101** Once Bunny shows the picture, the database records it on the video's record with the name of the picture file Bunny showed (for a video never given a picture, its untouched thumbnail). [RE-2]
- **REQ-SHR-102** A video story cannot be approved until Bunny shows the picture it has now. [J-2026-11-06-SHR]
- **REQ-SHR-103** The video's own checks never touch its picture or that file name. [RE-2]
- **REQ-SHR-104** The story page shows Bunny's player with no picture of our own over it. [J-2026-11-08-SHR]

## An audio story's picture video

- **REQ-SHR-105** Once an audio story's file is ready at Bunny, the media worker makes a video of the story's picture (or the site's default waveform picture) in the picture's own shape, at most 1280 px on its longer side, with the sound unchanged, and uploads it to a new Bunny video. [DEC-4]
- **REQ-SHR-106** The audio story then shows that picture video instead of the audio file, keeping its edit number; the nightly clean-up deletes the audio file. [DEC-1B]
- **REQ-SHR-107** A new picture, or the picture taken off, makes a new picture video. [DEC-1B]
- **REQ-SHR-108** An audio story counts as ready only once its picture video is, so it cannot be approved before. [DEC-1B]

## Attached files on the page

- **REQ-SHR-109** The attached file's name is shown for a video, audio file or picture, on the upload step and on "Review and submit". [J-2026-11-14-SHRd]
- **REQ-SHR-110** On "Review and submit", each attached file has a tick and "Video attached", "Audio file attached", "Thumbnail attached" (a video's picture) or "Picture attached", with the file's name under it; a file still being processed shows its status line (REQ-SHR-013). [J-2026-11-14-SHRd]
- **REQ-SHR-111** The file's name is kept only in that browser tab, never on our servers; after a reload in another tab or on another device, the confirmation shows without the name. [J-2026-11-14-SHRd]
- **REQ-SHR-112** The tick shows only when the file is known to have arrived: a picture our server found in storage, or a video or audio file this tab finished uploading (and has not since asked to replace) or that Bunny has started processing. [J-2026-11-14-SHRd]
- **REQ-SHR-113** Without the tick, a highlighted line with a button back to the upload step says what is wrong instead (REQ-SHR-114). [J-2026-11-14-SHRd]
- **REQ-SHR-114** The line says "Your video may not have finished uploading. We'll check when you submit." when another tab or device started it, "We couldn't read that video file…" when Bunny could not process it, or "Your picture hasn't finished uploading." [J-2026-11-14-SHRd]
- **REQ-SHR-115** The page does not ask Bunny whether a video or audio file arrived; only submitting does. So in a new tab or on another device, before Bunny starts on the file, the "may not have finished uploading" line shows even for a file that did arrive. [SF-2]
- **REQ-SHR-116** After a replacement started and stopped in another tab or on another device, this tab may briefly show the old file as attached; submit always asks Bunny, so nothing wrong is sent. [SF-2]

## Media storage

- **REQ-SHR-117** Before upload, the browser blanks an MP4, MOV or M4A file's location and device metadata in place, without re-encoding, so the file is the same size and plays the same; other files (MP3, WAV, WebM) and files it cannot read upload as they are. [J-2026-11-06-SHRb]
  Why: Bunny's MP4 copies, used for "Download my data", would otherwise keep the location.
- **REQ-SHR-118** Bunny stores uploaded videos and audio in Frankfurt, Germany, because Bunny does not offer London; pictures are stored in London. [D89]
- **REQ-SHR-119** Nothing personal is stored at Bunny: a video's title there is the story's id. [D69]
- **REQ-SHR-120** Bunny keeps each video's original upload, as the browser sent it, beside the encoded copies in Frankfurt, for later social media processing; nothing uses it yet. [RE-1]
- **REQ-SHR-121** Every deletion of a video (erasure, a replaced or removed upload, a deleted story, the orphan sweep) removes the whole video at Bunny, original included. [RE-1]
