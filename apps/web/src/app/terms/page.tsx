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
 * The terms of use (D121, D125): the version in force, which the sign-up form's "I agree to the
 * terms of use" binds (D122), as Markdown an Admin publishes at /admin/legal.
 */
export default function TermsPage() {
  return <CurrentDocument document="terms" />;
}
