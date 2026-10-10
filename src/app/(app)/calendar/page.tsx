import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/page-header";
import { MonthCalendar, type CalendarEntry } from "@/components/calendar/month-calendar";
import { QuickTaskForm } from "@/components/my-day/my-day-widgets";
import { isAdmin, requireSession } from "@/lib/auth";
import { addDays, businessDateOf, startOfBusinessDay, todayInBusinessTz } from "@/lib/dates";
import { getTeam } from "@/lib/leads";
import { listEvents } from "@/server/data/events";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage() {
  const { ctx, actor: profile } = await requireSession();
  const admin = isAdmin(profile);
  const today = todayInBusinessTz();

  // Three months around today: enough to page a month back and forward.
  const [events, team] = await Promise.all([
    listEvents(ctx, profile, {
      from: startOfBusinessDay(addDays(today, -45)),
      to: startOfBusinessDay(addDays(today, 75)),
      limit: 1000,
    }),
    admin ? getTeam() : Promise.resolve([]),
  ]);

  const names = new Map(team.map((member) => [member.id, member.full_name]));
  const entries: CalendarEntry[] = events.map((event) => ({
    id: event.id,
    title: event.title,
    date: businessDateOf(event.event_timestamp),
    timestamp: event.event_timestamp,
    leadId: event.lead_id,
    isRenewal: event.is_system_generated,
    isCompleted: event.is_completed,
    isSystem: event.is_system_generated,
    agentName: event.assigned_agent_id ? (names.get(event.assigned_agent_id) ?? null) : null,
  }));

  const agents = team.filter((m) => m.is_active).map(({ id, full_name }) => ({ id, full_name }));

  return (
    <>
      <PageHeader
        title="Calendar"
        description={
          admin
            ? "Every renewal due date, meeting and task across the team. Countdown reminders run in the background and arrive in your notifications."
            : "Your renewal due dates, meetings and tasks. Countdown reminders run in the background and arrive in your notifications."
        }
      />
      <div className="mb-6 max-w-2xl rounded-xl border bg-card p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold">Plan a task</h2>
        <QuickTaskForm today={today} currentUserId={profile.id} assignees={admin ? agents : undefined} />
      </div>
      <MonthCalendar entries={entries} today={today} initialMonth={today.slice(0, 7)} showAgent={admin} />
    </>
  );
}
