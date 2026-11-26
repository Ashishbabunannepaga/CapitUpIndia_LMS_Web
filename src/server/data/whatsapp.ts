import "server-only";

import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { isIsoDate } from "@/lib/dates";
import { dueDateToIso } from "@/lib/work-tasks";

import { appSettings, notifications, profiles, whatsappInbound, workTasks } from "../db/schema";
import type { WhatsAppSender } from "../whatsapp/client";
import { assertAdmin, type Actor } from "./actor";
import { auditInsert } from "./audit";
import type { DataContext } from "./context";
import { planFacts } from "./day-plan";
import { InvalidInputError } from "./errors";
import {
  type AudioExt,
  createWorkTask,
  discardTaskVoice,
  MESSAGE_MAX,
  postTaskMessage,
  setWorkTaskStatus,
  sniffAudio,
  snoozeWorkTask,
  storeTaskVoice,
  taskRecipients,
  VOICE_MAX_MS,
} from "./work-tasks";

// WhatsApp task alerts for the team. An admin turns them on per person with
// their number (Admin > WhatsApp). The per-minute cron sends the important
// Task Grid bell notifications (due soon, due now, overdue, escalations, new
// tasks, approvals, renewal steps) to WhatsApp with Done and Snooze 1h
// buttons. Messages back come through the webhook (src/app/api/whatsapp) and
// act as that person, under the same rules as the app: buttons, replies and
// voice notes into task chats, new tasks, and questions for the copilot.
// People outside the team are passed to the older app or get the admins'
// auto-reply.

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

export type WhatsAppReply = {
  from: string;
  /** Meta's message id (wamid); used to drop retried deliveries. */
  id?: string;
  payload?: string;
  text?: string;
  /** The message this one swipe-replies to. */
  contextId?: string;
  /** A voice note's media id. */
  audioId?: string;
};

/** A task the copilot drafted from a message. */
export type WhatsAppTaskDraft = { title: string; description: string; assignee_id: string; priority: string; due_date: string; tags: string[] };

/**
 * The parts that call outside services, passed in by the webhook so tests can
 * use fakes: AI answers and drafts, the voice-note download and transcription.
 * Each may throw an Error whose message is safe to show the person.
 */
export type WhatsAppHelpers = {
  ask?: (person: Actor, question: string, facts: string) => Promise<string>;
  drafts?: (person: Actor, request: string) => Promise<WhatsAppTaskDraft[]>;
  fetchAudio?: (mediaId: string) => Promise<Uint8Array>;
  transcribe?: (person: Actor, audio: { bytes: Uint8Array; mime: string; ext: string; ms: number }) => Promise<string>;
};

export const WHATSAPP_HELP = [
  "CapitUp LMS on WhatsApp:",
  "- Tap Done or Snooze 1h on a task alert.",
  "- Swipe to reply on an alert to post in that task's chat. Text or a voice note both work.",
  '- Start with "todo:" to add your own task, or a name to give one, like "Sravani: send the GMC quote by Friday".',
  '- Ask anything else, like "what is overdue?" or "my renewals this week".',
  "- Send a voice note to do any of these by voice.",
].join("\n");

const DONE_WORDS = /^(done|completed?|finished)\b/;
const SNOOZE_WORDS = /^(snooze|later|on it)\b/;
const CREATE_WORDS = /^(todo|to-do|to do|task|new task|remind me|assign)\b/;
const HELP_WORDS = /^(help|hi|hii+|hello|hey|menu|start|\?)\W*$/;
/** Roughly how long a WhatsApp voice note is (Opus at about 16 kbit/s); only used for AI usage logs. */
const VOICE_BYTES_PER_SECOND = 2_000;

const dayMonth = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** Records a delivery as handled. False when it was already handled (Meta retried it). */
export async function claimWhatsAppInbound(ctx: DataContext, id: string, at: Date = new Date()): Promise<boolean> {
  const rows = await ctx.db.insert(whatsappInbound).values({ id: id.slice(0, 200), created_at: at.toISOString() }).onConflictDoNothing().returning({ id: whatsappInbound.id });
  if (rows.length) await ctx.db.delete(whatsappInbound).where(lt(whatsappInbound.created_at, new Date(at.getTime() - 3 * 24 * 60 * 60_000).toISOString()));
  return rows.length > 0;
}

/** The active team member with WhatsApp on for this number, if any. */
export async function whatsAppTeamMember(ctx: DataContext, from: string): Promise<Actor | null> {
  const digits = from.replace(/\D/g, "");
  if (!digits) return null;
  const person = await ctx.db.query.profiles.findFirst({
    where: and(eq(profiles.whatsapp_phone, digits), eq(profiles.whatsapp_on, true), eq(profiles.is_active, true)),
  });
  return person ?? null;
}

/**
 * A message from a team member on WhatsApp. It acts as the person whose
 * number it came from, with the same checks as the app:
 * - Done / Snooze (buttons or words, on an alert) close or pause the task;
 * - any other reply to an alert, typed or spoken, goes into that task's chat;
 * - "todo: ..." or "Name: ..." creates tasks;
 * - anything else is a question for the copilot, answered from what they can see.
 * Returns the answer to send back, or null for a number we don't know.
 */
export async function handleWhatsAppReply(ctx: DataContext, reply: WhatsAppReply, helpers: WhatsAppHelpers = {}, at: Date = new Date()): Promise<string | null> {
  const person = await whatsAppTeamMember(ctx, reply.from);
  if (!person) return null;

  const button = /^(done|snooze):(\d{1,12})$/.exec(reply.payload ?? "");
  if (button) {
    const taskId = Number(button[2]);
    if (taskId === 0) return "That was the test message, so there is no task behind it. The buttons work: on a real alert they close or snooze the task.";
    return act(ctx, person, button[1] as "done" | "snooze", taskId, at);
  }

  const notice = reply.contextId
    ? await ctx.db.query.notifications.findFirst({ where: and(eq(notifications.whatsapp_msg_id, reply.contextId), eq(notifications.user_id, person.id)) })
    : undefined;
  const taskId = notice?.task_id ?? null;

  let text = (reply.text ?? reply.payload ?? "").trim();
  let voice: { bytes: Uint8Array; mime: string; ext: AudioExt; ms: number } | null = null;
  if (reply.audioId) {
    if (!helpers.fetchAudio || !helpers.transcribe) return "Voice notes aren't switched on yet. Type your message instead.";
    let bytes: Uint8Array;
    try {
      bytes = await helpers.fetchAudio(reply.audioId);
    } catch {
      return "I couldn't download that voice note. Try again, or type it.";
    }
    const type = sniffAudio(bytes);
    if (!type) return "I couldn't read that voice note. Try again, or type it.";
    voice = { bytes, ...type, ms: Math.min(VOICE_MAX_MS, Math.round((bytes.byteLength / VOICE_BYTES_PER_SECOND) * 1000)) };
    try {
      text = (await helpers.transcribe(person, voice)).trim();
    } catch (error) {
      // On a task, keep the recording in the chat even without a transcript.
      if (!taskId) return error instanceof Error && error.message ? error.message : "The voice note couldn't be transcribed.";
      text = "";
    }
  }
  const lower = text.toLowerCase();

  if (!voice && (!text || HELP_WORDS.test(lower))) return WHATSAPP_HELP;

  const command = DONE_WORDS.test(lower) ? "done" : SNOOZE_WORDS.test(lower) ? "snooze" : null;
  if (command && lower.split(/\s+/).length <= 4) {
    if (!taskId) return "Swipe to reply on the task alert itself, so I know which task you mean.";
    return act(ctx, person, command, taskId, at);
  }

  if (taskId) return postToTask(ctx, person, taskId, text, voice);

  if (!text) return WHATSAPP_HELP;
  if (await wantsNewTask(ctx, person, text)) return createFromMessage(ctx, person, text, helpers);
  if (!helpers.ask) return WHATSAPP_HELP;
  try {
    const { facts } = await planFacts(ctx, person, at);
    return await helpers.ask(person, text, facts);
  } catch (error) {
    return error instanceof Error && error.message ? error.message : "I couldn't answer that just now. Try again, or open the LMS.";
  }
}

async function act(ctx: DataContext, person: Actor, action: "done" | "snooze", taskId: number, at: Date): Promise<string> {
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

async function postToTask(
  ctx: DataContext,
  person: Actor,
  taskId: number,
  text: string,
  voice: { bytes: Uint8Array; ms: number } | null,
): Promise<string> {
  let key: string | null = null;
  try {
    const task = await ctx.db.query.workTasks.findFirst({ where: eq(workTasks.id, taskId) });
    if (voice) key = (await storeTaskVoice(ctx, person, taskId, voice.bytes)).key;
    const seconds = Math.round((voice?.ms ?? 0) / 1000);
    const body = text || `Voice note (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})`;
    await postTaskMessage(ctx, person, taskId, { body: body.slice(0, MESSAGE_MAX), via: voice ? "voice" : "text", audio: key && voice ? { key, ms: voice.ms } : null });
    return `Added to the chat on "${task?.title ?? "the task"}".`;
  } catch (error) {
    if (key) await discardTaskVoice(ctx, key);
    return error instanceof Error && error.message ? error.message : "That didn't reach the task. Open it in the LMS.";
  }
}

/** "todo: ...", "remind me ...", or a message that starts with a teammate's name and a colon. */
async function wantsNewTask(ctx: DataContext, person: Actor, text: string): Promise<boolean> {
  const lower = text.toLowerCase();
  if (CREATE_WORDS.test(lower)) return true;
  const lead = /^([a-z][a-z .]{1,40}?)\s*[:,-]\s+\S/.exec(lower);
  if (!lead) return false;
  const name = lead[1].trim();
  const team = await taskRecipients(ctx, person);
  return team.some((m) => {
    const full = m.full_name.toLowerCase();
    return full === name || full.split(/\s+/)[0] === name;
  });
}

async function createFromMessage(ctx: DataContext, person: Actor, text: string, helpers: WhatsAppHelpers): Promise<string> {
  if (!helpers.drafts) return "Creating tasks from WhatsApp isn't switched on yet. Add it in the LMS.";
  let drafts: WhatsAppTaskDraft[];
  try {
    drafts = await helpers.drafts(person, text);
  } catch (error) {
    return error instanceof Error && error.message ? error.message : "I couldn't read a task in that. Try again, or add it in the LMS.";
  }
  if (!drafts.length) return 'I couldn\'t find a task in that. Try "Sravani: send the GMC quote by Friday".';
  const team = new Map((await taskRecipients(ctx, person)).map((m) => [m.id, m.full_name]));
  const made: string[] = [];
  const failed: string[] = [];
  for (const d of drafts.slice(0, 5)) {
    try {
      const task = await createWorkTask(ctx, person, {
        title: d.title,
        description: d.description,
        priority: d.priority,
        due_at: isIsoDate(d.due_date) ? dueDateToIso(d.due_date) : null,
        assignee_id: d.assignee_id || person.id,
        tags: d.tags,
      });
      const who = task.assignee_id === person.id ? "for you" : `for ${team.get(task.assignee_id) ?? "them"}`;
      made.push(`- "${task.title}" ${who}${task.due_at ? `, due ${dayMonth.format(new Date(task.due_at))}` : ""}`);
    } catch (error) {
      failed.push(`- "${d.title}": ${error instanceof Error ? error.message : "not saved"}`);
    }
  }
  return [
    made.length ? `Created ${made.length === 1 ? "1 task" : `${made.length} tasks`}:` : "",
    ...made,
    failed.length ? "Not created:" : "",
    ...failed,
    made.length ? "Open the LMS to change anything." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const CLIENT_REPLY_SETTING = "whatsapp_client_reply";
export const CLIENT_REPLY_MAX = 1000;

/** The auto-reply for people outside the team ("" when off). */
export async function getWhatsAppClientReply(ctx: DataContext): Promise<string> {
  const row = await ctx.db.query.appSettings.findFirst({ where: eq(appSettings.key, CLIENT_REPLY_SETTING) });
  return typeof row?.value === "string" ? row.value : "";
}

/** Admins set (or clear) the auto-reply for people outside the team. */
export async function setWhatsAppClientReply(ctx: DataContext, actor: Actor, text: string): Promise<void> {
  assertAdmin(actor);
  const value = text.trim();
  if (value.length > CLIENT_REPLY_MAX) throw new InvalidInputError("Keep the reply under 1,000 characters.");
  const before = await getWhatsAppClientReply(ctx);
  const stamp = new Date().toISOString();
  await ctx.db.batch([
    ctx.db
      .insert(appSettings)
      .values({ key: CLIENT_REPLY_SETTING, value, description: "WhatsApp auto-reply for people outside the team (empty = off).", updated_at: stamp, updated_by: actor.id })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updated_at: stamp, updated_by: actor.id } }),
    auditInsert(ctx, actor, "app_settings", CLIENT_REPLY_SETTING, "UPDATE", { value: before }, { value }),
  ]);
}

/**
 * What to send someone outside the team who writes to the number: the
 * admins' auto-reply, at most once a day per number, or null.
 */
export async function clientAutoReply(ctx: DataContext, from: string, at: Date = new Date()): Promise<string | null> {
  const digits = from.replace(/\D/g, "");
  if (!digits) return null;
  const text = await getWhatsAppClientReply(ctx);
  if (!text) return null;
  const day = at.toISOString().slice(0, 10);
  return (await claimWhatsAppInbound(ctx, `client-reply:${digits}:${day}`, at)) ? text : null;
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
