import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { LegalDocumentPage } from '@/components/legal/legal-document-page';
import {
  getLegalDocument,
  getLegalDocumentVersion,
  type LegalDocumentName,
} from '@/lib/legal';

/**
 * /privacy and /terms (D121, D125): the version in force, read per request from
 * api-public-read (D32), so a version an admin publishes shows at once.
 */
export async function CurrentDocument({
  document,
}: {
  document: LegalDocumentName;
}) {
  await connection();
  const doc = await getLegalDocument(document);
  return (
    <LegalDocumentPage
      document={document}
      version={doc?.current ?? null}
      text={doc?.current?.text ?? null}
      inForce={doc?.current?.number ?? null}
      versions={doc?.versions ?? []}
      problem={doc ? 'not_published' : 'unavailable'}
    />
  );
}

/** /privacy/versions/<n> and /terms/versions/<n>: one version, kept for ever (D125). */
export async function DocumentVersion({
  document,
  number,
}: {
  document: LegalDocumentName;
  number: string;
}) {
  await connection();
  if (!/^[1-9][0-9]{0,8}$/.test(number)) notFound();
  const [version, doc] = await Promise.all([
    getLegalDocumentVersion(document, Number(number)),
    getLegalDocument(document),
  ]);
  if (!version) notFound();
  return (
    <LegalDocumentPage
      document={document}
      version={version}
      text={version.text}
      inForce={
        doc?.current?.number ?? (version.current ? version.number : null)
      }
      versions={doc?.versions ?? []}
    />
  );
}
