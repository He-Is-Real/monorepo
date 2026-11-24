import { LegalMarkdown } from '@/components/legal/legal-markdown';
import { NarrowColumn } from '@/components/page/page-header';
import { TextLink } from '@/components/page/text-link';
import type { LegalVersion } from '@/lib/legal';
import {
  DOCUMENT_TITLES,
  documentHref,
  documentVersionHref,
  longDate,
  type PublicDocument,
} from '@/lib/legal-text';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';
import { Heading, Notice, Text } from '@heisreal/web-ui';

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
        <Heading level={1} className="mb-3">
          {title}
        </Heading>
        {version && text !== null ? (
          <article
            aria-label={title}
            data-legal-document={document}
            data-legal-version={version.version}
          >
            <Text
              size="small"
              tone="quiet"
              className="mb-8"
              data-version-line=""
            >
              Version {version.version}, in force from{' '}
              <time dateTime={version.releaseDate}>
                {longDate(version.releaseDate)}
              </time>
            </Text>
            {inForce !== null && inForce !== version.version && (
              <Notice kind="info" as="p" role="note" className="mb-8">
                <Text as="span" size="small">
                  This is an earlier version, kept so you can see what it said.{' '}
                  <TextLink href={documentHref(document)} touch>
                    Read the latest {title.toLowerCase()} (version {inForce})
                  </TextLink>
                </Text>
              </Notice>
            )}
            {/* From 1024 px the page has room either side of its reading column: its tables
                widen into it by the same amount on both sides. Not in a card, which has none. */}
            <LegalMarkdown
              text={text}
              className="lg:[&_[data-legal-table]]:-mx-16"
            />
          </article>
        ) : (
          <Notice kind="danger" as="p" data-legal-problem="unavailable">
            {TRY_AGAIN_LATER}
          </Notice>
        )}
        {others.length > 0 && (
          <section
            aria-labelledby="other-versions"
            className="mt-12 border-t border-border pt-6"
            data-document-versions={document}
          >
            <Heading level={2} size="sub" id="other-versions" className="mb-2">
              {version && version.version !== inForce
                ? 'Other versions'
                : 'Previous versions'}
            </Heading>
            <Text as="ul" size="inherit" tone="quiet" className="space-y-1">
              {others.map((v) => (
                <li key={v.version} data-version={v.version}>
                  <TextLink
                    kind="standalone"
                    href={
                      v.version === inForce
                        ? documentHref(document)
                        : documentVersionHref(document, v.version)
                    }
                  >
                    Version {v.version}
                    {v.version === inForce ? ' (latest)' : ''}, in force from{' '}
                    {longDate(v.releaseDate)}
                  </TextLink>
                </li>
              ))}
            </Text>
          </section>
        )}
      </NarrowColumn>
    </main>
  );
}
