// Home's impact strip (home mockup, content spec home.md). Hidden until there are real figures
// (2026-10-24, pending Joel): the content spec's numbers were placeholders, and the site shows
// no made-up figures. To bring it back, add real figures to IMPACT_FIGURES. They must not be
// story counts or engagement metrics (D62, design principles).

export interface ImpactFigure {
  value: string;
  label: string;
}

/** Real figures only. Empty: the strip isn't shown. */
export const IMPACT_FIGURES: readonly ImpactFigure[] = [];

export function ImpactStrip({ figures }: { figures: readonly ImpactFigure[] }) {
  if (figures.length === 0) return null;
  return (
    <section
      aria-labelledby="impact"
      className="border-y border-border bg-raised"
    >
      <div className="mx-auto max-w-site px-4 py-14 sm:px-10">
        <h2 id="impact" className="sr-only">
          Impact
        </h2>
        <dl className="grid grid-cols-2 gap-8 lg:grid-cols-4">
          {figures.map(({ value, label }) => (
            <div key={label} className="flex flex-col text-center">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="order-first mb-2 text-[clamp(2.25rem,5vw,3.25rem)] leading-none font-bold text-link">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
