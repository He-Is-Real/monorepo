# Glossary

Words with one meaning on the site and in the code. Actors are in `actors.md`.

- **Admin**: the highest staff role, above Moderator. Code: role `Admin`. Not: Super Admin, SuperAdmin.
- **Draft**: a story never sent for review; it is in the editing state with no status entry that moved it. Code: `editing`.
- **Moderator**: the staff role that reviews stories. Code: role `Moderator`. Not: Admin, the old name for this role.
- **Nightly clean-up**: the job that runs at 03:30 London time and deletes old drafts, old rejected stories, leftover files and expired records. Code: `apps/housekeeping` ("housekeeping" in the code).
- **Payment provider**: the outside service that takes donations. Code: Stripe (`web_donations`). Not: Stripe, in rules.
- **Pending**: the state of a story sent and waiting for review, shown as "Waiting for review". Code: `pending`.
- **Published**: the state of an approved story on the site, shown as "Published". Code: `approved`.
- **Sign-in service**: the outside service that holds each person's email, name, password and sessions. Code: Clerk (`libs/auth`). Not: Clerk, in rules.
- **Signed-in person**: someone with an account. Code: role `User`. Not: User, in rules.
- **Story**: what one person shares: a written, video or audio account. Code: `story`. Not: testimony, except legal wording quoted from the screen.
- **Take down**: when a Moderator takes a story down it is hidden ("Taken down by our team"); when the person takes it down with Edit it is in editing ("Being edited"). Code: `hidden`, `editing`.
- **Theme**: a topic a story carries, grouped in categories that Admins manage. Code: `theme`. Not: tag.
- **Video host**: the outside service that stores, encodes and plays videos and audio, and stores pictures. Code: Bunny Stream and the Bunny images zone. Not: Bunny, in rules.
- **Visitor**: someone not signed in. Code: role `Viewer`. Not: Viewer, in rules.
