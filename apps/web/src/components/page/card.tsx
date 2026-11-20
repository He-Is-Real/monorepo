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
