import { CurrentDocument } from '@/components/legal/legal-routes';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'Terms of use',
    description: 'The terms for using He Is Real Today.',
    path: '/terms',
  });
}

/**
 * The terms of use (plan 4e): the latest version, which people agree to before using their
 * account (/consent/terms), as Markdown an Admin saves at /admin/consent.
 */
export default function TermsPage() {
  return <CurrentDocument document="terms-of-use" />;
}
