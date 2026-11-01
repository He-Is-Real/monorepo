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
    title: `Privacy notice, version ${number}`,
    description: `Version ${number} of the privacy notice of He Is Real Today, as it was in force.`,
    path: `/privacy/versions/${number}`,
  });
}

/** One version of the privacy notice, kept for ever (plan 4e). */
export default async function PrivacyVersionPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  return <DocumentVersion document="privacy-notice" number={number} />;
}
