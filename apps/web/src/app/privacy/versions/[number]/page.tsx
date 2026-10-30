import { DocumentVersion } from '@/components/legal/legal-routes';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  return pageMetadata({
    title: `Privacy policy, version ${number}`,
    description: `Version ${number} of the privacy policy of He Is Real Today, as it was published.`,
    path: `/privacy/versions/${number}`,
  });
}

/** One version of the privacy policy, kept for ever (D125). */
export default async function PrivacyVersionPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  return <DocumentVersion document="privacy" number={number} />;
}
