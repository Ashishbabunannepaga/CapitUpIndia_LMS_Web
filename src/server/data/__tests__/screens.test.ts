import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hashPassword as hashScrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";

import { addDays, businessDateTimeToIso, todayInBusinessTz } from "@/lib/dates";

import { authAccount } from "../../db/schema";
import { resolveActor } from "../actor";
import { AccessDeniedError } from "../errors";
import { createTask, listCalendarEvents, setEventDone } from "../events";
import { addLeadNote, createLead, listDuplicateGroups } from "../leads";
import { changeStamp } from "../changes";
import { myDay } from "../my-day";
import { shellSummary } from "../shell";
import { signInWithPassword, signOutSession } from "../sessions";
import { setActive } from "../users";
import { PASSWORD, testWorld } from "./helpers";

// The loaders behind My Day and the duplicates screen, and the login form's
// sign-in and sign-out.

let w: Awaited<ReturnType<typeof testWorld>>;
let ip = 0;
const from = () => ({ origin: "http://localhost:3000", ip: `10.1.0.${++ip}` });

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

describe("My Day", () => {
  const today = todayInBusinessTz();

  beforeAll(async () => {
    await createLead(w.ctx, w.amit, { client_name: "Day Due Soon", renewal_date: addDays(today, 3), status: "Quoted" });
    await createLead(w.ctx, w.amit, { client_name: "Day Overdue", renewal_date: addDays(today, -2), status: "Follow-up" });
    // Closed Lost renewals are no longer chased; Closed Won is an active client whose renewal still is.
    await createLead(w.ctx, w.amit, { client_name: "Day Lost", renewal_date: addDays(today, 2), status: "Closed Lost" });
    await createLead(w.ctx, w.amit, { client_name: "Day Won", renewal_date: addDays(today, 2), status: "Closed Won" });
    await createLead(w.ctx, w.neha, { client_name: "Day Neha", renewal_date: addDays(today, 4), status: "Closed Won" });
    await createLead(w.ctx, w.admin, { client_name: "Day Nobody" });
    const neha = await createLead(w.ctx, w.admin, { client_name: "Day Shared", assigned_agent_id: w.amit.id });
    await addLeadNote(w.ctx, w.admin, neha, "Admin looked at this");

    await createTask(w.ctx, w.amit, { title: "Call today", event_timestamp: businessDateTimeToIso(today, "11:00") });
    await createTask(w.ctx, w.amit, { title: "Call next month", event_timestamp: businessDateTimeToIso(addDays(today, 20), "11:00") });
    const done = await createTask(w.ctx, w.amit, { title: "Done today", event_timestamp: businessDateTimeToIso(today, "09:00") });
    await setEventDone(w.ctx, w.amit, done.id, true);
    await createTask(w.ctx, w.neha, { title: "Neha's task", event_timestamp: businessDateTimeToIso(today, "11:00") });
  });

  it("an agent sees only their own leads, tasks and notes", async () => {
    const day = await myDay(w.ctx, w.amit);
    expect(day.counts).toEqual({ activeClients: 1, quoted: 1, followUps: 1, overdueRenewals: 1, stale: 0 });
    expect(day.renewals.map((l) => l.client_name)).toEqual(["Day Won", "Day Due Soon"]);
    expect(day.overdueRenewals.map((l) => l.client_name)).toEqual(["Day Overdue"]);
    // The week ahead: tasks and renewal due dates; earlier milestones are background reminders.
    const titles = day.openTasks.map((e) => e.title);
    expect(titles).toContain("Call today");
    expect(titles).toContain("Renewal due: Day Due Soon");
    expect(titles).not.toContain("Call next month");
    expect(titles.filter((t) => !t.startsWith("Renewal due") && t !== "Call today")).toEqual([]);
    expect(day.openTasks.every((e) => e.assigned_agent_id === w.amit.id && !e.is_background_reminder)).toBe(true);
    expect(day.doneToday.map((e) => e.title)).toEqual(["Done today"]);
    expect(day.recentlyAssigned.map((l) => l.client_name)).toContain("Day Shared");
    expect(day.recentlyAssigned.every((l) => l.assigned_agent_id === w.amit.id)).toBe(true);
    expect(day.unassigned).toBeNull();
    expect(day.unreadNotes.map((n) => n.content)).toEqual(["Admin looked at this"]);
    expect(day.unreadNoteCount).toBe(1);
  });

  it("the app frame's badge, bell and change stamp come from one batch", async () => {
    const amit = await shellSummary(w.ctx, w.amit);
    expect(amit).toMatchObject({ stamp: await changeStamp(w.ctx, w.amit), unreadNotes: 1, unreadNotifications: 1 });
    // Asha gave Amit "Day Shared": that is in his bell.
    expect(amit.notifications.map((n) => [n.kind, n.title])).toEqual([["other", "New lead assigned: Day Shared"]]);
    expect(amit.stamp).toBeGreaterThan(0);
    // Unread notes are scoped like the leads: Neha has none on Amit's lead.
    expect((await shellSummary(w.ctx, w.neha)).unreadNotes).toBe(0);
  });

  it("an admin sees every lead, the unassigned queue and only their own tasks", async () => {
    const day = await myDay(w.ctx, w.admin);
    expect(day.counts.activeClients).toBe(2);
    expect(day.renewals.map((l) => l.client_name)).toEqual(["Day Won", "Day Due Soon", "Day Neha"]);
    expect(day.openTasks).toEqual([]);
    expect(day.unassigned?.count).toBe(1);
    expect(day.unassigned?.leads.map((l) => l.client_name)).toEqual(["Day Nobody"]);
    expect(day.recentlyAssigned.map((l) => l.client_name)).not.toContain("Day Nobody");
  });
});

describe("calendar colours", () => {
  const today = todayInBusinessTz();
  const range = { from: businessDateTimeToIso(addDays(today, -1), "00:00"), to: businessDateTimeToIso(addDays(today, 40), "23:59") };

  beforeAll(async () => {
    await createLead(w.ctx, w.amit, { client_name: "Cal Corporate", renewal_date: addDays(today, 30), policy_product: "Health" });
    await createLead(w.ctx, w.amit, { client_name: "Cal Motor", renewal_date: addDays(today, 31), policy_product: "Motor" });
    await createLead(w.ctx, w.amit, {
      client_name: "Cal Retail Active",
      renewal_date: addDays(today, 32),
      business_type: "Retail",
      policy_product: "Health",
      status: "Closed Won",
    });
    const active = await createLead(w.ctx, w.amit, { client_name: "Cal Active", status: "Closed Won" });
    await createTask(w.ctx, w.amit, { title: "Cal visit", event_timestamp: businessDateTimeToIso(addDays(today, 33), "11:00"), lead_id: active });
    await createTask(w.ctx, w.amit, { title: "Cal plain task", event_timestamp: businessDateTimeToIso(addDays(today, 34), "11:00") });
    await createTask(w.ctx, w.neha, { title: "Cal Neha task", event_timestamp: businessDateTimeToIso(addDays(today, 34), "12:00") });
  });

  it("each entry gets the Android app's colours, and agents still see only their own", async () => {
    const events = await listCalendarEvents(w.ctx, w.amit, range);
    const byTitle = new Map(events.map((e) => [e.title, e.categories]));
    expect(byTitle.get("Renewal due: Cal Corporate (Health)")).toEqual(["gmc_renewal"]);
    expect(byTitle.get("Renewal due: Cal Motor (Motor)")).toEqual(["retail_renewal"]);
    expect(byTitle.get("Renewal due: Cal Retail Active (Health)")).toEqual(["active_client"]);
    expect(byTitle.get("Cal visit")).toEqual(["active_client"]);
    expect(byTitle.get("Cal plain task")).toEqual(["task"]);
    expect(byTitle.has("Cal Neha task")).toBe(false);
    expect(events.every((e) => e.assigned_agent_id === w.amit.id && !e.is_background_reminder)).toBe(true);

    const all = await listCalendarEvents(w.ctx, w.admin, range);
    expect(all.map((e) => e.title)).toContain("Cal Neha task");
  });
});

describe("duplicates screen", () => {
  it("lists every record of each flagged company, for admins only", async () => {
    await createLead(w.ctx, w.neha, { client_name: "Twin Traders" });
    await createLead(w.ctx, w.amit, { client_name: "Twin Traders Pvt Ltd" });
    await createLead(w.ctx, w.amit, { client_name: "Single Co" });
    const groups = await listDuplicateGroups(w.ctx, w.admin);
    expect(groups.map((l) => [l.client_name, l.is_duplicate])).toEqual([
      ["Twin Traders", false],
      ["Twin Traders Pvt Ltd", true],
    ]);
    await expect(listDuplicateGroups(w.ctx, w.amit)).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe("login form sign-in", () => {
  it("stores new passwords as low-memory PBKDF2 and upgrades older scrypt ones on sign-in", async () => {
    const account = () =>
      w.ctx.db.query.authAccount.findFirst({ where: eq(authAccount.userId, w.neha.id) });
    expect((await account())?.password).toMatch(/^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);

    // An account from before the switch still holds a scrypt hash.
    await w.ctx.db
      .update(authAccount)
      .set({ password: await hashScrypt(PASSWORD) })
      .where(eq(authAccount.userId, w.neha.id));
    expect(await signInWithPassword(w.ctx, { email: "neha@capitup.test", password: "wrong-password" }, from())).toEqual({
      status: "invalid",
    });
    expect((await account())?.password).not.toMatch(/^pbkdf2/);

    expect((await signInWithPassword(w.ctx, { email: "neha@capitup.test", password: PASSWORD }, from())).status).toBe("ok");
    expect((await account())?.password).toMatch(/^pbkdf2-sha256\$/);
    expect((await signInWithPassword(w.ctx, { email: "neha@capitup.test", password: PASSWORD }, from())).status).toBe("ok");
  });

  it("starts a session that resolves to the user", async () => {
    const result = await signInWithPassword(w.ctx, { email: "amit@capitup.test", password: PASSWORD }, from());
    expect(result.status).toBe("ok");
    const cookie = result.status === "ok" ? result.setCookies.map((c) => c.split(";")[0]).join("; ") : "";
    const who = await resolveActor(w.ctx, new Headers({ cookie }));
    expect(who).toMatchObject({ status: "ok", actor: { id: w.amit.id } });

    // Signing out clears the cookie and kills the session server-side.
    const cleared = await signOutSession(w.ctx, cookie, from());
    expect(cleared.join(";")).toMatch(/Max-Age=0/i);
    expect((await resolveActor(w.ctx, new Headers({ cookie }))).status).toBe("signed-out");
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    expect(await signInWithPassword(w.ctx, { email: "amit@capitup.test", password: "wrong-password" }, from())).toEqual({
      status: "invalid",
    });
    expect(await signInWithPassword(w.ctx, { email: "nobody@capitup.test", password: PASSWORD }, from())).toEqual({
      status: "invalid",
    });
  });

  it("refuses a deactivated account without leaving a session behind", async () => {
    await setActive(w.ctx, w.admin, w.neha.id, false);
    try {
      expect(await signInWithPassword(w.ctx, { email: "neha@capitup.test", password: PASSWORD }, from())).toEqual({
        status: "inactive",
      });
      const sessions = await w.d1.prepare(`select count(*) as n from session where user_id = ?`).bind(w.neha.id).first<{ n: number }>();
      expect(sessions?.n).toBe(0);
    } finally {
      await setActive(w.ctx, w.admin, w.neha.id, true);
    }
  });

  it("is rate limited per address", async () => {
    const same = from();
    for (let i = 0; i < 5; i++) {
      await signInWithPassword(w.ctx, { email: "amit@capitup.test", password: "wrong-password" }, same);
    }
    expect(await signInWithPassword(w.ctx, { email: "amit@capitup.test", password: PASSWORD }, same)).toEqual({
      status: "rate-limited",
    });
    expect((await signInWithPassword(w.ctx, { email: "amit@capitup.test", password: PASSWORD }, from())).status).toBe("ok");
  });
});
