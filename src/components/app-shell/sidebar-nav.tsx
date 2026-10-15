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
          <p className="px-3 pb-1 text-[10px] font-semibold tracking-[0.16em] text-sidebar-foreground/40 uppercase">
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
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/75 transition-all duration-200 hover:translate-x-0.5 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active &&
                    "bg-gradient-to-r from-brand-400/20 to-brand-400/5 text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_rgb(45_197_172/0.25)]",
                )}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 -left-3 h-5 w-1 -translate-y-1/2 rounded-r-full bg-gradient-to-b from-gold-300 to-gold-500"
                  />
                ) : null}
                <Icon
                  className={cn(
                    "size-4 transition-colors",
                    active ? "text-sidebar-primary" : "text-sidebar-foreground/50 group-hover:text-brand-300",
                  )}
                />
                {item.title}
                {badges?.[item.href] ? (
                  <span
                    className="ml-auto rounded-full bg-gradient-to-r from-gold-300 to-gold-400 px-1.5 py-0.5 text-[10px] leading-none font-semibold text-sidebar-primary-foreground"
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
