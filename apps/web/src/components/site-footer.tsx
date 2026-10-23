import { consentChecksRelaxed } from '@/lib/site-status';

/**
 * The site footer. For now only D48's note: in dev, while consent checks are relaxed for dummy
 * data, every page says so. Renders nothing otherwise.
 */
export async function SiteFooter() {
  if (!(await consentChecksRelaxed())) return null;
  return (
    <footer className="border-t border-border">
      <p className="mx-auto max-w-site px-4 py-3 text-center text-xs text-secondary-text sm:px-10">
        Consent checks relaxed (dev)
      </p>
    </footer>
  );
}
