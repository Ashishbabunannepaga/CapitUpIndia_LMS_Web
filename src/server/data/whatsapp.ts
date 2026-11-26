import "server-only";

import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { notifications, profiles } from "../db/schema";
import type { WhatsAppSender } from "../whatsapp/client";
import { assertAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { InvalidInputError } from "./errors";
import { setWorkTaskStatus, snoozeWorkTask } from "./work-tasks";

// WhatsApp task alerts for the team. An admin turns them on per person with
// their number (Admin > WhatsApp). The per-minute cron sends the important
// Task Grid bell notifications (due soon, due now, overdue, escalations, new
// tasks, approvals, renewal steps) to WhatsApp with Done and Snooze 1h
// buttons; a reply comes back through the webhook (src/app/api/whatsapp) and
// acts as that person, under the same rules as the app.

/** Alerts per cron run, to stay within the Worker's limits. */
export const WHATSAPP_BATCH = 30;
/** Older alerts are not worth a message any more; they stay in the bell. */
const WINDOW_MS = 60 * 60_000;
/** Bell notifications that also go to WhatsApp (by their title). */
const ALERT_PREFIXES = ["Due soon:", "Due now:", "Overdue by", "Still not done:", "New task from", "Approval needed", "Renewal step:", "Repeating task:"];

/** Digits with country code. A 10-digit Indian mobile gets 91 in front. */
export function normalizeWhatsAppPhone(input: string): string {
  const digits = input.replace(/\D/g, "").replace(/^00/, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^[1-9]\d{10,14}$/.test(digits)) return digits;
  throw new InvalidInputError("Enter a mobile number, like 98765 43210 or +91 98765 43210.");
}

export type WhatsAppMember = { id: string; full_name: string; role: string; is_active: boolean; whatsapp_phone: string | null; whatsapp_on: boolean };

export async function listWhatsAppTeam(ctx: DataContext, actor: Actor): Promise<WhatsAppMember[]> {
  assertAdmin(actor);
  return ctx.db
    .select({
      id: profiles.id,
      full_name: profiles.full_name,
      role: profiles.role,
      is_active: profiles.is_active,
      whatsapp_phone: profiles.whatsapp_phone,
      whatsapp_on: profiles.whatsapp_on,
    })
    .from(profiles)
    .orderBy(asc(profiles.full_name));
}

/** An admin sets someone's WhatsApp number and turns their alerts on or off. */
export async function setWhatsApp(ctx: DataContext, actor: Actor, userId: string, phone: string, on: boolean): Promise<void> {
  assertAdmin(actor);
  const member = await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, userId) });
  if (!member) throw new InvalidInputError("That person no longer exists.");
  const number = phone.trim() ? normalizeWhatsAppPhone(phone) : null;
  if (on && !number) throw new InvalidInputError("Add a number before turning WhatsApp on.");
  if (number) {
    const taken = await ctx.db.query.profiles.findFirst({ where: and(eq(profiles.whatsapp_phone, number), sql`${profiles.id} <> ${userId}`) });
    if (taken) throw new InvalidInputError(`That number is already set for ${taken.full_name}.`);
  }
  await ctx.db.batch([
    ctx.db.update(profiles).set({ whatsapp_phone: number, whatsapp_on: on && !!number }).where(eq(profiles.id, userId)),
    auditInsert(
      ctx,
      actor,
      "profiles",
      userId,
      "UPDATE",
      { whatsapp_phone: member.whatsapp_phone, whatsapp_on: member.whatsapp_on },
      { whatsapp_phone: number, whatsapp_on: on && !!number },
    ),
  ]);
}

/**
 * Sends new task alerts to the WhatsApp of people who have it on. Each one is
 * claimed before sending, so two overlapping runs never send it twice.
 * Returns how many went out.
 */
export async function sendWhatsAppAlerts(ctx: DataContext, send: WhatsAppSender, at: Date = new Date()): Promise<number> {
  const since = new Date(at.getTime() - WINDOW_MS).toISOString();
  const pending = await ctx.db
    .select({ id: notifications.id, title: notifications.title, body: notifications.body, task_id: notifications.task_id, phone: profiles.whatsapp_phone })
    .from(notifications)
    .innerJoin(profiles, eq(profiles.id, notifications.user_id))
    .where(
      and(
        isNull(notifications.whatsapp_at),
        isNotNull(notifications.task_id),
        gte(notifications.created_at, since),
        eq(profiles.whatsapp_on, true),
        eq(profiles.is_active, true),
        isNotNull(profiles.whatsapp_phone),
        or(...ALERT_PREFIXES.map((p) => sql`${notifications.title} like ${`${p}%`}`)),
      ),
    )
    .orderBy(asc(notifications.created_at), asc(notifications.id))
    .limit(WHATSAPP_BATCH);
  if (pending.length === 0) return 0;

  const stamp = at.toISOString();
  const claimed = await ctx.db
    .update(notifications)
    .set({ whatsapp_at: stamp })
    .where(and(inArray(notifications.id, pending.map((n) => n.id)), isNull(notifications.whatsapp_at)))
    .returning({ id: notifications.id });
  const mine = new Set(claimed.map((c) => c.id));

  let sent = 0;
  for (const n of pending) {
    if (!mine.has(n.id)) continue;
    const result = await send({ to: n.phone!, title: n.title, body: n.body, taskId: n.task_id! });
    if (result.ok) {
      sent += 1;
      await ctx.db.update(notifications).set({ whatsapp_msg_id: result.id }).where(eq(notifications.id, n.id));
    } else {
      console.error("WhatsApp alert failed", { notification: n.id, error: result.error });
    }
  }
  return sent;
}

export type WhatsAppReply = { from: string; payload?: string; text?: string; contextId?: string };

/**
 * A button press or reply on WhatsApp: "Done" closes the task, "Snooze"
 * pauses its reminders for an hour. It acts as the person whose number it
 * came from, with the same checks as the app. Returns the answer to send
 * back, or null for a number we don't know (no answer is sent).
 */
export async function handleWhatsAppReply(ctx: DataContext, reply: WhatsAppReply, at: Date = new Date()): Promise<string | null> {
  const from = reply.from.replace(/\D/g, "");
  const person = await ctx.db.query.profiles.findFirst({
    where: and(eq(profiles.whatsapp_phone, from), eq(profiles.whatsapp_on, true), eq(profiles.is_active, true)),
  });
  if (!person) return null;

  let action: "done" | "snooze" | null = null;
  let taskId: number | null = null;
  const button = /^(done|snooze):(\d{1,12})$/.exec(reply.payload ?? "");
  if (button) {
    action = button[1] as "done" | "snooze";
    taskId = Number(button[2]);
  } else {
    const word = (reply.text ?? reply.payload ?? "").trim().toLowerCase();
    if (/^(done|completed?|finished)\b/.test(word)) action = "done";
    else if (/^(snooze|later|on it)\b/.test(word)) action = "snooze";
    if (action && reply.contextId) {
      const n = await ctx.db.query.notifications.findFirst({
        where: and(eq(notifications.whatsapp_msg_id, reply.contextId), eq(notifications.user_id, person.id)),
      });
      taskId = n?.task_id ?? null;
    }
  }
  if (!action) return 'Reply to a task alert with "Done" or "Snooze", or open the LMS.';
  if (!taskId) return "Swipe to reply on the task alert itself, so I know which task you mean.";

  try {
    if (action === "done") {
      await setWorkTaskStatus(ctx, person, taskId, "done", "Marked done from WhatsApp.");
      return "Done. The task is closed.";
    }
    await snoozeWorkTask(ctx, person, taskId, new Date(at.getTime() + 60 * 60_000), at);
    return "Snoozed. Reminders are paused for 1 hour.";
  } catch (error) {
    return error instanceof Error && error.message ? error.message : "That didn't work. Open the task in the LMS.";
  }
}

/** Alerts that went out on WhatsApp in the last 24 hours, for Admin > WhatsApp. */
export async function whatsAppSentToday(ctx: DataContext, actor: Actor, at: Date = new Date()): Promise<number> {
  assertAdmin(actor);
  const since = new Date(at.getTime() - 24 * 60 * 60_000).toISOString();
  const rows = await ctx.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(isNotNull(notifications.whatsapp_msg_id), gte(notifications.created_at, since), lt(notifications.created_at, at.toISOString())));
  return rows.length;
}

/** An admin sends a test alert to someone's WhatsApp, to check the setup end to end. */
export async function sendWhatsAppTest(ctx: DataContext, actor: Actor, userId: string, send: WhatsAppSender): Promise<void> {
  assertAdmin(actor);
  const member = await ctx.db.query.profiles.findFirst({ where: eq(profiles.id, userId) });
  if (!member?.whatsapp_phone) throw new InvalidInputError("Add their number first.");
  const result = await send({
    to: member.whatsapp_phone,
    title: "Test from CapitUp LMS",
    body: `Hi ${member.full_name}, WhatsApp task alerts are working.`,
    taskId: 0,
  });
  if (!result.ok) throw new InvalidInputError(`WhatsApp said: ${result.error}`);
}
