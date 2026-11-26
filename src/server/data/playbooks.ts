import "server-only";

import { and, asc, eq, gte, inArray, isNotNull, lte, notInArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import { addDays, businessDateTimeToIso, todayInBusinessTz } from "@/lib/dates";
import { isTaskPriority, parseTags, type TaskPriority } from "@/lib/work-tasks";

import {
  leads,
  notifications,
  PLAYBOOK_SCOPES,
  playbookTasks,
  profiles,
  taskPlaybooks,
  taskPlaybookSteps,
  workTaskMessages,
  workTasks,
  workTaskTags,
} from "../db/schema";
import { assertAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";

// Renewal playbooks (Admin > Playbooks). Each active playbook is a chain of
// steps, each due some days from a lead's renewal date. Hourly, a step
// becomes a Task Grid task for the lead's agent OPEN_DAYS before it is due,
// linked to the lead and tagged, so it gets the usual reminders, nudges and
// escalation. Each step is created once per renewal cycle (playbook_tasks);
// when the renewal rolls to next year the chain starts again. Closed Lost and
// Auto Renewed leads, unassigned leads and inactive agents are skipped. A step
// already more than LATE_DAYS overdue when first seen (a lead added late) is
// skipped rather than dumped on the agent.

export const OPEN_DAYS = 3;
const LATE_DAYS = 3;
const SKIP_STATUSES = ["Closed Lost", "Auto Renewed"] as const;
const PER_RUN = 150;

export type PlaybookStep = { id: number; day_offset: number; title: string; description: string; priority: TaskPriority; tags: string };
export type Playbook = { id: number; name: string; applies_to: (typeof PLAYBOOK_SCOPES)[number]; active: boolean; steps: PlaybookStep[] };

export async function listPlaybooks(ctx: DataContext, actor: Actor): Promise<Playbook[]> {
  assertAdmin(actor);
  return loadPlaybooks(ctx, false);
}

async function loadPlaybooks(ctx: DataContext, activeOnly: boolean): Promise<Playbook[]> {
  const books = await ctx.db
    .select()
    .from(taskPlaybooks)
    .where(activeOnly ? eq(taskPlaybooks.active, true) : undefined)
    .orderBy(asc(taskPlaybooks.id));
  if (!books.length) return [];
  const steps = await ctx.db
    .select()
    .from(taskPlaybookSteps)
    .where(
      inArray(
        taskPlaybookSteps.playbook_id,
        books.map((b) => b.id),
      ),
    )
    .orderBy(asc(taskPlaybookSteps.day_offset), asc(taskPlaybookSteps.id));
  return books.map((b) => ({
    id: b.id,
    name: b.name,
    applies_to: b.applies_to,
    active: b.active,
    steps: steps
      .filter((s) => s.playbook_id === b.id)
      .map((s) => ({ id: s.id, day_offset: s.day_offset, title: s.title, description: s.description, priority: s.priority, tags: s.tags })),
  }));
}

export async function createPlaybook(ctx: DataContext, actor: Actor, name: string, appliesTo: string): Promise<number> {
  assertAdmin(actor);
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new InvalidInputError("Name the playbook.");
  const scope = (PLAYBOOK_SCOPES as readonly string[]).includes(appliesTo) ? (appliesTo as Playbook["applies_to"]) : "any";
  const [row] = await ctx.db.insert(taskPlaybooks).values({ name: clean, applies_to: scope }).returning({ id: taskPlaybooks.id });
  return row.id;
}

export async function setPlaybookActive(ctx: DataContext, actor: Actor, id: number, active: boolean): Promise<void> {
  assertAdmin(actor);
  await ctx.db.batch([
    ctx.db.update(taskPlaybooks).set({ active }).where(eq(taskPlaybooks.id, id)),
    auditInsert(ctx, actor, "task_playbooks", id, "UPDATE", { active: !active }, { active }),
  ]);
}

export async function deletePlaybook(ctx: DataContext, actor: Actor, id: number): Promise<void> {
  assertAdmin(actor);
  await ctx.db.delete(taskPlaybooks).where(eq(taskPlaybooks.id, id));
}

export type StepInput = { day_offset: number; title: string; description?: string; priority?: string; tags?: string };

export async function addPlaybookStep(ctx: DataContext, actor: Actor, playbookId: number, input: StepInput): Promise<void> {
  assertAdmin(actor);
  const offset = Math.round(Number(input.day_offset));
  if (!Number.isFinite(offset) || offset < -365 || offset > 60) throw new InvalidInputError("Days must be between -365 (before the renewal) and 60 (after).");
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new InvalidInputError("Give the step a title.");
  const book = await ctx.db.query.taskPlaybooks.findFirst({ where: eq(taskPlaybooks.id, playbookId) });
  if (!book) throw new InvalidInputError("That playbook no longer exists.");
  await ctx.db.insert(taskPlaybookSteps).values({
    playbook_id: playbookId,
    day_offset: offset,
    title,
    description: (input.description ?? "").trim().slice(0, 2000),
    priority: input.priority && isTaskPriority(input.priority) ? input.priority : "P2",
    tags: parseTags(input.tags ?? "").join(","),
  });
}

export async function deletePlaybookStep(ctx: DataContext, actor: Actor, stepId: number): Promise<void> {
  assertAdmin(actor);
  await ctx.db.delete(taskPlaybookSteps).where(eq(taskPlaybookSteps.id, stepId));
}

const fill = (text: string, client: string) => text.replaceAll("{client}", client);

/** Creates every playbook step whose open date has come. Returns how many tasks were created. */
export async function runPlaybooks(ctx: DataContext, at: Date = new Date(), limit = PER_RUN): Promise<number> {
  const books = (await loadPlaybooks(ctx, true)).filter((b) => b.steps.length > 0);
  if (!books.length) return 0;
  const today = todayInBusinessTz(at);
  const earliest = Math.min(...books.flatMap((b) => b.steps.map((s) => s.day_offset)));
  const latest = Math.max(...books.flatMap((b) => b.steps.map((s) => s.day_offset)));
  // renewal + offset - OPEN_DAYS <= today  and  renewal + offset >= today - LATE_DAYS
  const from = addDays(today, -LATE_DAYS - latest);
  const until = addDays(today, OPEN_DAYS - earliest);

  const candidates = await ctx.db
    .select({
      id: leads.id,
      client_name: leads.client_name,
      renewal_date: leads.renewal_date,
      business_type: leads.business_type,
      agent_id: leads.assigned_agent_id,
    })
    .from(leads)
    .innerJoin(profiles, eq(profiles.id, leads.assigned_agent_id))
    .where(
      and(
        isNotNull(leads.renewal_date),
        gte(leads.renewal_date, from),
        lte(leads.renewal_date, until),
        notInArray(leads.status, [...SKIP_STATUSES]),
        eq(profiles.is_active, true),
      ),
    )
    .orderBy(asc(leads.renewal_date));
  if (!candidates.length) return 0;

  const done = await ctx.db
    .select({ step_id: playbookTasks.step_id, lead_id: playbookTasks.lead_id, renewal_date: playbookTasks.renewal_date })
    .from(playbookTasks)
    .where(inArray(playbookTasks.lead_id, [...new Set(candidates.map((c) => c.id))].slice(0, 5000)));
  const seen = new Set(done.map((d) => `${d.step_id}:${d.lead_id}:${d.renewal_date}`));

  let created = 0;
  for (const lead of candidates) {
    for (const book of books) {
      if (book.applies_to !== "any" && book.applies_to !== lead.business_type) continue;
      for (const step of book.steps) {
        if (created >= limit) return created;
        const renewal = lead.renewal_date!;
        const due = addDays(renewal, step.day_offset);
        if (addDays(due, -OPEN_DAYS) > today || due < addDays(today, -LATE_DAYS)) continue;
        const key = `${step.id}:${lead.id}:${renewal}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Claim first, so two overlapping runs never create the same step twice.
        const claim = await ctx.db
          .insert(playbookTasks)
          .values({ step_id: step.id, lead_id: lead.id, renewal_date: renewal })
          .onConflictDoNothing()
          .returning({ step_id: playbookTasks.step_id });
        if (!claim.length) continue;

        const title = fill(step.title, lead.client_name).slice(0, 200);
        const tags = parseTags([...step.tags.split(","), "playbook"]);
        const [task] = await ctx.db
          .insert(workTasks)
          .values({
            kind: "assigned",
            title,
            description: fill(step.description, lead.client_name),
            priority: step.priority,
            due_at: businessDateTimeToIso(due, "18:00"),
            assignee_id: lead.agent_id!,
            created_by: null,
            created_by_name: book.name,
            lead_id: lead.id,
          })
          .returning({ id: workTasks.id });
        const writes: BatchItem<"sqlite">[] = [
          ctx.db
            .update(playbookTasks)
            .set({ task_id: task.id })
            .where(and(eq(playbookTasks.step_id, step.id), eq(playbookTasks.lead_id, lead.id), eq(playbookTasks.renewal_date, renewal))),
          ctx.db.insert(workTaskMessages).values({
            task_id: task.id,
            author_id: null,
            author_name: "Playbook",
            kind: "system",
            body: `Created by the "${book.name}" playbook for the ${renewal} renewal.`,
          }),
          ctx.db.insert(notifications).values({
            user_id: lead.agent_id!,
            kind: "other",
            title: `Renewal step: ${title}`.slice(0, 300),
            body: `${step.priority} · due ${due} · ${book.name}`,
            task_id: task.id,
            lead_id: lead.id,
          }),
        ];
        if (tags.length) writes.push(ctx.db.insert(workTaskTags).values(tags.map((tag) => ({ task_id: task.id, tag }))));
        await ctx.db.batch(writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
        created += 1;
      }
    }
  }
  return created;
}
