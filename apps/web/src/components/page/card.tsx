/** A surface for a block of content (the mockups' `.card`); not clickable, so no hover lift. */
export function Card({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-border bg-card ${className}`}>
      {children}
    </div>
  );
}

/** A full-width band on the raised surface (the mockups' `.section-raised`). */
export function RaisedBand({
  children,
  className = '',
  ...rest
}: React.ComponentProps<'section'>) {
  return (
    <section
      className={`border-y border-border bg-raised py-14 sm:py-20 ${className}`}
      {...rest}
    >
      {children}
    </section>
  );
}
