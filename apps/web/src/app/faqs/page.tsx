import { cacheLife } from 'next/cache';
import { Accordion, Heading, Text } from '@heisreal/web-ui';
import { ButtonLink } from '@/components/page/button-link';
import { JsonLd } from '@/components/page/json-ld';
import { NarrowColumn, PageHeader } from '@/components/page/page-header';
import { FAQ_GROUPS, faqPageJsonLd } from '@/lib/faqs';
import { cachedPage, type PageCacheLife } from '@/lib/page-cache';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'FAQs',
    description:
      'Answers about sharing your story, about He Is Real Today, and bigger questions like “Is God real?” and “Can I believe and still have doubts?”',
    path: '/faqs',
  });
}

function FaqsContent() {
  return (
    <main id="main" className="flex-1 py-12 sm:py-20">
      <NarrowColumn>
        <PageHeader title="Frequently asked questions" />
        {FAQ_GROUPS.map((group) => (
          <section
            key={group.id}
            aria-labelledby={`faq-group-${group.id}`}
            className="mb-12"
          >
            <Heading
              level={2}
              size="eyebrow"
              id={`faq-group-${group.id}`}
              className="mb-5"
            >
              {group.heading}
            </Heading>
            <Accordion
              idPrefix="faq"
              items={group.items.map((i) => ({
                id: i.id,
                title: i.question,
                content: i.answer,
              }))}
            />
          </section>
        ))}
        <div className="pt-2 text-center">
          <Text tone="quiet" className="mb-4">
            Still have a question?
          </Text>
          <ButtonLink href="/contact">Get in touch</ButtonLink>
        </div>
      </NarrowColumn>
      <JsonLd data={faqPageJsonLd()} />
    </main>
  );
}

/** Per request, or this page's saved copy (page-cache.config.ts). */
export default function FaqsPage() {
  return cachedPage('/faqs', savedPage, () => <FaqsContent />);
}

async function savedPage(life: PageCacheLife) {
  'use cache';
  cacheLife(life);
  return <FaqsContent />;
}
