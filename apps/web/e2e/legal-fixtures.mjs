// The four legal texts' versions both stubs serve (plan 4e): version 0 of each is the database's
// own seed (libs/database/schema/data/0009-consent-4e.surql, read here so the words stay the
// same), and a few later versions change some words, so the redlines (re-agreeing, admin) and the
// "Previous versions" lists have something to show. The latest is the highest number.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEED = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../libs/database/schema/data/0009-consent-4e.surql',
  ),
  'utf8',
);
/** Version 0 of `table`, as the data script creates it. */
function seed(table) {
  const match = new RegExp(
    `CREATE ${table}:0 CONTENT \\{ content: "((?:[^"\\\\]|\\\\.)*)" \\}`,
  ).exec(SEED);
  if (!match) throw new Error(`no version 0 of ${table} in the seed`);
  return match[1].replace(/\\(.)/g, '$1');
}
const edit = (text, from, to) => {
  if (!text.includes(from)) throw new Error(`fixture edit not found: ${from}`);
  return text.replace(from, to);
};
const day = (d) => `2026-10-${String(d).padStart(2, '0')}T12:00:00.000Z`;

const terms0 = seed('termsOfUseAgreement');
const terms1 = edit(
  terms0,
  'Keep your sign-in details to\nyourself.',
  'Keep your sign-in details to\nyourself, and tell us if someone else uses your account.',
);
const terms2 = edit(
  terms1,
  'Only your own story, told truthfully.',
  'Only your own story, told truthfully and in your own words.',
);

const testimony0 = seed('testimonyConsent');
const testimony1 = edit(
  testimony0,
  'anyone visiting heisreal.today.',
  'anyone visiting heisreal.today, anywhere in the world.',
);
const testimony2 = edit(
  testimony1,
  'delete your account, at any time.',
  'delete your account, at any time, from your profile.',
);
const testimony3 = edit(
  testimony2,
  'store and publish every story you submit',
  'store, review and publish every story you submit',
);

const sharing0 = seed('socialMediaSharingConsent');
const sharing1 = edit(
  sharing0,
  'YouTube, Instagram, TikTok and Facebook;',
  'YouTube, Instagram, TikTok, Facebook and WhatsApp;',
);

const privacy1 = seed('privacyNotice');
const privacy0 = privacy1.slice(0, privacy1.indexOf('## Donations'));

/** Each text's versions, oldest first (the index is the version number). */
export const LEGAL_VERSIONS = {
  'terms-of-use': [
    { content: terms0, releaseDate: day(1) },
    { content: terms1, releaseDate: day(10) },
    { content: terms2, releaseDate: day(20) },
  ],
  'testimony-consent': [
    { content: testimony0, releaseDate: day(1) },
    { content: testimony1, releaseDate: day(3) },
    { content: testimony2, releaseDate: day(12) },
    { content: testimony3, releaseDate: day(22) },
  ],
  'social-media-sharing-consent': [
    { content: sharing0, releaseDate: day(1) },
    { content: sharing1, releaseDate: day(15) },
  ],
  'privacy-notice': [
    { content: privacy0, releaseDate: day(1) },
    { content: privacy1, releaseDate: day(25) },
  ],
};

/** The latest version's number of each text. */
export const LATEST = Object.fromEntries(
  Object.entries(LEGAL_VERSIONS).map(([d, v]) => [d, v.length - 1]),
);
