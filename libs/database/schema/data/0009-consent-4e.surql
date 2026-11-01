-- data/0009-consent-4e.surql (runs once; recorded in _migration by the runner, in the same
-- transaction). Plan 4e (Joel, 2026-10-31 and 2026-11-01; privacy-consent-architecture.html 4e,
-- 8b): the consent, privacy and terms redesign. The schema step has already removed the old
-- machinery (the consent ledger, dpaVersion, termsVersion, the form-version tables, legalFence,
-- erasureRequest and their rows: all dummy data); this script
--   * seeds version 0 of each of the four texts, in every environment, unless it exists: C2's
--     drafts (Joel, 2026-11-01), written from the system as it is and marked "to be reviewed
--     before go-live", until an Admin saves version 1 at /admin/consent;
--   * C1 "fill in" (Joel, 2026-11-01): every person who exists when this runs (not erased stubs)
--     is recorded as agreeing to version 0 of the terms of use and the testimony consent, at the
--     database's time of this run, so their waiting dummy stories can be approved. A one-off
--     step, run by the migrator: only a system user ($auth NONE: the migrator, or dev's dev_seed)
--     may set a pointer for someone else (fn::legal::check_pointer); every service and admin
--     session is refused. People created later agree in their own session (the terms before using their account, the testimony
--     consent before their next story);
--   * removes the old settings row _setting:consent (the dev consent switches; the runner now
--     writes _setting:current);
--   * removes the audit rows only the old machinery wrote (granting and withdrawing consent,
--     publishing the privacy policy, terms or DPA, erasures by consent withdrawal or
--     housekeeping, hides for dev's consent switches) and any row still holding the removed
--     consentType or dpaVersion: none of them fits the audit log's rules now.
-- The old data scripts 0001, 0003, 0005 and 0007 wrote that machinery's rows and could no longer
-- run on a fresh database, so they left the bundle (as 0002 did, D44): databases that applied
-- them keep their _migration rows (the runner warns that the scripts are gone).
IF !record::exists(termsOfUseAgreement:0) {
  CREATE termsOfUseAgreement:0 CONTENT { content: "> **Draft, to be reviewed before go-live.**

These terms are the agreement between you and He Is Real Today, a UK not-for-profit (charity
registration pending), when you use heisreal.today with an account. They’re short, so please
read them.

## 1. Who can use the site

Anyone can read the stories. To have an account you must be 18 or over, and by agreeing to these
terms you confirm that you are. The site isn’t for children.

## 2. Your account

You sign in through Clerk, our sign-in provider. Keep your sign-in details to
yourself. You can delete your account at any time from your account page: that deletes your
stories and what we keep about you, apart from the few records our privacy notice explains.

## 3. What you may post

Only your own story, told truthfully. Nothing unlawful, hateful or abusive, nothing that names
or shows other people without their permission, and nothing that belongs to someone else (music,
film clips, photos) unless you have the right to use it. You keep the copyright in your story;
you let us store it, show it to our moderators and, once approved, publish it on heisreal.today.

## 4. Moderation

Our moderators read, watch or listen to every story before it’s published. They may approve it,
ask you for changes or decline it, and they tell you why. We don’t rewrite your story: if
something needs changing, we ask you.

## 5. Our right to remove content

We may take a story down, or close an account, if it breaks these terms, if the law requires it,
or to protect someone. Where we can, we tell you why.

## 6. Your right to withdraw or delete

Your story stays yours. You can withdraw a story from the site or delete it at any time, and you
can delete your whole account.

## 7. No warranties

We run the site with care, but we provide it as it is, without promising that it will always be
available or free of mistakes. Stories are personal accounts of faith, not advice. Nothing in
these terms limits a liability that the law doesn’t allow us to limit.

## 8. Changes to these terms

When these terms change, we show you what changed and ask you to agree before you use your
account again.

## 9. The law

These terms are governed by the law of England and Wales, and its courts deal with any dispute.
If you live in Scotland or Northern Ireland, you can also go to your local courts.

Questions: [contact email to be confirmed].
" };
};
IF !record::exists(testimonyConsent:0) {
  CREATE testimonyConsent:0 CONTENT { content: "> **Draft, to be reviewed before go-live.**

## Your story

By ticking this box you give He Is Real Today your explicit consent to store and publish every story you submit,
with everything that comes with it: your words, recordings and pictures, the themes you choose
and the name you choose to show. A story about your faith reveals your religious belief, which
UK data protection law treats as special category data (UK GDPR Article 9), so we only keep it
with your explicit consent. This one consent covers every story you share with us.

We keep your story in our database, our moderators review it, and once they approve it we
publish it on heisreal.today.

## Who sees it

While it’s a draft or waiting for review: you and our moderators.
Once it’s approved: anyone visiting heisreal.today.

## Changing your mind

You can withdraw or delete any story, or delete your account, at any time. Withdrawing a story
takes it off the site; deleting your account deletes all your stories and ends this consent.

A draft is deleted automatically after 186 days (about six months) without an edit or a renewed
upload link.

Agreeing to this doesn’t take away your right to object to any edit of your story, or to the way
it’s presented, if you feel it misrepresents you. Our privacy notice explains your other rights.
" };
};
IF !record::exists(socialMediaSharingConsent:0) {
  CREATE socialMediaSharingConsent:0 CONTENT { content: "> **Draft, to be reviewed before go-live.**

This is optional, and it’s for this story only: saying no changes nothing about your story on
heisreal.today.

If you tick the box, you give He Is Real Today permission to share this story, once it’s
published and with the name you chose to show, in these ways and only these:

- on He Is Real Today’s own accounts on YouTube, Instagram, TikTok and Facebook;
- edited and clipped: shorter clips, still images, captions, subtitles and translations, as long
  as they don’t change what you meant;
- given to partner churches and Christian ministries we work with, for their own websites,
  social media accounts and services;
- shown at events and church services, and in printed material such as leaflets and posters;
- in paid adverts that promote He Is Real Today on the platforms above.

Anything not listed, including any platform not named, isn’t covered: we’d ask you first. The
platforms are run by companies outside the UK, mostly in the United States.

## What you’re giving

This is copyright permission: you keep the copyright in your story and let us use it in the ways
above. Once given, it can’t be withdrawn.

## If you change your mind about the story

You can still withdraw or delete the story at any time: from then on we make no new use of it.
We can’t recall copies already shared, by us or by others (reshared posts, partner churches’ own
channels, printed material). If you’d like it taken down from our own social media accounts, ask
us and we’ll look at your request with care.
" };
};
IF !record::exists(privacyNotice:0) {
  CREATE privacyNotice:0 CONTENT { content: "> **Draft, to be reviewed before go-live.**

## Who we are

He Is Real Today (heisreal.today) is a UK not-for-profit; charity registration pending. We share
real stories of Christian faith. We decide how the information on this site is used (we’re its
controller), and we follow UK data protection law. We never sell your information, and we don’t
use it for advertising.

## What we collect

- **Your account.** Clerk, our sign-in provider, holds your email address, your name if you give
  one, and how you sign in. Our own database holds only Clerk’s id for you.
- **Your stories.** What you write, record or upload (text, video, audio and pictures), the
  themes you choose, the name you choose to show, and where each story is in review, with our
  moderators’ notes to you.
- **Your agreements.** Which version of the terms of use and the testimony consent you agreed
  to, and when; and, for each story, whether you agreed to social media sharing.
- **Favourites.** The stories you heart while signed in.
- **Limits and records.** How many stories you’ve started and submitted, to keep things fair,
  and an audit log of what was done on the site and when (internal ids only, never your story).
- **Security logs.** Our servers’ records of requests, such as your IP address and browser, to
  keep the site working and safe.

## Where it’s stored and processed

- **Google Cloud, London:** the website and our services (Cloud Run), our database (SurrealDB
  on Google Kubernetes Engine), our message queue, nightly backups and logs.
- **Bunny.net:** story pictures in London; videos and audio in Frankfurt, Germany, because Bunny
  can’t store them in the UK. Bunny’s network delivers published media from servers around the
  world, through links that expire.
- **Clerk, United States:** sign-in, with your email address and name.
- **Cloudflare:** protects sign-in from bots, for Clerk.
- **Stripe:** payments on our donate page, on Stripe’s own pages.
- **A computer we look after in the UK:** background checks on uploaded videos.

Where information leaves the UK (to Clerk in the United States, Bunny in Germany), the transfer
is protected as UK law requires.

## Why we use it

- **Your stories:** your explicit consent (UK GDPR Articles 9(2)(a) and 6(1)(a)), given with the
  testimony consent.
- **Sharing a story beyond this site:** your consent for that story.
- **Your account and favourites:** to provide the service you signed up for (a contract,
  Article 6(1)(b)).
- **Security logs, limits, the audit log and deleted-account records:** our legitimate interest
  in keeping the site safe, fair and accountable (Article 6(1)(f)).

## How long we keep it

- **Drafts:** deleted automatically after 186 days without an edit or a renewed upload link.
- **Submitted and published stories:** until you delete them or your account. Withdrawing a
  story takes it off the site.
- **Your account:** until you delete it. Then we delete your stories, media, favourites and
  agreements, and Clerk deletes your sign-in details.
- **What stays after that:** a record that an account existed and when it was deleted, under an
  internal number; a one-way fingerprint of your Clerk id, so a deleted account can’t be
  re-created; and the audit log, which holds internal ids only.
- **Backups:** deleted after 30 days.

## Your rights

- **See your data:** Download my data, on your account page, gives you a file of everything we
  hold about you.
- **Correct it:** edit your stories, or your name and email in your account settings; ask us for
  anything else.
- **Delete it:** delete a story, or your whole account, from your account page. That’s also how
  you withdraw your testimony consent.
- **Object or ask us to limit what we do:** write to us.
- **Complain:** to the Information Commissioner’s Office, at
  [ico.org.uk/make-a-complaint](https://ico.org.uk/make-a-complaint/). We’d like the chance to
  put things right first.

## Cookies and storage {#cookies}

We only use the cookies and storage the site needs to work, or to remember a choice you made,
like the theme or a video’s playback speed. We don’t use advertising or tracking cookies, and we
don’t run analytics.

That’s why there’s no cookie banner: nothing here needs your consent. If we ever want to use
anything that isn’t essential, we’ll ask you first.

| Name                      | Set by                                                                                              | What it’s for                                                                                                                                                                                                                                                                                                                                                                                                                                                       | How long                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `theme`                   | This site (local storage)                                                                           | Remembers the light or dark theme you picked. Only saved if you use the theme button.                                                                                                                                                                                                                                                                                                                                                                               | Until you clear it                                       |
| `__client_uat`            | Clerk, our sign-in provider (cookie)                                                                | Tells the site whether you’re signed in, so sign-in works across pages.                                                                                                                                                                                                                                                                                                                                                                                             | 1 year                                                   |
| `__session`               | Clerk (cookie)                                                                                      | Keeps you signed in. Only set when you sign in.                                                                                                                                                                                                                                                                                                                                                                                                                     | Minutes, renewed while you’re signed in                  |
| `__clerk_environment`     | Clerk (local storage)                                                                               | Keeps a copy of the sign-in settings, so sign-in loads quickly.                                                                                                                                                                                                                                                                                                                                                                                                     | Until you clear it                                       |
| `heisreal:device-hearts`  | This site (local storage)                                                                           | The stories you hearted on this device: while signed out, or signed in before agreeing to the terms of use, and which of them were added to an account from here. The list stays in your browser, and we keep no copy of it. To show these stories in My favourites, or to offer adding them to your account, your browser tells our site which stories they are, without saying who you are. Only if you choose Add are they saved to your account. | Until you remove the hearts or clear this browser’s data |
| `__cf_bm`, `_cfuvid`      | Cloudflare, for Clerk, on Clerk’s domain (cookies)                                                  | Protect sign-in from bots.                                                                                                                                                                                                                                                                                                                                                                                                                                          | 30 minutes, or until you close the browser               |
| `bunny_stream_settings_…` | Bunny.net, our video player (local storage, in the video player at player.mediadelivery.net)        | Remembers the playback speed, volume or mute you chose. Only saved if you change one of them.                                                                                                                                                                                                                                                                                                                                                                       | Until you clear it                                       |
| `m`                       | Stripe, our payment provider (a cookie on Stripe’s domain, m.stripe.com, from the donate page only) | Helps Stripe detect fraud before you pay.                                                                                                                                                                                                                                                                                                                                                                                                                           | About 13 months                                          |
| `__clerk_db_jwt`          | Clerk, on the development site only (cookie)                                                        | Connects your browser to Clerk’s development setup.                                                                                                                                                                                                                                                                                                                                                                                                                 | 1 year                                                   |

Clerk’s optional product telemetry is turned off, so it neither stores anything nor sends usage
data.

Story videos and audio, and our founder’s introduction on the About page, play in Bunny.net’s
player. It stores nothing on your device unless you change a player setting (listed above).
While a video plays, it sends Bunny playback statistics (which video, and how long it played) so
we can tell that videos work.

## Donations {#donations}

Donations are processed by Stripe, our payment provider, on its own secure pages, and
[Stripe’s privacy policy](https://stripe.com/gb/privacy) applies to the details you give there.
We never see your card details, and we keep no record of your donation on this site.

## Questions

Email us at [contact email to be confirmed].
" };
};
-- C1: the agreed-at times are the database's (the fields' VALUE clauses), never supplied here.
UPDATE user SET termsOfUse = termsOfUseAgreement:0, termsOfUseAgreedAt = time::now()
  WHERE gdprDeletedAt = NONE AND termsOfUse = NONE;
UPDATE user SET testimonyConsent = testimonyConsent:0, testimonyConsentAgreedAt = time::now()
  WHERE gdprDeletedAt = NONE AND testimonyConsent = NONE;
DELETE _setting:consent;
DELETE auditLog WHERE action IN ['GrantConsent', 'WithdrawConsent', 'CreateDpaDraft', 'PublishDpa',
    'PublishPrivacyPolicy', 'PublishTerms']
  OR reason IN ['consent_withdrawn', 'consent_required', 'consent_restored']
  OR service = 'housekeeping' OR consentType != NONE OR dpaVersion != NONE;
