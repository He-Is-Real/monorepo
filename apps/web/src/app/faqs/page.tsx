import { FaqAccordion } from '@/components/faq/faq-accordion';
import { ButtonLink } from '@/components/page/button-link';
import { JsonLd } from '@/components/page/json-ld';
import { NarrowColumn, PageHeader } from '@/components/page/page-header';
import { FAQ_GROUPS, faqPageJsonLd } from '@/lib/faqs';
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

export default function FaqsPage() {
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
            <h2
              id={`faq-group-${group.id}`}
              className="mb-5 text-sm font-semibold tracking-[0.15em] text-link uppercase"
            >
              {group.heading}
            </h2>
            <FaqAccordion items={group.items} />
          </section>
        ))}
        <div className="pt-2 text-center">
          <p className="mb-4 text-muted-foreground">Still have a question?</p>
          <ButtonLink href="/contact">Get in touch</ButtonLink>
        </div>
      </NarrowColumn>
      <JsonLd data={faqPageJsonLd()} />
    </main>
  );
}
