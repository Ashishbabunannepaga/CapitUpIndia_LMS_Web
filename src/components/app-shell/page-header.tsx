export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string;
  description?: string;
  /** A short label above the title, such as the section name. */
  eyebrow?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        {eyebrow ? (
          <p className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-brand-700 uppercase">
            <span className="h-px w-5 bg-gradient-to-r from-gold-400 to-brand-400" aria-hidden="true" />
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight">{title}</h1>
        {description ? <p className="max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
