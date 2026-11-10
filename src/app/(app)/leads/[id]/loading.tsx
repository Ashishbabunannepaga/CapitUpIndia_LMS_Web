export default function LeadLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <p className="sr-only">Loading lead details…</p>

      <div className="h-5 w-20 animate-pulse rounded bg-muted" />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <div className="h-8 w-72 max-w-full animate-pulse rounded bg-muted" />
          <div className="flex gap-2">
            <div className="h-7 w-24 animate-pulse rounded bg-muted" />
            <div className="h-6 w-20 animate-pulse rounded-full bg-muted" />
            <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-20 animate-pulse rounded-lg bg-muted" />
          <div className="h-9 w-20 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <section className="rounded-2xl border bg-card p-5 xl:col-span-2">
          <div className="mb-5 h-5 w-24 animate-pulse rounded bg-muted" />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }, (_, index) => (
              <div key={index} className="space-y-2">
                <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                <div className="h-4 w-32 max-w-full animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-2xl border bg-card p-5">
          <div className="mb-5 h-5 w-32 animate-pulse rounded bg-muted" />
          <div className="space-y-3">
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
            <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <section key={index} className="rounded-2xl border bg-card p-5">
            <div className="mb-5 h-5 w-36 animate-pulse rounded bg-muted" />
            <div className="space-y-3">
              <div className="h-4 w-full animate-pulse rounded bg-muted" />
              <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
