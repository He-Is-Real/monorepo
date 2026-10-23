import { ButtonLink } from '@/components/page/button-link';
import { Card } from '@/components/page/card';
import { NarrowColumn, PageHeader } from '@/components/page/page-header';
import { pageMetadata } from '@/lib/seo';

export const metadata = pageMetadata({
  title: 'Next steps',
  description:
    'You don’t need all the answers to keep exploring faith. Try Alpha, find a church near you, or ask us a question. No pressure, no agenda.',
  path: '/next-steps',
});

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

export default function NextStepsPage() {
  return (
    <main id="main" className="flex-1 py-12 sm:py-20">
      <NarrowColumn>
        <PageHeader
          eyebrow="Keep going"
          title="Next steps"
          lead="You don’t need to have all the answers to keep exploring. Here are some gentle ways to take the next step."
        />
        <ul className="flex flex-col gap-5">
          {STEPS.map((step) => (
            <li key={step.title}>
              <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:gap-7 sm:p-8">
                <div
                  aria-hidden="true"
                  className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface text-2xl sm:size-20 sm:rounded-xl sm:text-4xl"
                >
                  {step.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="mb-2 text-lg font-normal sm:text-[1.375rem]">
                    {step.title}
                  </h2>
                  <p className="mb-4 text-[15px] leading-relaxed text-secondary-text">
                    {step.text}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <ButtonLink href={step.href}>{step.action}</ButtonLink>
                    {step.domain && (
                      <span className="text-sm text-muted-foreground">
                        {step.domain}
                      </span>
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
