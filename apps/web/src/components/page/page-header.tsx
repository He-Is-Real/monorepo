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

/** The narrow column most pages use (the mockups' `.container-narrow`, 800 px). */
export function NarrowColumn({
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
