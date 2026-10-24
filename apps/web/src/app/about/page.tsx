import { ButtonLink } from '@/components/page/button-link';
import { RaisedBand } from '@/components/page/card';
import { NarrowColumn, PageHeader } from '@/components/page/page-header';
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

export default function AboutPage() {
  return (
    <main id="main" className="flex-1">
      <section className="py-12 sm:py-20">
        <NarrowColumn>
          <PageHeader
            eyebrow="About"
            title="The heart behind He Is Real"
            lead="Hear from our founder, Stephen Linnecar"
          />
          {/* The founder's video isn't recorded yet. When it is, it plays through
              api-public-read's signed Bunny links (D52), not a third-party embed. */}
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-2xl bg-black px-4 text-center text-white/70">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-12 opacity-50 sm:size-16"
            >
              <polygon points="8,5 19,12 8,19" fill="currentColor" />
            </svg>
            <p className="text-sm">Founder’s introduction</p>
            <p className="text-xs text-white/60">Video coming soon</p>
          </div>
        </NarrowColumn>
      </section>

      <RaisedBand aria-labelledby="mission">
        <NarrowColumn>
          <h2 id="mission" className="sr-only">
            Why we exist
          </h2>
          <div className="max-w-prose space-y-7 text-lg leading-loose text-secondary-text sm:text-xl">
            <p>
              Churches are full of extraordinary testimonies. Week after week,
              people share what God has done in their lives, and those stories
              stay there.
            </p>
            <p>
              They never reach the person quietly searching{' '}
              <em className="text-foreground">“does God exist?”</em> at
              midnight, or the colleague who is curious but would never walk
              through a church door.
            </p>
            <blockquote className="my-10 border-l-[3px] border-teal pl-6 text-xl leading-relaxed text-foreground sm:text-[1.75rem]">
              Testimonies are one of the most powerful evangelistic tools
              available to the Church, yet for too long they have been locked
              inside four walls.
            </blockquote>
            <p>
              He Is Real Today exists to change that. A simple, accessible way
              for those stories to escape the church building and reach the
              world: online, on demand, and on the terms of the person
              searching.
            </p>
            <p className="text-foreground">
              No pressure. No preaching. Just honest, human accounts of a God
              who shows up in real life.
            </p>
          </div>
        </NarrowColumn>
      </RaisedBand>

      <section aria-labelledby="values" className="py-14 sm:py-20">
        <div className="mx-auto max-w-site px-4 sm:px-10">
          <h2 id="values" className="sr-only">
            What we value
          </h2>
          <ul className="grid gap-10 sm:grid-cols-3">
            {VALUES.map((v) => (
              <li key={v.title} className="text-center">
                <div aria-hidden="true" className="mb-4 text-5xl">
                  {v.icon}
                </div>
                <h3 className="mb-3 text-2xl font-normal">{v.title}</h3>
                <p className="mx-auto max-w-xs text-[15px] leading-relaxed text-muted-foreground">
                  {v.text}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <RaisedBand aria-labelledby="share" className="text-center">
        <NarrowColumn>
          <h2
            id="share"
            className="mb-4 text-[1.75rem] font-normal sm:text-[2.375rem]"
          >
            Have a story to share?
          </h2>
          <p className="mb-7 text-[17px] text-secondary-text">
            Your testimony could be exactly what someone needs to hear today.
          </p>
          <div className="flex flex-col justify-center gap-4 sm:flex-row">
            <ButtonLink href="/get-ready" size="lg">
              Get ready to share
            </ButtonLink>
            <ButtonLink href="/contact" variant="secondary" size="lg">
              Get in touch
            </ButtonLink>
          </div>
        </NarrowColumn>
      </RaisedBand>
    </main>
  );
}
