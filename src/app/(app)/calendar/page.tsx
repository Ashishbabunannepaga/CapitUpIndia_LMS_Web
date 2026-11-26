import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import { MonthCalendar, type CalendarEntry } from "@/components/calendar/month-calendar";
import { QuickTaskForm } from "@/components/my-day/my-day-widgets";
import { isAdmin, requireSession } from "@/lib/auth";
import { addDays, businessDateOf, startOfBusinessDay, todayInBusinessTz } from "@/lib/dates";
import { getTeam } from "@/lib/leads";
import { listCalendarEvents } from "@/server/data/events";
import { calendarWorkTasks } from "@/server/data/work-tasks";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage() {
  const { ctx, actor: profile } = await requireSession();
  const admin = isAdmin(profile);
  const today = todayInBusinessTz();

  // Three months around today: enough to page a month back and forward.
  const range = { from: startOfBusinessDay(addDays(today, -45)), to: startOfBusinessDay(addDays(today, 75)) };
  const [events, gridTasks, team] = await Promise.all([
    listCalendarEvents(ctx, profile, { ...range, limit: 1000 }),
    calendarWorkTasks(ctx, profile, range),
    admin ? getTeam() : Promise.resolve([]),
  ]);

  const names = new Map(team.map((member) => [member.id, member.full_name]));
  const entries: CalendarEntry[] = events.map((event) => ({
    id: event.id,
    title: event.title,
    date: businessDateOf(event.event_timestamp),
    timestamp: event.event_timestamp,
    leadId: event.lead_id,
    leadName: event.lead_name,
    kind: event.kind,
    notes: event.notes,
    assigneeId: event.assigned_agent_id,
    isRenewal: event.is_system_generated,
    categories: event.categories,
    productLabel: event.product_label,
    isCompleted: event.is_completed,
    isSystem: event.is_system_generated,
    agentName: event.assigned_agent_id ? (names.get(event.assigned_agent_id) ?? null) : null,
  }));
  // Task Grid tasks with a due time: the ones this person is on (theirs and ones they gave).
  for (const task of gridTasks) {
    entries.push({
      id: task.id,
      title: task.title,
      date: businessDateOf(task.due_at!),
      timestamp: task.due_at!,
      leadId: task.lead_id,
      leadName: task.lead_name,
      kind: "task",
      notes: "",
      assigneeId: task.assignee_id,
      isRenewal: false,
      categories: ["grid_task"],
      isCompleted: task.status === "done",
      isSystem: false,
      agentName: task.assignee_id === profile.id ? "You" : task.assignee_name,
      gridTask: { priority: task.priority, status: task.status, personal: task.kind === "personal" },
    });
  }

  const agents = team.filter((m) => m.is_active).map(({ id, full_name }) => ({ id, full_name }));

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Calendar"
        description={
          admin
            ? "Every renewal due date, meeting and task across the team. Countdown reminders run in the background and arrive in your notifications."
            : "Your renewal due dates, meetings and tasks. Countdown reminders run in the background and arrive in your notifications."
        }
      />
      <div className="mb-6 max-w-3xl rounded-2xl border bg-card p-4 shadow-card">
        <h2 className="text-sm font-semibold">Add a meeting or task</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          For example &ldquo;Scheduled a meet with Rajesh at XYZ&rdquo;. Link it to a lead so it shows on the lead&apos;s page too.
        </p>
        <QuickTaskForm today={today} currentUserId={profile.id} assignees={admin ? agents : undefined} compact={false} />
      </div>
      <MonthCalendar
        entries={entries}
        today={today}
        initialMonth={today.slice(0, 7)}
        showAgent={admin}
        editing={{ today, currentUserId: profile.id, assignees: admin ? agents : undefined }}
      />
    </>
  );
}
