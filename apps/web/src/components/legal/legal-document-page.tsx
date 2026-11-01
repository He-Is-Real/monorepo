import Link from 'next/link';
import { LegalMarkdown } from '@/components/legal/legal-markdown';
import { NarrowColumn } from '@/components/page/page-header';
import type { LegalVersion } from '@/lib/legal';
import {
  DOCUMENT_TITLES,
  documentHref,
  documentVersionHref,
  longDate,
  type PublicDocument,
} from '@/lib/legal-text';

const LINK =
  'inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline';

/**
 * A legal text's page (plan 4e): /privacy and /terms show the latest version (the privacy notice,
 * the terms of use), /privacy/versions/<n> and /terms/versions/<n> any version from 0, in the
 * site's own formatting, with its number and date and the other versions. Every version is kept
 * for ever, so a person can read exactly what they agreed to, or were told.
 */
export function LegalDocumentPage({
  document,
  version,
  text,
  latest,
  versions,
}: {
  document: PublicDocument;
  /** The version shown; null when it can't be read. */
  version: LegalVersion | null;
  text: string | null;
  /** The latest version's number (null when unknown). */
  latest: number | null;
  /** Every version, newest first (for "Other versions"). */
  versions: LegalVersion[];
}) {
  const inForce = latest;
  const title = DOCUMENT_TITLES[document];
  const others = versions.filter((v) => v.version !== version?.version);
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
            data-legal-version={version.version}
          >
            <p
              className="mb-8 text-sm text-muted-foreground"
              data-version-line=""
            >
              Version {version.version}, in force from{' '}
              <time dateTime={version.releaseDate}>
                {longDate(version.releaseDate)}
              </time>
            </p>
            {inForce !== null && inForce !== version.version && (
              <p
                role="note"
                className="mb-8 rounded-xl border border-border bg-raised px-4 py-3 text-sm text-foreground"
              >
                This is an earlier version, kept so you can see what it said.{' '}
                <Link href={documentHref(document)} className={LINK}>
                  Read the latest {title.toLowerCase()} (version {inForce})
                </Link>
              </p>
            )}
            {/* From 1024 px the page has room either side of its reading column: its tables
                widen into it by the same amount on both sides. Not in a card, which has none. */}
            <LegalMarkdown
              text={text}
              className="lg:[&_[data-legal-table]]:-mx-16"
            />
          </article>
        ) : (
          <p className="text-secondary-text" data-legal-problem="unavailable">
            The {title.toLowerCase()} can’t be shown right now. Please try again
            in a moment.
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
              {version && version.version !== inForce
                ? 'Other versions'
                : 'Previous versions'}
            </h2>
            <ul className="space-y-1 text-secondary-text">
              {others.map((v) => (
                <li key={v.version} data-version={v.version}>
                  <Link
                    href={
                      v.version === inForce
                        ? documentHref(document)
                        : documentVersionHref(document, v.version)
                    }
                    className={LINK}
                  >
                    Version {v.version}
                    {v.version === inForce ? ' (latest)' : ''}, in force from{' '}
                    {longDate(v.releaseDate)}
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
