import { cacheLife } from 'next/cache';
import { ButtonLink } from '@/components/page/button-link';
import { Card, Heading, Text } from '@heisreal/web-ui';
import {
  NarrowColumn,
  PageHeader,
  WideColumn,
} from '@/components/page/page-header';
import { SiteVideo } from '@/components/page/site-video';
import { cachedPage, type PageCacheLife } from '@/lib/page-cache';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'Next steps',
    description:
      'You don’t need all the answers to keep exploring faith. Try Alpha, find a church near you, or ask us a question. No pressure, no agenda.',
    path: '/next-steps',
  });
}

const STEPS = [
  {
    icon: '🎓',
    title: 'Try the Alpha Course',
    text: 'A series of sessions exploring the Christian faith in a friendly, open environment. No pressure, no follow-up you don’t want.',
    href: 'https://alpha.org/',
    action: 'Find an Alpha course',
    domain: 'alpha.org',
  },
  {
    icon: '⛪',
    title: 'Find a church near you',
    text: 'There are spaces where it’s OK to ask questions and not have everything figured out. A local church can be one of those places.',
    href: 'https://www.achurchnearyou.com/',
    action: 'Find a church',
    domain: 'achurchnearyou.com',
  },
  {
    icon: '💬',
    title: 'Ask us a question',
    text: 'Got a question? Send us a message and a real person will get back to you. No judgement. No agenda.',
    href: '/contact',
    action: 'Send us a message',
  },
];

/** `keep`: rendered for the saved copy (a failed video lookup isn't kept, site-video.tsx). */
function NextStepsContent({ keep }: { keep: boolean }) {
  return (
    <main id="main" className="flex-1 py-12 sm:py-20">
      {/* The header and the founder's video in About's wider column; the steps keep the
          reading column. */}
      <WideColumn className="mb-10 sm:mb-14">
        <PageHeader
          eyebrow="Keep going"
          title="Next steps"
          lead="You don’t need to have all the answers to keep exploring. Here are some gentle ways to take the next step."
        />
        <SiteVideo
          keep={keep}
          videoKey="next-steps"
          title="Video: Next steps with He Is Real, from our founder Stephen Linnecar"
          label="Next steps with our founder"
        />
      </WideColumn>
      <NarrowColumn>
        <ul className="flex flex-col gap-5">
          {STEPS.map((step) => (
            <li key={step.title}>
              <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:gap-7 sm:p-8">
                <div
                  aria-hidden="true"
                  // eslint-disable-next-line @heisreal/web-ui/no-text-look -- sizes the step's emoji icon, not text
                  className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface text-2xl sm:size-20 sm:rounded-xl sm:text-4xl"
                >
                  {step.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <Heading level={2} size="sub" className="mb-2">
                    {step.title}
                  </Heading>
                  <Text tone="quiet" className="mb-4">
                    {step.text}
                  </Text>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <ButtonLink href={step.href}>{step.action}</ButtonLink>
                    {step.domain && (
                      <Text as="span" size="small" tone="quiet">
                        {step.domain}
                      </Text>
                    )}
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </NarrowColumn>
    </main>
  );
}

/** Per request, or this page's saved copy (page-cache.config.ts). */
export default function NextStepsPage() {
  return cachedPage('/next-steps', savedPage, () => (
    <NextStepsContent keep={false} />
  ));
}

async function savedPage(life: PageCacheLife) {
  'use cache';
  cacheLife(life);
  return <NextStepsContent keep />;
}
