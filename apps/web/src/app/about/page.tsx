import { cacheLife } from 'next/cache';
import { Heading, Quote, Text } from '@heisreal/web-ui';
import { ButtonLink } from '@/components/page/button-link';
import { RaisedBand } from '@/components/page/card';
import { WideColumn, PageHeader } from '@/components/page/page-header';
import { SiteVideo } from '@/components/page/site-video';
import { cachedPage, type PageCacheLife } from '@/lib/page-cache';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'About us',
    description:
      'Why He Is Real Today exists: to carry real testimonies beyond church walls to anyone asking “Does God exist?” No pressure. No preaching.',
    path: '/about',
  });
}

const VALUES = [
  {
    icon: '🌍',
    title: 'Open to everyone',
    text: 'Not affiliated with any particular Christian denomination. Everyone’s story is welcome.',
  },
  {
    icon: '🤝',
    title: 'No pressure',
    text: 'Not a preaching platform. A human space: honest stories designed to make you feel safe, not targeted.',
  },
  {
    icon: '💛',
    title: 'Not for profit',
    text: 'A UK-based not-for-profit organisation. Charity registration pending in England and Wales.',
  },
];

/** `keep`: rendered for the saved copy (a failed video lookup isn't kept, site-video.tsx). */
function AboutContent({ keep }: { keep: boolean }) {
  return (
    <main id="main" className="flex-1">
      <section className="py-12 sm:py-20">
        <WideColumn>
          <PageHeader
            eyebrow="About"
            title="The heart behind He Is Real"
            lead="Hear from our founder, Stephen Linnecar"
          />
          <SiteVideo
            keep={keep}
            videoKey="founder-intro"
            title="Video: The heart behind He Is Real, from our founder Stephen Linnecar"
            label="Founder’s introduction"
          />
        </WideColumn>
      </section>

      <RaisedBand aria-labelledby="mission">
        <WideColumn>
          <h2 id="mission" className="sr-only">
            Why we exist
          </h2>
          <Text
            as="div"
            size="story"
            tone="quiet"
            className="max-w-[38rem] space-y-7"
          >
            <p>
              Churches are full of extraordinary testimonies. Week after week,
              people share what God has done in their lives, and those stories
              stay there.
            </p>
            <p>
              They never reach the person quietly searching{' '}
              <Text as="em" size="inherit" tone="normal">
                “does God exist?”
              </Text>{' '}
              at midnight, or the colleague who is curious but would never walk
              through a church door.
            </p>
            <Quote className="my-10">
              Testimonies are one of the most powerful evangelistic tools
              available to the Church, yet for too long they have been locked
              inside four walls.
            </Quote>
            <p>
              He Is Real Today exists to change that. A simple, accessible way
              for those stories to escape the church building and reach the
              world: online, on demand, and on the terms of the person
              searching.
            </p>
            <Text size="inherit" tone="normal">
              No pressure. No preaching. Just honest, human accounts of a God
              who shows up in real life.
            </Text>
          </Text>
        </WideColumn>
      </RaisedBand>

      <section aria-labelledby="values" className="py-14 sm:py-20">
        <div className="mx-auto max-w-site px-4 sm:px-10">
          <h2 id="values" className="sr-only">
            What we value
          </h2>
          <ul className="grid gap-10 sm:grid-cols-3">
            {VALUES.map((v) => (
              <li key={v.title} className="text-center">
                <div
                  aria-hidden="true"
                  // eslint-disable-next-line @heisreal/web-ui/no-text-look -- sizes the value's emoji icon, not text
                  className="mb-4 text-5xl"
                >
                  {v.icon}
                </div>
                <Heading level={3} className="mb-3">
                  {v.title}
                </Heading>
                <Text tone="quiet" className="mx-auto max-w-xs">
                  {v.text}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <RaisedBand aria-labelledby="share" className="text-center">
        <WideColumn>
          <Heading level={2} id="share" className="mb-4">
            Have a story to share?
          </Heading>
          <Text size="intro" tone="quiet" className="mb-7">
            Your testimony could be exactly what someone needs to hear today.
          </Text>
          <div className="flex flex-col justify-center gap-4 sm:flex-row">
            <ButtonLink href="/get-ready" size="lg">
              Get ready to share
            </ButtonLink>
            <ButtonLink href="/contact" variant="outline" size="lg">
              Get in touch
            </ButtonLink>
          </div>
        </WideColumn>
      </RaisedBand>
    </main>
  );
}

/** Per request, or this page's saved copy (page-cache.config.ts). */
export default function AboutPage() {
  return cachedPage('/about', savedPage, () => <AboutContent keep={false} />);
}

async function savedPage(life: PageCacheLife) {
  'use cache';
  cacheLife(life);
  return <AboutContent keep />;
}
