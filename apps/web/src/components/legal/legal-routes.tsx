import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { LegalDocumentPage } from '@/components/legal/legal-document-page';
import {
  getLegalDocument,
  getLegalDocumentVersion,
  type PublicDocument,
} from '@/lib/legal';

/**
 * /privacy and /terms (plan 4e): the latest version, read per request from api-public-read (D32),
 * so a version an admin saves shows at once.
 */
export async function CurrentDocument({
  document,
}: {
  document: PublicDocument;
}) {
  await connection();
  const doc = await getLegalDocument(document);
  return (
    <LegalDocumentPage
      document={document}
      version={doc?.latest ?? null}
      text={doc?.latest.content ?? null}
      latest={doc?.latest.version ?? null}
      versions={doc?.versions ?? []}
    />
  );
}

/** /privacy/versions/<n> and /terms/versions/<n> (from 0): one version, kept for ever. */
export async function DocumentVersion({
  document,
  number,
}: {
  document: PublicDocument;
  number: string;
}) {
  await connection();
  if (!/^(0|[1-9][0-9]{0,8})$/.test(number)) notFound();
  const [version, doc] = await Promise.all([
    getLegalDocumentVersion(document, Number(number)),
    getLegalDocument(document),
  ]);
  if (!version) notFound();
  return (
    <LegalDocumentPage
      document={document}
      version={version}
      text={version.content}
      latest={doc?.latest.version ?? (version.latest ? version.version : null)}
      versions={doc?.versions ?? []}
    />
  );
}
