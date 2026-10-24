/**
 * A page's opening: optional eyebrow, the page's one h1 and a short lead, centred (the
 * mockups' `.section-header.centered`). The eyebrow uses the link colour: brand teal is
 * decoration only on light (decision 19).
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
        <p className="mb-3 text-sm font-semibold tracking-[0.2em] text-link uppercase">
          {eyebrow}
        </p>
      )}
      <h1 className="text-[2rem] leading-tight font-normal text-balance sm:text-[2.75rem]">
        {title}
      </h1>
      {lead && (
        <p className="mx-auto mt-3 max-w-[34rem] text-[1.0625rem] text-secondary-text">
          {lead}
        </p>
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
