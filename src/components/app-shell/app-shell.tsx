"use client";

import { useState } from "react";
import { LogOut, Menu, ShieldCheck, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Profile } from "@/lib/database.types";
import { cn } from "@/lib/utils";
import type { AppNotification } from "@/lib/database.types";
import { NotificationBell } from "./notification-bell";
import { SidebarNav } from "./sidebar-nav";

type ShellUser = Pick<Profile, "full_name" | "email" | "role">;

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-6">
      <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
        <ShieldCheck className="size-4" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-sidebar-foreground">CapitUp India</p>
        <p className="text-[11px] text-sidebar-foreground/60">Lead &amp; Renewal CRM</p>
      </div>
    </div>
  );
}

type NotificationItem = Pick<AppNotification, "id" | "title" | "body" | "lead_id" | "created_at" | "read_at">;

function UserPanel({
  user,
  notifications,
  unreadNotifications,
}: {
  user: ShellUser;
  notifications: NotificationItem[];
  unreadNotifications: number;
}) {
  const initials = user.full_name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
        {initials}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-sidebar-foreground">{user.full_name}</p>
          <Badge
            variant="outline"
            className="border-sidebar-border px-1.5 py-0 text-[10px] tracking-wide text-sidebar-foreground/70"
          >
            {user.role === "ADMIN" ? "Admin" : "Agent"}
          </Badge>
        </div>
        <p className="truncate text-xs text-sidebar-foreground/60">{user.email}</p>
      </div>
      <NotificationBell notifications={notifications} unread={unreadNotifications} />
      <form action="/auth/signout" method="post">
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          title="Sign out"
          aria-label="Sign out"
          className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <LogOut />
        </Button>
      </form>
    </div>
  );
}

type NavBadges = Record<string, number>;

function SidebarContents({
  user,
  badges,
  notifications,
  unreadNotifications,
  onNavigate,
}: {
  user: ShellUser;
  badges?: NavBadges;
  notifications: NotificationItem[];
  unreadNotifications: number;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-16 shrink-0 items-center">
        <Brand />
      </div>
      <div className="flex-1 overflow-y-auto">
        <SidebarNav role={user.role} badges={badges} onNavigate={onNavigate} />
      </div>
      <UserPanel user={user} notifications={notifications} unreadNotifications={unreadNotifications} />
    </div>
  );
}

export function AppShell({
  user,
  badges,
  notifications = [],
  unreadNotifications = 0,
  children,
}: {
  user: ShellUser;
  /** Counts shown next to sidebar items, keyed by href (e.g. unread notes on My Day). */
  badges?: NavBadges;
  /** Renewal reminders for the bell, newest first. */
  notifications?: NotificationItem[];
  unreadNotifications?: number;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-svh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <SidebarContents
          user={user}
          badges={badges}
          notifications={notifications}
          unreadNotifications={unreadNotifications}
        />
      </aside>

      {/* Mobile header + drawer */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-sidebar px-4 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation"
          onClick={() => setMobileOpen(true)}
          className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Menu />
        </Button>
        <p className="text-sm font-semibold text-sidebar-foreground">CapitUp India</p>
      </header>
      <div
        className={cn("fixed inset-0 z-40 lg:hidden", mobileOpen ? "block" : "hidden")}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
        <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw]">
          <SidebarContents
            user={user}
            badges={badges}
            notifications={notifications}
            unreadNotifications={unreadNotifications}
            onNavigate={() => setMobileOpen(false)}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="absolute top-3 -right-11 text-white hover:bg-white/10 hover:text-white"
          >
            <X />
          </Button>
        </div>
      </div>

      <main className="lg:pl-64">
        <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
