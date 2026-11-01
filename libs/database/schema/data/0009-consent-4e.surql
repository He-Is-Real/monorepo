-- data/0009-consent-4e.surql (runs once; recorded in _migration by the runner, in the same
-- transaction). Plan 4e (Joel, 2026-10-31 and 2026-11-01; privacy-consent-architecture.html 4e,
-- 8b): the consent, privacy and terms redesign. The schema step has already removed the old
-- machinery (the consent ledger, dpaVersion, termsVersion, the form-version tables, legalFence,
-- erasureRequest and their rows: all dummy data); this script
--   * seeds version 0 of each of the four texts, in every environment, unless it exists. They are
--     placeholders until an Admin saves version 1 at /admin/consent. Nobody has agreed to them:
--     people agree in their own session (the terms before using their account, the testimony
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
  CREATE termsOfUseAgreement:0 CONTENT { content: "> **This is a placeholder.** The real terms of use come before the site goes live.

## 1. Who can use the site

He Is Real Today is for adults only. You must be 18 or over to have an account, and by agreeing
to these terms you confirm that you are.

## 2. Your account

Your account lets you share stories and keep your favourites. Keep your sign-in details to
yourself. You can delete your account at any time from your account page: that deletes your
stories and everything we keep about you.

## 3. What you may post

Only your own story, told truthfully. Nothing unlawful, hateful or that names other people without
their permission. Our moderators read every story before it is published and may ask for changes
or decline it.

## 4. Changes to these terms

When these terms change, we show you what changed and ask you to agree before you use your
account again.
" };
};
IF !record::exists(testimonyConsent:0) {
  CREATE testimonyConsent:0 CONTENT { content: "> **This is a placeholder.** The real testimony consent comes before the site goes live.

## Your story

By ticking this box you let He Is Real Today store and publish every story you submit, which
shows your Christian faith. The law treats what it says about your faith as sensitive
information, so we need your explicit consent before we keep anything you write, record or
upload.

## Who sees it

Our moderators, before it is published, and then anyone visiting heisreal.today.

## Changing your mind

You can withdraw or delete any story, or delete your account, at any time.
" };
};
IF !record::exists(socialMediaSharingConsent:0) {
  CREATE socialMediaSharingConsent:0 CONTENT { content: "> **This is a placeholder.** The real wording comes before the site goes live.

This is optional: saying no changes nothing about your story on heisreal.today.

If you tick the box, you give He Is Real Today permission to share this story, with the name you
chose to show, in these ways and only these:

- on He Is Real Today's own accounts on YouTube, Instagram, TikTok and Facebook;
- edited and clipped: shorter clips, still images, captions, subtitles and translations, as long
  as they don't change what you meant;
- given to partner churches and Christian ministries for their own websites, social media
  accounts and services;
- shown at events and church services, and in printed material such as leaflets and posters;
- in paid adverts that promote He Is Real Today on the platforms above.

This permission to share (copyright permission) can't be withdrawn. You can still withdraw or
delete the story at any time: from then on we make no new use of it, but we can't recall copies
already shared.
" };
};
IF !record::exists(privacyNotice:0) {
  CREATE privacyNotice:0 CONTENT { content: "> **This is a placeholder.** The real privacy notice, covering the stories people share and how
> we look after them, comes before the site goes live.

He Is Real Today is a UK-based not-for-profit. We follow UK data protection law, and we only
collect what we need to run the site.

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

Email us at [info@heisreal.today](mailto:info@heisreal.today).
" };
};
DELETE _setting:consent;
DELETE auditLog WHERE action IN ['GrantConsent', 'WithdrawConsent', 'CreateDpaDraft', 'PublishDpa',
    'PublishPrivacyPolicy', 'PublishTerms']
  OR reason IN ['consent_withdrawn', 'consent_required', 'consent_restored']
  OR service = 'housekeeping' OR consentType != NONE OR dpaVersion != NONE;
