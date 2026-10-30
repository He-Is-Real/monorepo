import { type ConsentBox, type ConsentFormName, getConsentForm } from './legal';
import { renderLegalMarkdown } from './markdown';

// The consent forms the submit flow asks on (D67, D84, D93), read server-side from api-public-read
// (D32) through lib/legal: each form version in force with the privacy policy in force, which
// every grant names (D122), so what the person reads is what they agree to.

/** A form version as the submit flow shows it: words to read, boxes to tick, the privacy policy. */
export interface ShareForm {
  /** The version in force, which every grant names (D84). */
  version: string;
  /** Its boxes and the words beside each, from the version's statements data (D114). */
  boxes: ConsentBox[];
  /**
   * The form's words, rendered (lib/markdown.ts, under the flow's h2 steps): a document to
   * read, never the source of a box.
   */
  html: string;
  /**
   * The privacy policy in force, which the grant names (D122): its id, its number (for
   * /privacy/versions/<n>) and its words, rendered.
   */
  privacyVersion: string;
  privacyNumber: number;
  privacyHtml: string;
}

/** What the submit flow shows: `null` for a form that isn't published or can't be read. */
export interface ShareLegal {
  testimony: ShareForm | null;
  social: ShareForm | null;
}

async function shareForm(form: ConsentFormName): Promise<ShareForm | null> {
  const result = await getConsentForm(form);
  if (result.kind !== 'ok') return null;
  return {
    version: result.form.id,
    boxes: result.form.boxes,
    html: renderLegalMarkdown(result.form.text, { topLevel: 3 }),
    privacyVersion: result.privacy.current.id,
    privacyNumber: result.privacy.current.number,
    privacyHtml: renderLegalMarkdown(result.privacy.current.text, {
      topLevel: 3,
    }),
  };
}

/** The testimony form and the optional social sharing form in force, each with the privacy policy. */
export async function getShareLegal(): Promise<ShareLegal> {
  const [testimony, social] = await Promise.all([
    shareForm('testimony'),
    shareForm('social'),
  ]);
  return { testimony, social };
}
