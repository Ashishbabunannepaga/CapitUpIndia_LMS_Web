import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  CalendarClock,
  CopyCheck,
  FileSpreadsheet,
  IndianRupee,
  KanbanSquare,
  Sparkles,
  Sun,
  Users,
} from "lucide-react";

import type { UserRole } from "@/lib/database.types";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  description: string;
};

export type NavSection = {
  title: string;
  roles: readonly UserRole[];
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Workspace",
    roles: ["ADMIN", "AGENT"],
    items: [
      {
        title: "My Day",
        href: "/my-day",
        icon: Sun,
        description: "Renewals due, overdue follow-ups, today's tasks and your pipeline at a glance.",
      },
      {
        title: "Leads",
        href: "/leads",
        icon: KanbanSquare,
        description: "Your pipeline as a table, cards or Kanban, with POCs, notes and duplicate warnings.",
      },
      {
        title: "Calendar",
        href: "/calendar",
        icon: CalendarClock,
        description: "Renewal due dates, meetings and follow-up tasks by day and week.",
      },
      {
        title: "AI Intake",
        href: "/intake",
        icon: Sparkles,
        description: "Turn notes, speech or a visiting card photo into a structured lead.",
      },
    ],
  },
  {
    title: "Admin",
    roles: ["ADMIN"],
    items: [
      {
        title: "Bulk Import",
        href: "/admin/import",
        icon: FileSpreadsheet,
        description: "Paste or upload sheets, map columns, catch duplicates and distribute leads round-robin.",
      },
      {
        title: "Duplicates",
        href: "/admin/duplicates",
        icon: CopyCheck,
        description: "Companies being pursued by more than one agent, with resolution.",
      },
      {
        title: "Analytics",
        href: "/admin/analytics",
        icon: BarChart3,
        description: "Pipeline, renewals, conversion and agent performance.",
      },
      {
        title: "AI Usage",
        href: "/admin/ai-usage",
        icon: IndianRupee,
        description: "Gemini calls, tokens and INR cost by agent and feature.",
      },
      {
        title: "Team",
        href: "/admin/team",
        icon: Users,
        description: "Agents and admins, their roles and whether they are active.",
      },
    ],
  },
];

export function navForRole(role: UserRole): NavSection[] {
  return NAV_SECTIONS.filter((section) => section.roles.includes(role));
}

export function findNavItem(href: string): NavItem | undefined {
  return NAV_SECTIONS.flatMap((s) => s.items).find((item) => item.href === href);
}
