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
        <div key={section.title} className="space-y-1">
          <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-sidebar-foreground/50 uppercase">
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
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                <Icon className={cn("size-4", active ? "text-sidebar-primary" : "text-sidebar-foreground/60")} />
                {item.title}
                {badges?.[item.href] ? (
                  <span
                    className="ml-auto rounded-full bg-sidebar-primary px-1.5 py-0.5 text-[10px] leading-none font-semibold text-sidebar-primary-foreground"
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
