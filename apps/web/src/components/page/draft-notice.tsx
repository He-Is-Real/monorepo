/** Marks a placeholder legal page: the real text comes before Go live. */
export function DraftNotice({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="note"
      className="mb-8 rounded-xl border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-foreground"
    >
      <strong>Draft — dev only.</strong> {children}
    </p>
  );
}
