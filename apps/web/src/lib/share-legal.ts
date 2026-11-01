import { getLegalDocument } from './legal';
import { renderLegalMarkdown } from './markdown';

// The text the submit flow shows at its end (plan 4e): the latest social media sharing consent,
// read server-side from api-public-read (D32) through lib/legal, so what the person reads is the
// version they agree to. The testimony consent is read in the browser's step (agreement-step.tsx),
// which knows which version the person agreed to.

/** The social media sharing consent as the Review step shows it. */
export interface SharingConsent {
  /** The latest version, which a ticked box sends back. */
  version: number;
  /** Its words (they name every platform), rendered under the flow's h2 steps. */
  html: string;
}

/** What the submit flow shows: `sharing` is null when it can't be read (the box isn't offered). */
export interface ShareLegal {
  sharing: SharingConsent | null;
}

export async function getShareLegal(): Promise<ShareLegal> {
  const doc = await getLegalDocument('social-media-sharing-consent');
  return {
    sharing: doc
      ? {
          version: doc.latest.version,
          html: renderLegalMarkdown(doc.latest.content, { topLevel: 3 }),
        }
      : null,
  };
}
