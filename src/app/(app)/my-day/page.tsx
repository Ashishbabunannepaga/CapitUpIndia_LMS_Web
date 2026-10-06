import type { Metadata } from "next";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  AlarmClock,
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  FileText,
  MessageSquareText,
  PhoneCall,
  Plus,
  UserCheck,
  UserX,
} from "lucide-react";

import { PageHeader } from "@/components/app-shell/page-header";
import { DuplicateBadge, StatusBadge } from "@/components/leads/lead-badges";
import { AssignAgentSelect } from "@/components/leads/lead-detail-actions";
import { MarkAllReadButton, QuickTaskForm, TaskList, type TaskItem } from "@/components/my-day/my-day-widgets";
import { Button } from "@/components/ui/button";
import { isAdmin, requireProfile } from "@/lib/auth";
import type { LeadEvent, LeadStatus } from "@/lib/database.types";
import {
  addDays,
  businessDateOf,
  daysBetween,
  formatDate,
  formatDateTime,
  formatNoteTimestamp,
  formatTime,
  nowMs,
  startOfBusinessDay,
  todayInBusinessTz,
} from "@/lib/dates";
import { leadsHref } from "@/lib/lead-filters";
import { getTeam, withAgentNames, type LeadWithAgent } from "@/lib/leads";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "My Day" };

const OPEN_STATUSES = '("Closed Won","Closed Lost")';

function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(new Date()),
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function Kpi({
  label,
  value,
  href,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number;
  href: string;
  icon: LucideIcon;
  tone?: "default" | "urgent" | "warning" | "success";
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
    >
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg",
          tone === "urgent" && value > 0 ? "bg-red-50 text-urgent" : "",
          tone === "warning" && value > 0 ? "bg-amber-50 text-warning" : "",
          tone === "success" ? "bg-emerald-50 text-success" : "",
          (tone === "default" || value === 0) && tone !== "success" ? "bg-accent text-accent-foreground" : "",
        )}
      >
        <Icon className="size-5" />
      </div>
      <div className="min-w-0">
        <p className="text-2xl leading-none font-semibold tabular-nums">{value}</p>
        <p className="mt-1 text-xs leading-tight text-muted-foreground">{label}</p>
      </div>
    </Link>
  );
}

function Panel({
  title,
  count,
  actions,
  children,
  className,
}: {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card shadow-sm", className)}>
      <header className="flex items-center justify-between gap-2 border-b px-5 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {count !== undefined ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{count}</span>
          ) : null}
        </h2>
        {actions}
      </header>
      <div className="px-5 py-3">{children}</div>
    </section>
  );
}

function RenewalRow({ lead, today, showAgent }: { lead: LeadWithAgent; today: string; showAgent: boolean }) {
  const days = daysBetween(today, lead.renewal_date!);
  const label =
    days < 0 ? `${-days}d overdue` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : `in ${days} days`;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div
        className={cn(
          "flex w-20 shrink-0 flex-col items-center rounded-md border px-2 py-1 text-center",
          days <= 0 ? "border-red-200 bg-red-50 text-urgent" : days <= 7 ? "border-amber-200 bg-amber-50 text-warning" : "",
        )}
      >
        <span className="text-xs font-semibold">{label}</span>
        <span className="text-[10px] opacity-80">{formatDate(lead.renewal_date)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <Link href={`/leads/${lead.id}`} className="block truncate text-sm font-medium hover:text-primary hover:underline">
          {lead.client_name}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {lead.policy_product}
          {lead.poc_name ? ` · ${lead.poc_name}` : ""}
          {lead.poc_contact_number ? ` · ${lead.poc_contact_number}` : ""}
          {showAgent ? ` · ${lead.agent_name ?? "Unassigned"}` : ""}
        </p>
      </div>
      <div className="hidden items-center gap-1.5 sm:flex">
        {lead.is_duplicate ? <DuplicateBadge label={lead.duplicate_label} /> : null}
        <StatusBadge status={lead.status} />
      </div>
    </li>
  );
}

function toTask(event: LeadEvent, today: string): TaskItem {
  const day = businessDateOf(event.event_timestamp);
  const offset = daysBetween(today, day);
  return {
    id: event.id,
    title: event.title,
    leadId: event.lead_id,
    isCompleted: event.is_completed,
    isSystem: event.is_system_generated,
    overdue: offset < 0,
    timeLabel:
      offset === 0
        ? `Today ${formatTime(event.event_timestamp)}`
        : offset === 1
          ? `Tomorrow ${formatTime(event.event_timestamp)}`
          : formatDateTime(event.event_timestamp),
  };
}

export default async function MyDayPage() {
  const profile = await requireProfile();
  const admin = isAdmin(profile);
  const supabase = await createClient();

  const today = todayInBusinessTz();
  const weekEnd = addDays(today, 7);
  const monthEnd = addDays(today, 30);
  const todayStart = startOfBusinessDay(today);
  const tomorrowStart = startOfBusinessDay(addDays(today, 1));
  const weekEndStart = startOfBusinessDay(addDays(today, 8));
  const sevenDaysAgo = new Date(nowMs() - 7 * 86_400_000).toISOString();

  const count = (status: LeadStatus) =>
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("status", status);

  const [
    activeClients,
    quoted,
    followUps,
    renewalsResult,
    overdueRenewalsResult,
    overdueRenewalCount,
    openTasksResult,
    doneTodayResult,
    recentResult,
    unassignedResult,
    unreadResult,
    unreadCountResult,
    team,
  ] = await Promise.all([
    count("Active Client"),
    count("Quoted"),
    count("Follow-up"),
    supabase
      .from("leads")
      .select("*")
      .gte("renewal_date", today)
      .lte("renewal_date", monthEnd)
      .not("status", "in", OPEN_STATUSES)
      .order("renewal_date")
      .limit(60),
    supabase
      .from("leads")
      .select("*")
      .lt("renewal_date", today)
      .gte("renewal_date", addDays(today, -30))
      .not("status", "in", OPEN_STATUSES)
      .order("renewal_date", { ascending: false })
      .limit(10),
    // Every overdue renewal, like the list the KPI links to; the panel shows the last 30 days.
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .lt("renewal_date", today)
      .not("status", "in", OPEN_STATUSES),
    supabase
      .from("events")
      .select("*")
      .eq("assigned_agent_id", profile.id)
      .eq("is_background_reminder", false)
      .eq("is_completed", false)
      .lt("event_timestamp", weekEndStart)
      .order("event_timestamp")
      .limit(100),
    supabase
      .from("events")
      .select("*")
      .eq("assigned_agent_id", profile.id)
      .eq("is_background_reminder", false)
      .eq("is_completed", true)
      .gte("completed_at", todayStart)
      .order("completed_at", { ascending: false })
      .limit(20),
    (admin
      ? supabase.from("leads").select("*").not("assigned_agent_id", "is", null)
      : supabase.from("leads").select("*").eq("assigned_agent_id", profile.id)
    )
      .gte("assigned_at", sevenDaysAgo)
      .order("assigned_at", { ascending: false })
      .limit(8),
    admin
      ? supabase
          .from("leads")
          .select("*", { count: "exact" })
          .is("assigned_agent_id", null)
          .order("created_at", { ascending: false })
          .limit(8)
      : Promise.resolve(null),
    supabase.rpc("unread_lead_notes", { p_limit: 8 }),
    supabase.rpc("count_unread_lead_notes"),
    getTeam(),
  ]);

  const renewals = await withAgentNames(renewalsResult.data ?? []);
  const overdueRenewals = await withAgentNames(overdueRenewalsResult.data ?? []);
  const recent = await withAgentNames(recentResult.data ?? []);
  const unassigned = unassignedResult?.data ?? [];
  const unread = unreadResult.data ?? [];
  const unreadCount = unreadCountResult.data ?? 0;
  const agents = team.filter((m) => m.is_active);

  const renewalsToday = renewals.filter((l) => l.renewal_date === today);
  const renewalsWeek = renewals.filter((l) => l.renewal_date! > today && l.renewal_date! <= weekEnd);
  const renewalsMonth = renewals.filter((l) => l.renewal_date! > weekEnd);

  const openEvents = openTasksResult.data ?? [];
  const at = (e: LeadEvent) => Date.parse(e.event_timestamp);
  const overdueTasks = openEvents.filter((e) => at(e) < Date.parse(todayStart)).map((e) => toTask(e, today));
  const todayTasks = openEvents
    .filter((e) => at(e) >= Date.parse(todayStart) && at(e) < Date.parse(tomorrowStart))
    .map((e) => toTask(e, today));
  const laterTasks = openEvents.filter((e) => at(e) >= Date.parse(tomorrowStart)).map((e) => toTask(e, today));
  const doneToday = (doneTodayResult.data ?? []).map((e) => toTask(e, today));

  const firstName = profile.full_name.split(/\s+/)[0];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const todaysWork = renewalsToday.length + overdueTasks.length + todayTasks.length;

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={`${
          todaysWork === 0
            ? "Nothing due today."
            : `Today: ${plural(renewalsToday.length, "renewal")} due, ${plural(todayTasks.length, "task")}${
                overdueTasks.length ? `, ${overdueTasks.length} overdue` : ""
              }.`
        } ${plural(followUps.count ?? 0, "follow-up")} and ${plural(quoted.count ?? 0, "quote")} open in the pipeline.`}
        actions={
          <Button asChild>
            <Link href="/leads/new">
              <Plus />
              New lead
            </Link>
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="Renewals this week"
          value={renewalsToday.length + renewalsWeek.length}
          href={leadsHref({ renewal: "7", sort: "renewal_asc" })}
          icon={CalendarClock}
          tone="warning"
        />
        <Kpi
          label="Overdue renewals"
          value={overdueRenewalCount.count ?? 0}
          href={leadsHref({ renewal: "overdue", sort: "renewal_desc" })}
          icon={AlarmClock}
          tone="urgent"
        />
        <Kpi label="Overdue tasks" value={overdueTasks.length} href="#tasks" icon={AlarmClock} tone="urgent" />
        <Kpi
          label="Follow-ups"
          value={followUps.count ?? 0}
          href={leadsHref({ status: "Follow-up" })}
          icon={PhoneCall}
          tone="warning"
        />
        <Kpi label="Quoted" value={quoted.count ?? 0} href={leadsHref({ status: "Quoted" })} icon={FileText} />
        <Kpi
          label="Active clients"
          value={activeClients.count ?? 0}
          href={leadsHref({ status: "Active Client" })}
          icon={BadgeCheck}
          tone="success"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div className="min-w-0 space-y-6 xl:col-span-3">
          <Panel
            title="Renewals"
            count={renewals.length + overdueRenewals.length}
            actions={
              <Link
                href={leadsHref({ renewal: "30", sort: "renewal_asc" })}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Next 30 days <ArrowRight className="size-3" />
              </Link>
            }
          >
            {renewals.length + overdueRenewals.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No renewals in the next 30 days.</p>
            ) : (
              <div className="space-y-4">
                {[
                  { title: "Overdue", items: overdueRenewals },
                  { title: "Due today", items: renewalsToday },
                  { title: "This week", items: renewalsWeek },
                  { title: "Later this month", items: renewalsMonth },
                ]
                  .filter((group) => group.items.length > 0)
                  .map((group) => (
                    <div key={group.title}>
                      <h3 className="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        {group.title}
                      </h3>
                      <ul className="divide-y">
                        {group.items.map((lead) => (
                          <RenewalRow key={lead.id} lead={lead} today={today} showAgent={admin} />
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            )}
          </Panel>

          {admin ? (
            <Panel
              title="Unassigned leads"
              count={unassignedResult?.count ?? 0}
              actions={
                <Link
                  href={leadsHref({ agent: "unassigned" })}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  View all <ArrowRight className="size-3" />
                </Link>
              }
            >
              {unassigned.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">Every lead has an owner.</p>
              ) : (
                <ul className="divide-y">
                  {unassigned.map((lead) => (
                    <li key={lead.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/leads/${lead.id}`}
                          className="block truncate text-sm font-medium hover:text-primary hover:underline"
                        >
                          {lead.client_name}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {lead.policy_product} · {lead.type}
                          {lead.renewal_date ? ` · renews ${formatDate(lead.renewal_date)}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 sm:w-56">
                        <UserX className="size-4 shrink-0 text-warning" />
                        <AssignAgentSelect leadId={lead.id} agentId={null} agents={agents} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          ) : null}

          <Panel title={admin ? "Recently assigned" : "Recently assigned to you"} count={recent.length}>
            {recent.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No new assignments in the last 7 days.</p>
            ) : (
              <ul className="divide-y">
                {recent.map((lead) => (
                  <li key={lead.id} className="flex items-center gap-3 py-2.5">
                    <UserCheck className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/leads/${lead.id}`}
                        className="block truncate text-sm font-medium hover:text-primary hover:underline"
                      >
                        {lead.client_name}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {lead.policy_product}
                        {admin ? ` · ${lead.agent_name ?? "Unassigned"}` : ""} · assigned {formatDateTime(lead.assigned_at!)}
                      </p>
                    </div>
                    <StatusBadge status={lead.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-6 xl:col-span-2">
          <Panel title="Today's checklist" count={overdueTasks.length + todayTasks.length} className="scroll-mt-6">
            <div id="tasks" className="space-y-4">
              <QuickTaskForm
                today={today}
                currentUserId={profile.id}
                assignees={admin ? agents.map((a) => ({ id: a.id, full_name: a.full_name })) : undefined}
              />
              {overdueTasks.length > 0 ? (
                <div>
                  <h3 className="text-xs font-semibold tracking-wide text-urgent uppercase">Overdue</h3>
                  <TaskList tasks={overdueTasks} emptyText="" />
                </div>
              ) : null}
              <div>
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Today</h3>
                <TaskList tasks={[...todayTasks, ...doneToday]} emptyText="Nothing planned for today." />
              </div>
              {laterTasks.length > 0 ? (
                <div>
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">This week</h3>
                  <TaskList tasks={laterTasks} emptyText="" />
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel
            title={admin ? "New notes from agents" : "New notes on your leads"}
            count={unreadCount}
            actions={unreadCount > 0 ? <MarkAllReadButton /> : null}
          >
            {unread.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">You&apos;re all caught up.</p>
            ) : (
              <ul className="divide-y">
                {unread.map((note) => (
                  <li key={note.id} className="py-2.5">
                    <Link href={`/leads/${note.lead_id}`} className="group block">
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <MessageSquareText className="size-3.5" />
                        <span className="font-medium text-foreground">{note.agent_name}</span> on{" "}
                        <span className="truncate font-medium text-foreground group-hover:text-primary group-hover:underline">
                          {note.client_name}
                        </span>
                        <span className="ml-auto shrink-0">{formatNoteTimestamp(note.created_at)}</span>
                      </p>
                      <p className="mt-1 line-clamp-2 text-sm">{note.content}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
