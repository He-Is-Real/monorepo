import {
  type ConsentBox,
  type ConsentFormName,
  getConsentForm,
  type LegalBlock,
  parseLegalText,
} from './legal';

// The consent forms the submit flow asks on (D67, D84, D93), read server-side from api-public-read
// (D32) through lib/legal's version-bound reader: each form version comes with the privacy
// document *that version* links (`GET /v1/legal/dpa?version=…`), never just the one in force, so
// what the person reads is what they agree to.

/** A form version as the submit flow shows it: words to read, boxes to tick, its privacy document. */
export interface ShareForm {
  /** The version in force, which every grant names (D84). */
  version: string;
  /** Its boxes and the words beside each, from the version's statements data (D114). */
  boxes: ConsentBox[];
  /** The form's words: a document to read, never the source of a box. */
  blocks: LegalBlock[];
  /** The privacy document this version links, and its words. */
  dpaVersion: string;
  dpaBlocks: LegalBlock[];
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
    blocks: parseLegalText(result.form.text),
    dpaVersion: result.dpa.id,
    dpaBlocks: parseLegalText(result.dpa.text),
  };
}

/** The testimony form and the optional social sharing form in force, each with its own privacy document. */
export async function getShareLegal(): Promise<ShareLegal> {
  const [testimony, social] = await Promise.all([
    shareForm('testimony'),
    shareForm('social'),
  ]);
  return { testimony, social };
}
