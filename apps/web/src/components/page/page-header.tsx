import { Heading, Text } from '@heisreal/web-ui';

/**
 * A page's opening: optional eyebrow, the page's one h1 and a short lead, centred (the
 * mockups' `.section-header.centered`), on the library's text pieces: the eyebrow, the page
 * title (TX-2 A) and the intro (TX-4 A).
 */
export function PageHeader({
  eyebrow,
  title,
  lead,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
}) {
  return (
    <header className="mb-10 text-center sm:mb-14">
      {eyebrow && (
        <Heading as="p" size="eyebrow" className="mb-3">
          {eyebrow}
        </Heading>
      )}
      <Heading level={1}>{title}</Heading>
      {lead && (
        <Text size="intro" tone="quiet" className="mx-auto mt-3 max-w-[34rem]">
          {lead}
        </Text>
      )}
    </header>
  );
}

/**
 * The reading column most pages use: the measure (`max-w-measure`, Joel's R1), centred. Its
 * content (headings, text, cards, accordions, tables) shares the column's edges.
 */
export function NarrowColumn({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`px-4 sm:px-10 ${className}`}>
      <div data-reading-column="" className="mx-auto w-full max-w-measure">
        {children}
      </div>
    </div>
  );
}

/**
 * The wider column (the mockups' `.container-narrow`, 800 px) for pages Joel kept wide: About,
 * for its video and title (R1, 2026-10-24). Its text keeps its own max-w-prose.
 */
export function WideColumn({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-narrow px-4 sm:px-10 ${className}`}>
      {children}
    </div>
  );
}
