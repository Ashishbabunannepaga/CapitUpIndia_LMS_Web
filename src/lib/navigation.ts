import type { LucideIcon } from "lucide-react";
import {
  AlarmClock,
  ListChecks,
  HeartPulse,
  History,
  ArchiveRestore,
  Activity,
  BarChart3,
  CalendarClock,
  CopyCheck,
  FileSpreadsheet,
  Globe,
  IndianRupee,
  KanbanSquare,
  ListTodo,
  ScanText,
  Smartphone,
  Sun,
  Users,
  MessageCircle,
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
        title: "Task Grid",
        href: "/tasks",
        icon: ListTodo,
        description: "Tasks admins give and your own to-dos, each with a conversation thread.",
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
        title: "Add lead",
        href: "/leads/new",
        icon: ScanText,
        description: "AI intake from notes, speech or a visiting card photo, or add the lead manually.",
      },
      {
        title: "Office portal",
        href: "/office",
        icon: Globe,
        description: "Open capitupindia.com/office and see its uploaded policies, gap reports and renewals.",
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
        title: "App leads",
        href: "/admin/app-leads",
        icon: Smartphone,
        description: "CapitUp app users who opted in to be contacted, ready to hand to an agent.",
      },
      {
        title: "Duplicates",
        href: "/admin/duplicates",
        icon: CopyCheck,
        description: "Companies being pursued by more than one agent, with resolution.",
      },
      {
        title: "Team activity",
        href: "/admin/activity",
        icon: Activity,
        description: "Live leads tracker, every agent action, and the monthly Excel report.",
      },
      {
        title: "Audit log",
        href: "/admin/audit",
        icon: History,
        description: "Every change to every lead: who, which field, old and new value, when.",
      },
      {
        title: "Deleted & exports",
        href: "/admin/deleted",
        icon: ArchiveRestore,
        description: "Restore deleted leads for 90 days, and see every Excel download of client data.",
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
        description: "AI calls, tokens and INR cost by agent and feature.",
      },
      {
        title: "Playbooks",
        href: "/admin/playbooks",
        icon: ListChecks,
        description: "Renewal step chains that become tasks for the lead's agent as each date comes up.",
      },
      {
        title: "Task rules",
        href: "/admin/task-rules",
        icon: AlarmClock,
        description: "Reminder, nudge and escalation timings per tag, and the holiday calendar.",
      },
      {
        title: "WhatsApp",
        href: "/admin/whatsapp",
        icon: MessageCircle,
        description: "Task alerts on WhatsApp: numbers per person, setup check and a test message.",
      },
      {
        title: "System health",
        href: "/admin/health",
        icon: HeartPulse,
        description: "Uptime checks every 5 minutes, server and browser errors, and where alerts go.",
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
