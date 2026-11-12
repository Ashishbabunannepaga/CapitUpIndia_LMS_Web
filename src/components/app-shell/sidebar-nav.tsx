"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

import type { UserRole } from "@/lib/database.types";
import { navForRole } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * A thin bar that fills under the clicked link while its page loads, so a
 * click shows at once even when the server takes a moment. Absolute, so it
 * never shifts the layout; it waits 120 ms so quick pages don't flash it.
 */
function PendingBar() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-3 bottom-0.5 h-0.5 origin-left rounded-full bg-gold-400/80 motion-reduce:transition-none",
        pending
          ? "scale-x-100 opacity-100 transition-[transform,opacity] delay-[120ms] duration-[1200ms] ease-out"
          : "scale-x-0 opacity-0 transition-opacity duration-150",
      )}
    />
  );
}

export function SidebarNav({
  role,
  badges,
  onNavigate,
}: {
  role: UserRole;
  badges?: Record<string, number>;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const sections = navForRole(role);
  // The most specific match wins, so /leads/new lights up "Add lead", not "Leads".
  const current = sections
    .flatMap((section) => section.items.map((item) => item.href))
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav className="flex flex-col gap-6 px-3 py-4" aria-label="Main">
      {sections.map((section) => (
        <div key={section.title} className="space-y-0.5">
          <p className="px-3 pb-2 text-xs text-sidebar-foreground/50">
            {section.title}
          </p>
          {section.items.map((item) => {
            const active = item.href === current;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-sidebar-foreground/75 transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active &&
                    "bg-white/[0.08] text-sidebar-accent-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]",
                )}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 -left-3 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-gold-400"
                  />
                ) : null}
                <Icon
                  className={cn(
                    "size-4 transition-colors",
                    active ? "text-sidebar-primary" : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80",
                  )}
                />
                {item.title}
                <PendingBar />
                {badges?.[item.href] ? (
                  <span
                    className="ml-auto font-mono text-xs text-gold-300 tabular-nums"
                    title={`${badges[item.href]} new notes`}
                  >
                    {badges[item.href] > 99 ? "99+" : badges[item.href]}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
