import { ButtonLink } from '@/components/page/button-link';
import { Card, RaisedBand } from '@/components/page/card';
import { NarrowColumn } from '@/components/page/page-header';
import {
  BrokenHeart,
  Cross,
  Dove,
  Globe,
  Sunrise,
} from '@/components/greatest-story/illustrations';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). */
export function generateMetadata() {
  return pageMetadata({
    title: 'The Greatest Story Ever Told',
    description:
      'The story every testimony points back to: God made you to know Him, and Jesus came to find us. Is God real? Read the story of love, sacrifice and hope.',
    path: '/greatest-story',
  });
}

interface Part {
  heading: React.ReactNode;
  paragraphs: string[];
  verse: string;
  reference: string;
  Illustration?: (props: { className?: string }) => React.JSX.Element;
}

const PARTS: Part[] = [
  {
    heading: 'God created you to know Him',
    paragraphs: [
      'The story begins not with us, but with God. He created the universe and everything in it, including you. Not as an accident, not as a cosmic afterthought, but with purpose and love.',
      'You were made to be in relationship with Him. To know Him, to walk with Him, to experience life the way it was always meant to be lived: full, connected and whole.',
    ],
    verse:
      'For you created my inmost being; you knit me together in my mother’s womb. I praise you because I am fearfully and wonderfully made.',
    reference: 'Psalm 139:13–14',
    Illustration: Globe,
  },
  {
    heading: 'Something went wrong',
    paragraphs: [
      'We chose our own way. Every one of us. We turned away from God through selfishness, pride, indifference, or simply by ignoring Him. The Bible calls this sin.',
      'Sin isn’t just about breaking rules. It’s the gap between us and the God who made us. It’s the reason the world feels broken. The reason we feel restless, disconnected, searching for something we can’t quite name.',
    ],
    verse: 'For all have sinned and fall short of the glory of God.',
    reference: 'Romans 3:23',
    Illustration: BrokenHeart,
  },
  {
    heading: (
      <>
        <em>God</em> came to find us
      </>
    ),
    paragraphs: [
      'This is the heart of the story. God didn’t leave us in the mess. He entered it.',
      'He sent His Son, Jesus, into the world: not as a distant king, but as a real human being. Jesus lived among ordinary people. He healed the sick, welcomed the outcast, wept with the grieving, and loved the unloved.',
      'He came to bridge the gap that we could never bridge ourselves.',
    ],
    verse:
      'For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life.',
    reference: 'John 3:16',
    Illustration: Dove,
  },
  {
    heading: 'He gave everything',
    paragraphs: [
      'Jesus was crucified: not for anything He did, but for everything we’ve done. On the cross, He took the weight of all the sin, shame and brokenness of the world onto Himself.',
      'He died so we wouldn’t have to carry it. He paid a debt we could never pay.',
      'But the story didn’t end there.',
    ],
    verse:
      'But God demonstrates his own love for us in this: while we were still sinners, Christ died for us.',
    reference: 'Romans 5:8',
    Illustration: Cross,
  },
  {
    heading: 'Death couldn’t hold Him',
    paragraphs: [
      'Three days after He was buried, Jesus rose from the dead. Not metaphorically. Not spiritually. He walked out of the tomb, alive.',
      'The resurrection is what makes this story unlike any other. It means death is not the end. It means sin and shame do not get the final word. It means there is hope, real, concrete, unshakeable hope, for every person who has ever lived.',
    ],
    verse: 'He is not here; he has risen, just as he said.',
    reference: 'Matthew 28:6',
    Illustration: Sunrise,
  },
  {
    heading: 'The invitation is for you',
    paragraphs: [
      'This isn’t a story about religion. It’s a story about relationship. God is offering you something right now: forgiveness, freedom, a fresh start, and a life lived in connection with the One who made you.',
      'You don’t need to have it all figured out. You don’t need to be perfect. You just need to be willing to say yes.',
      'Believing in Jesus means trusting that He is who He says He is, the Son of God who died and rose again for you, and choosing to follow Him.',
    ],
    verse:
      'If you declare with your mouth, ‘Jesus is Lord,’ and believe in your heart that God raised him from the dead, you will be saved.',
    reference: 'Romans 10:9',
  },
];

const PRAYER = [
  'God, I don’t have all the answers, but I believe you are real.',
  'I believe Jesus died for me and rose again.',
  'I’m sorry for the ways I’ve turned away from you.',
  'I want to know you. I want to follow you.',
  'Please come into my life and help me start again.',
];

function PartText({ part, number }: { part: Part; number: number }) {
  return (
    <div>
      <p
        aria-hidden="true"
        className="mb-2 text-5xl leading-none font-bold text-teal/25 sm:text-7xl"
      >
        {String(number).padStart(2, '0')}
      </p>
      <h2 className="mb-5 text-[1.75rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
        {part.heading}
      </h2>
      <div className="space-y-5 text-base leading-[1.9] text-secondary-text sm:text-lg">
        {part.paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      <figure className="mt-6 border-l-2 border-teal pl-5">
        <blockquote className="text-[0.9375rem] text-muted-foreground italic sm:text-[1.0625rem]">
          <p>“{part.verse}”</p>
        </blockquote>
        <figcaption className="mt-2 text-[0.8125rem] text-muted-foreground">
          <cite className="not-italic">{part.reference}</cite>
        </figcaption>
      </figure>
    </div>
  );
}

export default function GreatestStoryPage() {
  return (
    <main id="main" className="flex-1">
      <NarrowColumn className="py-14 sm:py-24">
        <p className="mb-3 text-sm font-semibold tracking-[0.2em] text-link uppercase">
          The Gospel
        </p>
        <h1 className="mb-6 text-[2.5rem] leading-[1.1] font-normal sm:text-[3.75rem]">
          The Greatest Story <br />
          <em>Ever Told</em>
        </h1>
        <p className="text-lg leading-relaxed text-secondary-text sm:text-xl">
          Every testimony on this site points back to one story. A story of
          love, sacrifice, and hope that changed the world, and that can change
          yours.
        </p>
      </NarrowColumn>

      {/* role="list": Safari drops list semantics when the markers are hidden. */}
      <ol role="list" aria-label="The story in six parts">
        {PARTS.map((part, i) => {
          const { Illustration } = part;
          const shaded = i % 2 === 0;
          return (
            <li
              key={part.reference}
              className={`py-12 sm:py-16 ${shaded ? 'border-y border-border bg-raised' : ''}`}
            >
              {Illustration ? (
                <div className="mx-auto grid max-w-[calc(var(--container-measure)+2rem)] items-center gap-8 px-4 sm:max-w-[calc(var(--container-measure)+5rem)] sm:px-10 md:max-w-site md:grid-cols-2 md:gap-16">
                  <PartText part={part} number={i + 1} />
                  <div
                    className={`flex aspect-video items-center justify-center rounded-3xl border border-border bg-card p-6 text-teal md:aspect-square ${
                      i % 2 === 1 ? 'md:order-first' : ''
                    }`}
                  >
                    <Illustration className="size-full max-h-[200px] max-w-[200px]" />
                  </div>
                </div>
              ) : (
                <NarrowColumn>
                  <PartText part={part} number={i + 1} />
                </NarrowColumn>
              )}
            </li>
          );
        })}
      </ol>

      <section aria-labelledby="prayer" className="py-14 sm:py-24">
        <NarrowColumn>
          <h2
            id="prayer"
            className="mb-4 text-[1.75rem] font-normal sm:text-[2.25rem]"
          >
            A simple prayer
          </h2>
          <p className="mb-8 text-[1.0625rem] text-secondary-text">
            If you’d like to take this step, there are no magic words. But if it
            helps, you could pray something like this:
          </p>
          <Card className="p-6 sm:p-10">
            <div className="space-y-4 text-lg leading-relaxed italic sm:text-xl">
              {PRAYER.map((line) => (
                <p key={line}>{line}</p>
              ))}
              <p className="font-semibold not-italic">Amen.</p>
            </div>
          </Card>
        </NarrowColumn>
      </section>

      <RaisedBand aria-labelledby="what-now" className="text-center">
        <NarrowColumn>
          <h2
            id="what-now"
            className="mb-4 text-[1.75rem] font-normal sm:text-[2.25rem]"
          >
            What now?
          </h2>
          <p className="text-[1.0625rem] text-secondary-text">
            If you prayed that prayer, or even if you’re still thinking about
            it, you’re not alone.
          </p>
          <p className="mb-8 text-[1.0625rem] text-secondary-text">
            Here are some ways to keep going.
          </p>
          <div className="flex flex-col justify-center gap-3 sm:flex-row sm:flex-wrap">
            <ButtonLink href="/next-steps" size="lg">
              Explore next steps
            </ButtonLink>
            <ButtonLink href="/stories" variant="secondary" size="lg">
              Read more stories
            </ButtonLink>
            <ButtonLink href="/contact" variant="secondary" size="lg">
              Talk to someone
            </ButtonLink>
          </div>
          <p className="mt-12 text-xs leading-relaxed text-muted-foreground">
            Scripture quotations taken from The Holy Bible, New International
            Version (Anglicised edition). Copyright © 1979, 1984, 2011 by
            Biblica. Used by permission of Hodder &amp; Stoughton Publishers, an
            Hachette UK company. All rights reserved. ‘NIV’ is a registered
            trademark of Biblica.
          </p>
        </NarrowColumn>
      </RaisedBand>
    </main>
  );
}
