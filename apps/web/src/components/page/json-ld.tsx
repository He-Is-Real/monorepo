import { jsonLdScript } from '@/lib/seo';

/** schema.org structured data, safely embedded (jsonLdScript escapes `<`). */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }}
    />
  );
}
