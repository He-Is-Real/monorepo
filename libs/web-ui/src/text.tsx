import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from './cn';

/*
 * Text (web library round 3, TX-1 to TX-6 A, Joel, 21 November 2026): every heading, paragraph
 * and link look the site has, so pages hold no text colours, sizes or weights (lint refuses them,
 * TX-7 A). Pages pass layout only (margins, width, alignment, wrapping, line clamps).
 */

const headingVariants = cva('', {
  variants: {
    size: {
      /** The two hero pages' opening line (Home, Greatest Story): 40 px on a phone growing to 64 px. */
      display:
        'text-[clamp(2.5rem,7vw,4rem)] leading-[1.12] font-normal tracking-tight text-balance',
      /** Every other page's title: 32 px on a phone, 44 px wider, normal weight (TX-2 A). */
      title:
        'text-[2rem] leading-tight font-normal text-balance sm:text-[2.75rem]',
      /** A section of a page: 24 px on a phone, 28 px wider, normal weight, everywhere (TX-3 A). */
      section: 'text-2xl font-normal text-balance sm:text-[1.75rem]',
      /** A heading inside a panel, dialog or list: 18 px semibold. */
      sub: 'text-lg font-semibold',
      /** The grey capitals over filters and list groups. */
      small:
        'text-xs font-semibold tracking-wide text-secondary-text uppercase',
      /** The teal capitals above a page title or naming a section ("In their words"). */
      eyebrow: 'text-sm font-semibold tracking-[0.2em] text-link uppercase',
    },
  },
  defaultVariants: { size: 'section' },
});

type HeadingSize = NonNullable<VariantProps<typeof headingVariants>['size']>;
const DEFAULT_SIZE: Record<1 | 2 | 3 | 4 | 5 | 6, HeadingSize> = {
  1: 'title',
  2: 'section',
  3: 'sub',
  4: 'sub',
  5: 'small',
  6: 'small',
};

/**
 * A heading. `level` (1 to 6) picks the tag for screen readers; `size` picks the look, with a
 * sensible default per level (1 title, 2 section, 3 and 4 sub). `as` draws a heading look on
 * another element (an eyebrow that's a `p`, a fieldset's `legend`).
 */
function Heading({
  level = 2,
  size,
  as,
  className,
  ...props
}: React.ComponentProps<'h2'> & {
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  size?: HeadingSize;
  as?: React.ElementType;
}) {
  const Comp = as ?? (`h${level}` as const);
  return (
    <Comp
      data-slot="heading"
      className={cn(
        headingVariants({ size: size ?? DEFAULT_SIZE[level] }),
        className,
      )}
      {...props}
    />
  );
}

const textVariants = cva('', {
  variants: {
    size: {
      /** The paragraph under a title, 18 px (TX-4 A). */
      intro: 'text-lg',
      /** Reading text (a story, Greatest Story): 18 px with roomy lines. */
      story: 'text-lg leading-8',
      /** Normal text, 16 px (card paragraphs too, TX-5 A). */
      body: 'text-base/[1.6]',
      /** Small text, 14 px: hints, captions, dates, tables (TX-5 A). */
      small: 'text-sm',
      /** The size around it (a line inside a sized block). */
      inherit: '',
    },
    tone: {
      /** The colour around it. */
      inherit: '',
      normal: 'text-foreground',
      /** Quieter text: one grey for hints, captions, dates and card text (TX-1 A). */
      quiet: 'text-secondary-text',
      danger: 'text-danger-text',
      success: 'text-success-text',
      /** Needs attention soon (late, an answer still missing): the warning amber. */
      warning: 'text-warning',
      /** On a picture, video or the dark hero: white. */
      media: 'text-on-media',
      /** Quieter words on a picture, video or the dark hero. */
      'media-quiet': 'text-on-media/80',
    },
    weight: {
      normal: '',
      /** Regular words inside a bold line ("(optional)" after a label). */
      regular: 'font-normal',
      /** Words that stand out without being emphasis (a name, a count, a label). */
      bold: 'font-semibold',
    },
  },
  defaultVariants: { size: 'body', tone: 'inherit', weight: 'normal' },
});

/**
 * Text: `size` (`intro`, `story`, `body`, `small`, `inherit`), `tone` (`normal`, `quiet`,
 * `danger`, `success`, `warning`, `media`, `media-quiet`, or the colour around it) and `weight`
 * (`bold`, or `regular` inside a bold line).
 * A `p` unless `as` says otherwise; `asChild` puts the look on its child. Bold words inside a
 * sentence stay plain `<strong>`.
 */
function Text({
  size,
  tone,
  weight,
  as,
  asChild = false,
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> &
  VariantProps<typeof textVariants> & {
    as?: React.ElementType;
    asChild?: boolean;
    /** For `as="time"`, `as="label"`… */
    dateTime?: string;
    htmlFor?: string;
  }) {
  const Comp = asChild ? Slot.Root : (as ?? 'p');
  return (
    <Comp
      data-slot="text"
      className={cn(textVariants({ size, tone, weight }), className)}
      {...props}
    />
  );
}

/**
 * A pull quote (round 3: as on a written story's page): a brand bar on the left, 22 px italic
 * in the normal text colour. `source` adds who said it under it, as a small quiet caption.
 */
function Quote({
  source,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { source?: React.ReactNode }) {
  const quote = (
    <blockquote className="text-[1.375rem] leading-relaxed text-foreground italic">
      {children}
    </blockquote>
  );
  return (
    <figure
      data-slot="quote"
      className={cn('border-l-[3px] border-brand pl-6', className)}
      {...props}
    >
      {quote}
      {source !== undefined && (
        <figcaption className="mt-2 text-sm text-secondary-text">
          <cite className="not-italic">{source}</cite>
        </figcaption>
      )}
    </figure>
  );
}

const textLinkVariants = cva(
  'text-link underline-offset-4 transition-colors hover:text-link-hover',
  {
    variants: {
      kind: {
        /** A link inside a sentence: always underlined, so it never relies on colour (TX-6 A). */
        inline: 'underline decoration-1',
        /** A link on its own or beside a value ("Back to the list", "Change"): semibold, underlined on hover, 44 px to press. */
        standalone:
          'inline-flex min-h-11 min-w-11 items-center font-semibold hover:underline',
      },
      /**
       * An underlined link that is its own short line's tap target ("Sign in to see…", "Back
       * to your profile" after a sentence): still underlined, and at least 44 px to press.
       * Not for links inside running text, where it would stretch the line.
       */
      touch: { true: 'inline-flex min-h-11 items-center', false: '' },
    },
    defaultVariants: { kind: 'inline', touch: false },
  },
);

/**
 * A link that looks like a link (TX-6 A): `kind` `inline` (in a sentence, underlined) or
 * `standalone` (on its own, semibold, underlined on hover, at least 44 px). `touch` makes an
 * inline link 44 px tall too, for one that is a short line's only tap target. An `<a>`, or with
 * `asChild` the look on its child (a router's link; `apps/web`'s `TextLink` does this).
 */
function TextLink({
  kind,
  touch,
  asChild = false,
  className,
  ...props
}: React.ComponentProps<'a'> &
  VariantProps<typeof textLinkVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'a';
  return (
    <Comp
      data-slot="text-link"
      className={cn(textLinkVariants({ kind, touch }), className)}
      {...props}
    />
  );
}

export {
  Heading,
  headingVariants,
  Quote,
  Text,
  TextLink,
  textLinkVariants,
  textVariants,
};
