import type { Metadata } from "next";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  AlarmClock,
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  CalendarRange,
  CircleDot,
  FileText,
  ListChecks,
  MessageSquareText,
  PhoneCall,
  PieChart,
  Plus,
  Radar,
  RefreshCw,
  Sparkles,
  UserCheck,
  Users,
  UserX,
} from "lucide-react";

import { Donut, ProgressRing, StatCard } from "@/components/analytics/charts";
import { BrandMark } from "@/components/brand/brand";
import { CountUp } from "@/components/ui/count-up";
import { DuplicateBadge, StatusBadge } from "@/components/leads/lead-badges";
import { AssignAgentSelect } from "@/components/leads/lead-detail-actions";
import { MarkAllReadButton, QuickTaskForm, TaskList, type TaskItem } from "@/components/my-day/my-day-widgets";
import { Button } from "@/components/ui/button";
import { isAdmin, requireSession } from "@/lib/auth";
import type { LeadEvent, LeadStatus } from "@/lib/database.types";
import {
  addDays,
  businessDateOf,
  daysBetween,
  formatDate,
  formatDateTime,
  formatNoteTimestamp,
  formatTime,
  startOfBusinessDay,
  todayInBusinessTz,
} from "@/lib/dates";
import { LEAD_STATUSES, STATUS_COLORS } from "@/lib/domain";
import { leadsHref } from "@/lib/lead-filters";
import { getTeam, withAgentNames, type LeadWithAgent } from "@/lib/leads";
import { pipelineAnalytics, type AgentPipeline } from "@/server/data/analytics";
import { myDay } from "@/server/data/my-day";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "My Day" };


function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(new Date()),
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function Panel({
  title,
  count,
  icon: Icon,
  actions,
  children,
  className,
  tone = "brand",
}: {
  title: string;
  count?: number;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  tone?: "brand" | "gold" | "urgent";
}) {
  return (
    <section className={cn("surface overflow-hidden", className)}>
      <header className="flex items-center justify-between gap-2 border-b px-5 py-3">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold">
          {Icon ? (
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-md",
                tone === "brand" && "bg-brand-50 text-brand-700",
                tone === "gold" && "bg-gold-50 text-gold-700",
                tone === "urgent" && "bg-red-50 text-urgent",
              )}
            >
              <Icon className="size-3.5" />
            </span>
          ) : null}
          {title}
          {count !== undefined ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">{count}</span>
          ) : null}
        </h2>
        {actions}
      </header>
      <div className="px-5 py-3">{children}</div>
    </section>
  );
}

function PanelLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary"
    >
      {children} <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function RenewalRow({ lead, today, showAgent }: { lead: LeadWithAgent; today: string; showAgent: boolean }) {
  const days = daysBetween(today, lead.renewal_date!);
  const label =
    days < 0 ? `${-days}d overdue` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : `in ${days} days`;
  return (
    <li className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/60">
      <div
        className={cn(
          "relative flex w-20 shrink-0 flex-col items-center rounded-lg border px-2 py-1 text-center",
          days <= 0 ? "border-red-200 bg-red-50 text-urgent" : days <= 7 ? "border-amber-200 bg-amber-50 text-warning" : "bg-card",
        )}
      >
        {days <= 0 ? (
          <span aria-hidden="true" className="absolute -top-1 -right-1 size-2 rounded-full bg-urgent">
            <span className="absolute inset-0 animate-ping-soft rounded-full bg-urgent" />
          </span>
        ) : null}
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

type Upcoming = {
  key: string;
  date: string;
  sortKey: string;
  kind: "renewal" | "task";
  title: string;
  detail: string;
  href: string | null;
  status?: LeadStatus;
};

const weekdayFormat = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  timeZone: "Asia/Kolkata",
});

function dayHeading(date: string, today: string): string {
  const offset = daysBetween(today, date);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  return weekdayFormat.format(new Date(`${date}T12:00:00+05:30`));
}

/** Renewals and the caller's own tasks, soonest first, grouped by day. */
function UpcomingTimeline({ items, today }: { items: Upcoming[]; today: string }) {
  if (items.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">Nothing scheduled in the next 30 days.</p>;
  }
  const groups: { date: string; items: Upcoming[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last?.date === item.date) last.items.push(item);
    else groups.push({ date: item.date, items: [item] });
  }
  return (
    <ol className="space-y-4">
      {groups.map((group) => (
        <li key={group.date}>
          <p
            className={cn(
              "mb-1.5 text-[11px] font-semibold tracking-wide uppercase",
              group.date === today ? "text-brand-700" : "text-muted-foreground",
            )}
          >
            {dayHeading(group.date, today)}
          </p>
          <ul className="relative space-y-1 border-l border-dashed border-border pl-4">
            {group.items.map((item) => {
              const body = (
                <>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute top-2.5 -left-[21px] size-2.5 rounded-full ring-4 ring-card",
                      item.kind === "renewal" ? "bg-gold-500" : "bg-brand-500",
                    )}
                  />
                  <span className="flex items-center gap-1.5">
                    {item.kind === "renewal" ? (
                      <RefreshCw className="size-3 shrink-0 text-gold-600" />
                    ) : (
                      <ListChecks className="size-3 shrink-0 text-brand-600" />
                    )}
                    <span className="truncate text-sm font-medium group-hover:text-primary">{item.title}</span>
                  </span>
                  <span className="block truncate pl-[18px] text-xs text-muted-foreground">{item.detail}</span>
                </>
              );
              return (
                <li key={item.key} className="relative">
                  {item.href ? (
                    <Link href={item.href} className="group -mx-2 block rounded-md px-2 py-1 transition-colors hover:bg-muted/70">
                      {body}
                    </Link>
                  ) : (
                    <div className="-mx-2 px-2 py-1">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** Renewal windows as a small bar chart, each bar linking to its list. */
function RenewalRadar({
  counts,
}: {
  counts: { overdue: number; today: number; week: number; month: number; upcoming: number };
}) {
  const rows = [
    { label: "Overdue", value: counts.overdue, bar: "bg-red-500", href: leadsHref({ renewal: "overdue", sort: "renewal_desc" }) },
    { label: "Due today", value: counts.today, bar: "bg-orange-500", href: leadsHref({ renewal: "7", sort: "renewal_asc" }) },
    { label: "Next 7 days", value: counts.week, bar: "bg-amber-400", href: leadsHref({ renewal: "7", sort: "renewal_asc" }) },
    { label: "Next 30 days", value: counts.month, bar: "bg-gold-400", href: leadsHref({ renewal: "30", sort: "renewal_asc" }) },
    { label: "Next 90 days", value: counts.upcoming, bar: "bg-brand-400", href: leadsHref({ renewal: "90", sort: "renewal_asc" }) },
  ];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((row, i) => (
        <li key={row.label}>
          <Link href={row.href} className="group grid grid-cols-[88px_minmax(0,1fr)_36px] items-center gap-3 text-xs">
            <span className="text-muted-foreground group-hover:text-foreground">{row.label}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-muted">
              <span
                className={cn("block h-full origin-left animate-grow-x rounded-full", row.bar)}
                style={{ width: `${row.value === 0 ? 0 : Math.max(4, Math.round((row.value / max) * 100))}%`, animationDelay: `${i * 80}ms` }}
              />
            </span>
            <CountUp
              value={row.value}
              className={cn("text-right font-semibold", row.label === "Overdue" && row.value > 0 && "text-urgent")}
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

const STATUS_FIELDS: Record<LeadStatus, keyof AgentPipeline> = {
  Prospect: "prospect",
  Quoted: "quoted",
  "Active Client": "active_client",
  "Follow-up": "follow_up",
  "Closed Won": "won",
  "Closed Lost": "lost",
};

/** Admin view: each agent's pipeline as a stacked bar. */
function TeamBreakdown({ agents }: { agents: AgentPipeline[] }) {
  if (agents.length === 0) return <p className="py-2 text-sm text-muted-foreground">No leads yet.</p>;
  return (
    <ul className="space-y-3.5">
      {agents.map((agent, i) => {
        const initials = agent.agent_name
          .split(/\s+/)
          .map((p) => p[0])
          .join("")
          .slice(0, 2)
          .toUpperCase();
        const winRate = agent.won + agent.lost > 0 ? Math.round((agent.won / (agent.won + agent.lost)) * 100) : null;
        return (
          <li key={agent.agent_id ?? "unassigned"}>
            <Link
              href={leadsHref({ agent: agent.agent_id ?? "unassigned" })}
              className="group -mx-2 block rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60"
            >
              <div className="flex items-center gap-2.5">
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                    agent.agent_id ? "bg-brand-100 text-brand-800" : "bg-amber-100 text-amber-800",
                  )}
                >
                  {agent.agent_id ? initials : <UserX className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium group-hover:text-primary">{agent.agent_name}</span>
                {agent.overdue_renewals > 0 ? (
                  <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-urgent">
                    {agent.overdue_renewals} overdue
                  </span>
                ) : null}
                <span className="text-sm font-semibold tabular-nums">{agent.total}</span>
              </div>
              <div className="mt-1.5 ml-9.5 flex h-2 overflow-hidden rounded-full bg-muted">
                {LEAD_STATUSES.map((status) => {
                  const n = agent[STATUS_FIELDS[status]] as number;
                  return n > 0 ? (
                    <span
                      key={status}
                      title={`${status}: ${n}`}
                      className="h-full origin-left animate-grow-x"
                      style={{ width: `${(n / agent.total) * 100}%`, background: STATUS_COLORS[status], animationDelay: `${i * 90}ms` }}
                    />
                  ) : null;
                })}
              </div>
              <p className="mt-1 ml-9.5 text-[11px] text-muted-foreground">
                {agent.renewals_30d} renewals in 30 days · {agent.quoted} quoted
                {winRate !== null ? ` · ${winRate}% win rate` : ""}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default async function MyDayPage() {
  const { ctx, actor: profile } = await requireSession();
  const admin = isAdmin(profile);

  const today = todayInBusinessTz();
  const weekEnd = addDays(today, 7);
  const todayStart = startOfBusinessDay(today);
  const tomorrowStart = startOfBusinessDay(addDays(today, 1));

  // The right-hand overview uses the same scoping as everything else: an
  // agent's numbers cover their own leads, an admin's the whole team.
  const [day, team, pipeline] = await Promise.all([myDay(ctx, profile), getTeam(), pipelineAnalytics(ctx, profile)]);
  const renewals = await withAgentNames(day.renewals);
  const overdueRenewals = await withAgentNames(day.overdueRenewals);
  const recent = await withAgentNames(day.recentlyAssigned);
  const unassigned = day.unassigned?.leads ?? [];
  const unread = day.unreadNotes;
  const unreadCount = day.unreadNoteCount;
  const agents = team.filter((m) => m.is_active);

  const renewalsToday = renewals.filter((l) => l.renewal_date === today);
  const renewalsWeek = renewals.filter((l) => l.renewal_date! > today && l.renewal_date! <= weekEnd);
  const renewalsMonth = renewals.filter((l) => l.renewal_date! > weekEnd);

  const openEvents = day.openTasks;
  const at = (e: LeadEvent) => Date.parse(e.event_timestamp);
  const overdueTasks = openEvents.filter((e) => at(e) < Date.parse(todayStart)).map((e) => toTask(e, today));
  const todayTasks = openEvents
    .filter((e) => at(e) >= Date.parse(todayStart) && at(e) < Date.parse(tomorrowStart))
    .map((e) => toTask(e, today));
  const laterTasks = openEvents.filter((e) => at(e) >= Date.parse(tomorrowStart)).map((e) => toTask(e, today));
  const doneToday = day.doneToday.map((e) => toTask(e, today));

  const firstName = profile.full_name.split(/\s+/)[0];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const todaysWork = renewalsToday.length + overdueTasks.length + todayTasks.length;
  const checklistTotal = overdueTasks.length + todayTasks.length + doneToday.length;
  const openLeads = pipeline.total - (pipeline.by_status["Closed Won"] ?? 0) - (pipeline.by_status["Closed Lost"] ?? 0);

  const upcoming: Upcoming[] = [
    ...renewals.map((lead) => ({
      key: `r${lead.id}`,
      date: lead.renewal_date!,
      sortKey: `${lead.renewal_date} 00:00`,
      kind: "renewal" as const,
      title: lead.client_name,
      detail: `${lead.policy_product} renewal${admin ? ` · ${lead.agent_name ?? "Unassigned"}` : ""}`,
      href: `/leads/${lead.id}`,
      status: lead.status,
    })),
    // Renewal reminders are already shown as the renewal itself.
    ...openEvents
      .filter((e) => !e.is_system_generated && at(e) >= Date.parse(todayStart))
      .map((e) => ({
        key: `t${e.id}`,
        date: businessDateOf(e.event_timestamp),
        sortKey: `${businessDateOf(e.event_timestamp)} ${formatTime(e.event_timestamp)}`,
        kind: "task" as const,
        title: e.title,
        detail: `Task · ${formatTime(e.event_timestamp)}`,
        href: e.lead_id ? `/leads/${e.lead_id}` : null,
      })),
  ]
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .slice(0, 12);

  const longDate = new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(new Date());

  return (
    <>
      {/* Hero: who, what today, how far through the checklist. */}
      <section className="hero-band relative mb-6 overflow-hidden rounded-2xl px-6 py-6 text-white shadow-lift sm:px-8">
        <div aria-hidden="true" className="grid-texture absolute inset-0" />
        <BrandMark className="pointer-events-none absolute -top-10 right-40 hidden size-52 animate-float opacity-[0.08] md:block" />
        <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 space-y-2">
            <p className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-gold-200 uppercase">
              <CalendarRange className="size-3.5" /> {longDate} · {admin ? "Team overview" : "Your workspace"}
            </p>
            <h1 className="text-[28px] leading-tight font-semibold tracking-tight">
              {greeting()}, <span className="text-gold-gradient">{firstName}</span>
            </h1>
            <p className="max-w-2xl text-sm text-white/75">
              {todaysWork === 0
                ? "Nothing due today."
                : `Today: ${plural(renewalsToday.length, "renewal")} due, ${plural(todayTasks.length, "task")}${
                    overdueTasks.length ? `, ${overdueTasks.length} overdue` : ""
                  }.`}{" "}
              {plural(day.counts.followUps, "follow-up")} and {plural(day.counts.quoted, "quote")} open in the pipeline.
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button asChild className="bg-none bg-white text-brand-800 shadow-none hover:bg-gold-50 hover:from-transparent hover:to-transparent">
                <Link href="/leads/new">
                  <Plus />
                  New lead
                </Link>
              </Button>
              <Button asChild variant="ghost" className="text-white ring-1 ring-white/20 hover:bg-white/10 hover:text-white">
                <Link href="/intake">
                  <Sparkles className="text-gold-300" />
                  AI intake
                </Link>
              </Button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4 rounded-2xl bg-white/[0.06] px-5 py-4 ring-1 ring-white/10 backdrop-blur-sm">
            <ProgressRing
              value={doneToday.length}
              max={checklistTotal}
              size={84}
              stroke={9}
              trackClassName="stroke-white/15"
              barClassName="stroke-gold-300"
              label={`${doneToday.length} of ${checklistTotal} checklist items done today`}
            >
              <span className="text-lg leading-none font-semibold">
                {checklistTotal === 0 ? "—" : `${Math.round((doneToday.length / checklistTotal) * 100)}%`}
              </span>
            </ProgressRing>
            <div className="text-sm leading-snug">
              <p className="font-semibold">Today&apos;s checklist</p>
              <p className="text-white/70">
                {doneToday.length} of {checklistTotal} done
              </p>
              {overdueTasks.length > 0 ? (
                <a href="#tasks" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-red-200 hover:text-white">
                  <AlarmClock className="size-3" /> {overdueTasks.length} overdue
                </a>
              ) : (
                <p className="mt-1 text-xs text-brand-200">No overdue tasks</p>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="stagger mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Renewals this week"
          value={renewalsToday.length + renewalsWeek.length}
          href={leadsHref({ renewal: "7", sort: "renewal_asc" })}
          icon={CalendarClock}
          tone="warning"
          quiet={renewalsToday.length + renewalsWeek.length === 0}
        />
        <StatCard
          label="Overdue renewals"
          value={day.counts.overdueRenewals}
          href={leadsHref({ renewal: "overdue", sort: "renewal_desc" })}
          icon={AlarmClock}
          tone="urgent"
          quiet={day.counts.overdueRenewals === 0}
        />
        <StatCard label="Overdue tasks" value={overdueTasks.length} href="#tasks" icon={ListChecks} tone="urgent" quiet={overdueTasks.length === 0} />
        <StatCard
          label="Pending follow-ups"
          value={day.counts.followUps}
          href={leadsHref({ status: "Follow-up" })}
          icon={PhoneCall}
          tone="gold"
        />
        <StatCard label="Quoted" value={day.counts.quoted} href={leadsHref({ status: "Quoted" })} icon={FileText} tone="brand" />
        <StatCard
          label="Active clients"
          value={day.counts.activeClients}
          href={leadsHref({ status: "Active Client" })}
          icon={BadgeCheck}
          tone="success"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="stagger min-w-0 space-y-6">
          <Panel
            title="Renewals"
            icon={RefreshCw}
            tone="gold"
            count={renewals.length + overdueRenewals.length}
            actions={<PanelLink href={leadsHref({ renewal: "30", sort: "renewal_asc" })}>Next 30 days</PanelLink>}
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
                      <h3
                        className={cn(
                          "pt-1 text-[11px] font-semibold tracking-wide uppercase",
                          group.title === "Overdue" ? "text-urgent" : "text-muted-foreground",
                        )}
                      >
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

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel
              title="Today's checklist"
              icon={ListChecks}
              tone={overdueTasks.length > 0 ? "urgent" : "brand"}
              count={overdueTasks.length + todayTasks.length}
              className="scroll-mt-6"
            >
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
              icon={MessageSquareText}
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
                          <span className="size-1.5 shrink-0 rounded-full bg-gold-500" aria-hidden="true" />
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

          {admin ? (
            <Panel
              title="Unassigned leads"
              icon={UserX}
              tone="gold"
              count={day.unassigned?.count ?? 0}
              actions={<PanelLink href={leadsHref({ agent: "unassigned" })}>View all</PanelLink>}
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

          <Panel title={admin ? "Recently assigned" : "Recently assigned to you"} icon={UserCheck} count={recent.length}>
            {recent.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No new assignments in the last 7 days.</p>
            ) : (
              <ul className="divide-y">
                {recent.map((lead) => (
                  <li key={lead.id} className="flex items-center gap-3 py-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                      <UserCheck className="size-3.5" />
                    </span>
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

        {/* Overview rail: analytics and what is coming up. */}
        <aside aria-label="Overview" className="stagger min-w-0 space-y-6 xl:sticky xl:top-6 xl:self-start">
          <Panel
            title={admin ? "Team pipeline" : "Your pipeline"}
            icon={PieChart}
            actions={admin ? <PanelLink href="/admin/analytics">Analytics</PanelLink> : <PanelLink href={leadsHref({})}>Leads</PanelLink>}
          >
            <div className="py-1">
              <Donut
                centerValue={pipeline.total}
                centerLabel={pipeline.total === 1 ? "lead" : "leads"}
                data={LEAD_STATUSES.map((status) => ({
                  label: status,
                  value: pipeline.by_status[status] ?? 0,
                  color: STATUS_COLORS[status],
                  href: leadsHref({ status }),
                }))}
              />
              <div className="mt-4 grid grid-cols-3 gap-2 border-t pt-3 text-center">
                <div>
                  <CountUp value={openLeads} className="block text-base font-semibold" />
                  <span className="text-[11px] text-muted-foreground">Open</span>
                </div>
                <div>
                  <span className="block text-base font-semibold tabular-nums">
                    {(pipeline.by_status["Closed Won"] ?? 0) + (pipeline.by_status["Closed Lost"] ?? 0) === 0
                      ? "—"
                      : `${Math.round(
                          ((pipeline.by_status["Closed Won"] ?? 0) /
                            ((pipeline.by_status["Closed Won"] ?? 0) + (pipeline.by_status["Closed Lost"] ?? 0))) *
                            100,
                        )}%`}
                  </span>
                  <span className="text-[11px] text-muted-foreground">Win rate</span>
                </div>
                <div>
                  <CountUp
                    value={pipeline.duplicates}
                    className={cn("block text-base font-semibold", pipeline.duplicates > 0 && "text-urgent")}
                  />
                  <span className="text-[11px] text-muted-foreground">Duplicates</span>
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="Renewal radar" icon={Radar} tone="gold">
            <div className="py-1">
              <RenewalRadar counts={pipeline.renewals} />
            </div>
          </Panel>

          {admin ? (
            <Panel title="By agent" icon={Users} actions={<PanelLink href="/admin/team">Team</PanelLink>}>
              <div className="py-1">
                <TeamBreakdown agents={pipeline.agents} />
              </div>
            </Panel>
          ) : null}

          <Panel
            title="Upcoming"
            icon={CircleDot}
            count={upcoming.length}
            actions={<PanelLink href="/calendar">Calendar</PanelLink>}
          >
            <div className="py-1">
              <UpcomingTimeline items={upcoming} today={today} />
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
