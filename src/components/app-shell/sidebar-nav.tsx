"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { UserRole } from "@/lib/database.types";
import { navForRole } from "@/lib/navigation";
import { cn } from "@/lib/utils";

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

  return (
    <nav className="flex flex-col gap-6 px-3 py-4" aria-label="Main">
      {navForRole(role).map((section) => (
        <div key={section.title} className="space-y-0.5">
          <p className="px-3 pb-2 text-xs text-sidebar-foreground/50">
            {section.title}
          </p>
          {section.items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
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
