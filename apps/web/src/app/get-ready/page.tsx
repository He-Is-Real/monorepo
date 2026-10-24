import { ButtonLink } from '@/components/page/button-link';
import { Card } from '@/components/page/card';
import { NarrowColumn, PageHeader } from '@/components/page/page-header';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'Get ready to share',
    description:
      'Recording or writing your story can feel daunting. Practical tips to help you share your testimony with confidence: be yourself, find a quiet space, keep it focused.',
    path: '/get-ready',
  });
}

const RESOURCES = [
  {
    title: 'Preparation guidelines',
    text: 'Practical tips on recording or writing a testimony with clarity and authenticity.',
  },
  {
    title: 'Starter topics',
    text: 'Not sure where to begin? Ideas to spark your thinking about what to share.',
  },
  {
    title: 'Questions to guide you',
    text: 'Meaningful prompts to help you find and frame your story.',
  },
];

const TIPS = [
  {
    title: 'Be yourself',
    text: 'Speak naturally, from the heart. Imperfect and real is better than polished and rehearsed.',
  },
  {
    title: 'Find a quiet space',
    text: 'A well-lit, quiet room makes a big difference. Natural light is best.',
  },
  {
    title: 'It’s OK to be emotional',
    text: 'If you get tearful or need to pause, that’s completely fine. These are real stories and real emotions.',
  },
  {
    title: 'Keep it focused',
    text: 'Focus on one moment, one encounter, one turning point. You don’t need your whole life story.',
  },
];

const comingSoon =
  'inline-flex rounded-full bg-surface px-3 py-1 text-xs font-medium text-secondary-text';

export default function GetReadyPage() {
  return (
    <main id="main" className="flex-1 py-12 sm:py-20">
      <NarrowColumn>
        <PageHeader
          eyebrow="Prepare"
          title="Get ready to share"
          lead="Recording or writing your story can feel daunting. These resources will help you prepare with confidence."
        />

        <section aria-labelledby="resources" className="mb-14">
          <h2 id="resources" className="sr-only">
            Resources
          </h2>
          <ul className="flex flex-col gap-5">
            {RESOURCES.map((r) => (
              <li key={r.title}>
                <Card className="p-6 sm:px-8 sm:py-7">
                  <h3 className="mb-2 text-xl font-normal sm:text-[1.375rem]">
                    {r.title}
                  </h3>
                  <p className="mb-4 max-w-measure text-[15px] text-secondary-text">
                    {r.text}
                  </p>
                  <p className={comingSoon}>PDF and audio coming soon</p>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        <Card className="mb-14 flex flex-col items-start gap-5 p-6 sm:flex-row sm:items-center sm:gap-7 sm:p-8">
          <div
            aria-hidden="true"
            className="flex aspect-video w-full shrink-0 items-center justify-center rounded-xl bg-black text-white/50 sm:w-48"
          >
            <svg viewBox="0 0 24 24" className="size-9">
              <polygon points="8,5 19,12 8,19" fill="currentColor" />
            </svg>
          </div>
          <div>
            <p className={`${comingSoon} mb-3`}>Coming soon</p>
            <h2 className="mb-2 text-xl font-normal sm:text-[1.375rem]">
              Watch: how to share your story
            </h2>
            <p className="text-[15px] text-secondary-text">
              A short video walking you through the whole process.
            </p>
          </div>
        </Card>

        <section aria-labelledby="tips" className="mb-14">
          <h2 id="tips" className="mb-5 text-2xl font-normal sm:text-[1.75rem]">
            Quick tips
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {TIPS.map((t) => (
              <li key={t.title}>
                <Card className="h-full p-6">
                  <h3 className="mb-2 font-semibold">{t.title}</h3>
                  <p className="text-[15px] leading-relaxed text-secondary-text">
                    {t.text}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        {/* No /submit in M1 (sharing is M2). */}
        <section aria-labelledby="ready" className="text-center">
          <h2
            id="ready"
            className="mb-3 text-2xl font-normal sm:text-[1.75rem]"
          >
            Ready?
          </h2>
          <p className="mx-auto mb-6 max-w-measure text-secondary-text">
            Story sharing opens soon. Until then, these tips are a good place to
            start, and the FAQs explain how it will work.
          </p>
          <ButtonLink href="/faqs" variant="secondary">
            Read the FAQs
          </ButtonLink>
        </section>
      </NarrowColumn>
    </main>
  );
}
