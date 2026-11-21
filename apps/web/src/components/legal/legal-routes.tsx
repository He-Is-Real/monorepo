import { cacheLife } from 'next/cache';
import { notFound } from 'next/navigation';
import { LegalDocumentPage } from '@/components/legal/legal-document-page';
import {
  getLegalDocument,
  getLegalDocumentVersion,
  type PublicDocument,
} from '@/lib/legal';
import { cachedPage, type PageCacheLife } from '@/lib/page-cache';

const CURRENT_PATH = {
  'privacy-notice': '/privacy',
  'terms-of-use': '/terms',
} as const;

const VERSION_PATH = {
  'privacy-notice': '/privacy/versions/[number]',
  'terms-of-use': '/terms/versions/[number]',
} as const;

/** Thrown inside a saved copy's render when a text can't be read, so that render isn't kept. */
class NotKept extends Error {}

/**
 * /privacy and /terms (plan 4e): the latest version from api-public-read (D32), per request or
 * from the page's saved copy (page-cache.config.ts), so a version an admin saves shows within
 * that time.
 */
export function CurrentDocument({ document }: { document: PublicDocument }) {
  return cachedPage(
    CURRENT_PATH[document],
    (life) => savedCurrent(life, document),
    () => renderCurrent(document, false),
  );
}

async function savedCurrent(life: PageCacheLife, document: PublicDocument) {
  'use cache';
  cacheLife(life);
  return renderCurrent(document, true);
}

async function renderCurrent(document: PublicDocument, keep: boolean) {
  const doc = await getLegalDocument(document);
  if (!doc && keep) throw new NotKept();
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
export function DocumentVersion({
  document,
  number,
}: {
  document: PublicDocument;
  number: string;
}) {
  if (!/^(0|[1-9][0-9]{0,8})$/.test(number)) notFound();
  return cachedPage(
    VERSION_PATH[document],
    (life) => savedVersion(life, document, number),
    () => renderVersion(document, number, false),
  );
}

async function savedVersion(
  life: PageCacheLife,
  document: PublicDocument,
  number: string,
) {
  'use cache';
  cacheLife(life);
  return renderVersion(document, number, true);
}

async function renderVersion(
  document: PublicDocument,
  number: string,
  keep: boolean,
) {
  const [version, doc] = await Promise.all([
    getLegalDocumentVersion(document, Number(number)),
    getLegalDocument(document),
  ]);
  // A missing version or list isn't kept: the fresh render answers it (404, or without the list).
  if (keep && (!version || !doc)) throw new NotKept();
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
