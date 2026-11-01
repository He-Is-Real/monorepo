import { CurrentDocument } from '@/components/legal/legal-routes';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'Privacy notice',
    description:
      'How He Is Real Today looks after your data, and the few cookies and storage items the site needs to work.',
    path: '/privacy',
  });
}

/**
 * The privacy notice (plan 4e): the latest version, shown and versioned but never agreed to, as
 * Markdown an Admin saves at /admin/consent, in the site's formatting. Its cookie and storage
 * table (PECR reg. 6(4): all strictly necessary, so no banner) is part of the text.
 */
export default function PrivacyPage() {
  return <CurrentDocument document="privacy-notice" />;
}
