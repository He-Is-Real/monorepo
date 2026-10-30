import type { LegalDocumentPdf, LegalDocumentVersion } from '@/lib/legal';
import { documentPdfHref, type LegalDocumentName } from '@/lib/legal-text';

/** "29 October 2026", the same on the server and in the browser. */
const published = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));

const LINK =
  'inline-flex min-h-11 items-center gap-2 font-medium text-link underline-offset-4 hover:text-link-hover hover:underline';

function PdfIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-4 shrink-0 fill-none stroke-current"
      strokeWidth="2"
    >
      <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" />
    </svg>
  );
}

/**
 * A legal document's versions of record (D121), under its words: this version's PDF and, folded
 * away, its earlier versions, each with when it was published, what changed and its PDF. Plain
 * links to web's own PDF route: the browser shows or saves the PDF itself (Joel, 2026-10-29: "not
 * in popup form").
 */
export function DocumentVersions({
  document,
  version,
  pdf,
  previous,
}: {
  document: LegalDocumentName;
  version: string;
  pdf: LegalDocumentPdf | null | undefined;
  previous: LegalDocumentVersion[];
}) {
  if (!pdf && previous.length === 0) return null;
  return (
    <div className="space-y-2" data-document-versions={document}>
      {pdf && (
        <a
          href={documentPdfHref(document, version)}
          className={LINK}
          data-document-pdf=""
        >
          <PdfIcon />
          Download this version (PDF)
        </a>
      )}
      {previous.length > 0 && (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-medium text-link hover:text-link-hover">
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-4 shrink-0 fill-none stroke-current transition-transform group-open:rotate-90"
              strokeWidth="2"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            Previous versions
          </summary>
          <ul
            className="mt-2 space-y-3 border-l-2 border-border pl-4 text-secondary-text [overflow-wrap:anywhere]"
            data-previous-versions=""
          >
            {previous.map((v) => (
              <li key={v.id} data-version={v.id}>
                <p className="text-foreground">
                  Version {v.id.replace(/^v/, '')}, published{' '}
                  <time dateTime={v.publishedAt}>
                    {published(v.publishedAt)}
                  </time>
                </p>
                {v.changeNote && <p className="text-sm">{v.changeNote}</p>}
                {v.pdf && (
                  <a
                    href={documentPdfHref(document, v.id)}
                    className={LINK}
                    aria-label={`Download version ${v.id.replace(/^v/, '')} (PDF)`}
                  >
                    <PdfIcon />
                    Download (PDF)
                  </a>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
