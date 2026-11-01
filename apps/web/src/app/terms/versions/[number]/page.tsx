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
    title: `Terms of use, version ${number}`,
    description: `Version ${number} of the terms of use of He Is Real Today, as it was in force.`,
    path: `/terms/versions/${number}`,
  });
}

/** One version of the terms of use, kept for ever (plan 4e). */
export default async function TermsVersionPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  return <DocumentVersion document="terms-of-use" number={number} />;
}
