import { cacheLife } from 'next/cache';
import { ButtonLink } from '@/components/page/button-link';
import { Card, Heading, Tag, Text } from '@heisreal/web-ui';
import { NarrowColumn, PageHeader } from '@/components/page/page-header';
import { cachedPage, type PageCacheLife } from '@/lib/page-cache';
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

function GetReadyContent() {
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
                  <Heading level={3} className="mb-2">
                    {r.title}
                  </Heading>
                  <Text tone="quiet" className="mb-4">
                    {r.text}
                  </Text>
                  <p>
                    <Tag className="py-1">PDF and audio coming soon</Tag>
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        <Card className="mb-14 flex flex-col items-start gap-5 p-6 sm:flex-row sm:items-center sm:gap-7 sm:p-8">
          <div
            aria-hidden="true"
            // eslint-disable-next-line @heisreal/web-ui/no-text-look -- colours the play mark (currentColor) on the black placeholder, not text
            className="flex aspect-video w-full shrink-0 items-center justify-center rounded-xl bg-media text-on-media/50 sm:w-48"
          >
            <svg viewBox="0 0 24 24" className="size-9">
              <polygon points="8,5 19,12 8,19" fill="currentColor" />
            </svg>
          </div>
          <div>
            <p className="mb-3">
              <Tag className="py-1">Coming soon</Tag>
            </p>
            <Heading level={2} size="sub" className="mb-2">
              Watch: how to share your story
            </Heading>
            <Text tone="quiet">
              A short video walking you through the whole process.
            </Text>
          </div>
        </Card>

        <section aria-labelledby="tips" className="mb-14">
          <Heading level={2} id="tips" className="mb-5">
            Quick tips
          </Heading>
          <ul className="grid gap-4 sm:grid-cols-2">
            {TIPS.map((t) => (
              <li key={t.title}>
                <Card className="h-full p-6">
                  <Heading level={3} className="mb-2">
                    {t.title}
                  </Heading>
                  <Text tone="quiet">{t.text}</Text>
                </Card>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="ready" className="text-center">
          <Heading level={2} id="ready" className="mb-3">
            Ready?
          </Heading>
          <Text tone="quiet" className="mb-6">
            Take your time. Your story is saved as you write, so you can come
            back to it.
          </Text>
          <ButtonLink href="/share">Share your story</ButtonLink>
        </section>
      </NarrowColumn>
    </main>
  );
}

/** Per request, or this page's saved copy (page-cache.config.ts). */
export default function GetReadyPage() {
  return cachedPage('/get-ready', savedPage, () => <GetReadyContent />);
}

async function savedPage(life: PageCacheLife) {
  'use cache';
  cacheLife(life);
  return <GetReadyContent />;
}
