import { LegalHtml } from '@/components/legal/legal-html';
import { documentVersionHref, type LegalDocumentName } from '@/lib/legal-text';

const SUMMARY: Record<LegalDocumentName, string> = {
  privacy: 'Read the privacy policy',
  terms: 'Read the terms of use',
};

/**
 * A legal document a consent grant binds (D122), folded away to read on the page, with a link
 * to its own numbered page (D125): the same card on the sign-up step and in the share flow, so
 * what's agreed to is what was shown. A native `<details>`, so keyboards and screen readers get
 * the browser's own disclosure. `data-<name>-document` carries the version's record id.
 */
export function LegalDocumentDetails({
  name,
  version,
  number,
  html,
  className = '',
}: {
  name: LegalDocumentName;
  /** The version's record id, which the grant names. */
  version: string;
  number: number;
  /** Its words, rendered by the server (lib/markdown.ts). */
  html: string;
  className?: string;
}) {
  return (
    <details
      className={`group rounded-2xl border border-border bg-card ${className}`.trim()}
    >
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl px-5 py-3 font-medium text-link hover:text-link-hover">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-4 shrink-0 fill-none stroke-current transition-transform group-open:rotate-90"
          strokeWidth="2"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
        {SUMMARY[name]}
      </summary>
      <div
        {...{ [`data-${name}-document`]: version }}
        className="space-y-4 border-t border-border px-5 py-4"
      >
        <LegalHtml html={html} />
        <a
          href={documentVersionHref(name, number)}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-11 items-center font-medium text-link underline-offset-4 hover:text-link-hover hover:underline"
        >
          Version {number}, on its own page (opens in a new tab)
        </a>
      </div>
    </details>
  );
}
