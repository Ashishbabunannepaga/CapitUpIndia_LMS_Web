"use client";

import { useState } from "react";
import { LogOut, Menu, X } from "lucide-react";

import { BrandLockup, BrandMark } from "@/components/brand/brand";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Profile } from "@/lib/database.types";
import { cn } from "@/lib/utils";
import type { AppNotification } from "@/lib/database.types";
import { NotificationBell } from "./notification-bell";
import { SidebarNav } from "./sidebar-nav";

type ShellUser = Pick<Profile, "full_name" | "email" | "role">;


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
    <div className="m-3 flex items-center gap-3 rounded-xl border border-sidebar-border bg-white/[0.04] px-3 py-3">
      <div className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gold-300 to-gold-500 text-xs font-semibold text-gold-900 ring-2 ring-white/10">
        {initials}
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-brand-400 ring-2 ring-sidebar" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-medium text-sidebar-foreground" title={user.email}>
          {user.full_name}
        </p>
        <Badge
          variant="outline"
          className="mt-1 border-gold-400/30 bg-gold-400/10 px-1.5 py-0 text-[10px] tracking-wide text-gold-200"
        >
          {user.role === "ADMIN" ? "Admin" : "Agent"}
        </Badge>
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
    <div className="relative flex h-full flex-col overflow-hidden bg-sidebar">
      {/* Brand glow and the logo's ring, faint, behind the navigation. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(28rem_18rem_at_0%_0%,rgb(45_197_172/0.22),transparent_60%),radial-gradient(24rem_18rem_at_100%_100%,rgb(236_203_118/0.12),transparent_60%)]"
      />
      <BrandMark className="pointer-events-none absolute -right-16 -bottom-10 size-56 animate-float opacity-[0.05] grayscale" />
      <div className="relative flex h-20 shrink-0 items-center px-5">
        <BrandLockup />
      </div>
      <div className="relative flex-1 overflow-y-auto">
        <SidebarNav role={user.role} badges={badges} onNavigate={onNavigate} />
      </div>
      <div className="relative">
        <UserPanel user={user} notifications={notifications} unreadNotifications={unreadNotifications} />
      </div>
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
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-sidebar-border bg-sidebar px-4 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation"
          onClick={() => setMobileOpen(true)}
          className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Menu />
        </Button>
        <BrandMark className="size-7" />
        <p className="text-sm font-semibold text-sidebar-foreground">CapitUp India</p>
      </header>
      <div
        className={cn("fixed inset-0 z-40 lg:hidden", mobileOpen ? "block" : "hidden")}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        <div className="absolute inset-0 animate-in bg-black/50 fade-in" onClick={() => setMobileOpen(false)} />
        <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-in duration-300 slide-in-from-left">
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

      <main className="ambient min-h-svh lg:pl-64">
        <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
