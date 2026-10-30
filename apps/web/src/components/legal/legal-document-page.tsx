import Link from 'next/link';
import { LegalMarkdown } from '@/components/legal/legal-markdown';
import { NarrowColumn } from '@/components/page/page-header';
import type { LegalDocumentVersion } from '@/lib/legal';
import {
  DOCUMENT_TITLES,
  documentHref,
  documentVersionHref,
  type LegalDocumentName,
} from '@/lib/legal-text';

/** "29 October 2026", the same on the server and in the browser. */
export const publishedOn = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));

const LINK =
  'inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline';

/**
 * A legal document's page (D121, D125): /privacy and /terms show the version in force,
 * /privacy/versions/<n> and /terms/versions/<n> any version, in the site's own formatting, with
 * its number and date and the other versions. Every version is kept for ever, so a person can
 * read exactly what they agreed to.
 */
export function LegalDocumentPage({
  document,
  version,
  text,
  inForce,
  versions,
  problem,
}: {
  document: LegalDocumentName;
  /** The version shown; null when there's nothing to show (`problem` says why). */
  version: LegalDocumentVersion | null;
  text: string | null;
  /** The number of the version in force (null while none). */
  inForce: number | null;
  /** Every version, newest first (for "Other versions"). */
  versions: LegalDocumentVersion[];
  problem?: 'not_published' | 'unavailable';
}) {
  const title = DOCUMENT_TITLES[document];
  const others = versions.filter((v) => v.number !== version?.number);
  return (
    <main id="main" className="flex-1 py-12 sm:py-20">
      <NarrowColumn>
        <h1 className="mb-3 text-[2rem] leading-tight font-normal sm:text-[2.75rem]">
          {title}
        </h1>
        {version && text !== null ? (
          <article
            aria-label={title}
            data-legal-document={document}
            data-legal-version={version.number}
          >
            <p
              className="mb-8 text-sm text-muted-foreground"
              data-version-line=""
            >
              Version {version.number}, published{' '}
              <time dateTime={version.publishedAt}>
                {publishedOn(version.publishedAt)}
              </time>
            </p>
            {inForce !== null && inForce !== version.number && (
              <p
                role="note"
                className="mb-8 rounded-xl border border-border bg-raised px-4 py-3 text-sm text-foreground"
              >
                This is an earlier version, kept so you can see what it said.{' '}
                <Link href={documentHref(document)} className={LINK}>
                  Read the current {title.toLowerCase()} (version {inForce})
                </Link>
              </p>
            )}
            <LegalMarkdown text={text} />
          </article>
        ) : (
          <p className="text-secondary-text" data-legal-problem={problem}>
            {problem === 'unavailable'
              ? `The ${title.toLowerCase()} can’t be shown right now. Please try again in a moment.`
              : `The ${title.toLowerCase()} hasn’t been published yet.`}
          </p>
        )}
        {others.length > 0 && (
          <section
            aria-labelledby="other-versions"
            className="mt-12 border-t border-border pt-6"
            data-document-versions={document}
          >
            <h2
              id="other-versions"
              className="mb-2 text-lg font-semibold text-foreground"
            >
              {version && version.number !== inForce
                ? 'Other versions'
                : 'Previous versions'}
            </h2>
            <ul className="space-y-1 text-secondary-text">
              {others.map((v) => (
                <li key={v.number} data-version={v.number}>
                  <Link
                    href={
                      v.number === inForce
                        ? documentHref(document)
                        : documentVersionHref(document, v.number)
                    }
                    className={LINK}
                  >
                    Version {v.number}
                    {v.number === inForce ? ' (current)' : ''}, published{' '}
                    {publishedOn(v.publishedAt)}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </NarrowColumn>
    </main>
  );
}
