import { Construction } from "lucide-react";

import { findNavItem } from "@/lib/navigation";
import { PageHeader } from "./page-header";

/** Stand-in for screens that are routed and access-controlled but not built yet. */
export function ScreenPlaceholder({ href }: { href: string }) {
  const item = findNavItem(href);
  const Icon = item?.icon ?? Construction;

  return (
    <>
      <PageHeader title={item?.title ?? "Coming soon"} description={item?.description} />
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card p-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <Icon className="size-6" />
        </div>
        <p className="font-medium">This screen is being built.</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Navigation, sign-in and access rules are in place, so it will appear here for the right people as soon as
          it ships.
        </p>
      </div>
    </>
  );
}
