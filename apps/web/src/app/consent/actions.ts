'use server';

import {
  getLegalDocument,
  getLegalDocumentVersion,
  type LegalDocumentName,
  type LegalVersion,
} from '@/lib/legal';
import { renderLegalMarkdown } from '@/lib/markdown';
import { redline, type RedlineItem } from '@/lib/redline';

/** The texts someone agrees to in their browser: on their account, or per story. */
const AGREED: LegalDocumentName[] = [
  'terms-of-use',
  'testimony-consent',
  'social-media-sharing-consent',
];

export type AgreementTexts =
  | {
      ok: true;
      /** The latest version (the one to agree to), rendered. */
      latest: LegalVersion & { html: string };
      /** The version compared from, when it's older than the latest. */
      from: LegalVersion | null;
      /** What changed from `from` to the latest; null without `from`. */
      redline: RedlineItem[] | null;
    }
  | { ok: false };

/**
 * A text to agree to, as its step shows it (plan 4e): the latest version, rendered, and what
 * changed since `from` (the version the person agreed to, or the one the page showed before a
 * newer one was saved), in one go however many versions came between. Read by web's server from
 * api-public-read like every page (D32); `from` is only a version number, nothing about who asks.
 * Anyone can call a server action, so the input is checked again here.
 */
export async function agreementTexts(
  document: unknown,
  from: unknown,
): Promise<AgreementTexts> {
  if (
    typeof document !== 'string' ||
    !AGREED.includes(document as LegalDocumentName) ||
    !(
      from === null ||
      (Number.isInteger(from) &&
        (from as number) >= 0 &&
        (from as number) < 1e9)
    )
  )
    return { ok: false };
  const name = document as LegalDocumentName;
  const doc = await getLegalDocument(name);
  if (!doc) return { ok: false };
  const latest = {
    version: doc.latest.version,
    releaseDate: doc.latest.releaseDate,
    html: renderLegalMarkdown(doc.latest.content, { topLevel: 3 }),
  };
  if (from === null || (from as number) >= doc.latest.version)
    return { ok: true, latest, from: null, redline: null };
  let before;
  try {
    before = await getLegalDocumentVersion(name, from as number);
  } catch {
    return { ok: false };
  }
  if (!before) return { ok: false };
  return {
    ok: true,
    latest,
    from: { version: before.version, releaseDate: before.releaseDate },
    redline: redline(before.content, doc.latest.content),
  };
}
