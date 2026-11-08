import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { eq, like } from "drizzle-orm";

import { notifications, profiles, signInFailures } from "../../db/schema";
import { resolveActor } from "../actor";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { handleAuthRequest, signInWithPassword, type RequestInfo } from "../sessions";
import { ALERT_PER_EMAIL, ALERT_PER_IP, recentSignInFailures, recordSignInFailure } from "../sign-in-failures";
import { changeOwnPassword, createUser, resetPassword, setActive } from "../users";
import { PASSWORD, signIn, testWorld } from "./helpers";

// Failed sign-in logging and alerts, and the forced password change after an
// admin sets someone's password.

let world: Awaited<ReturnType<typeof testWorld>>;
let address = 0;

beforeAll(async () => {
  world = await testWorld();
}, 60_000);

afterAll(async () => {
  await world?.dispose();
});

function from(ip = `10.9.0.${++address % 250}`): RequestInfo {
  return { origin: "http://localhost:3000", ip, userAgent: "vitest" };
}

async function failuresFor(email: string) {
  return world.ctx.db.select().from(signInFailures).where(eq(signInFailures.email, email));
}

async function alertsMatching(pattern: string) {
  return world.ctx.db.select().from(notifications).where(like(notifications.title, pattern));
}

describe("failed sign-ins", () => {
  it("records a wrong password with the address it came from", async () => {
    const result = await signInWithPassword(world.ctx, { email: "neha@capitup.test", password: "wrong-password" }, from("10.1.1.1"));
    expect(result).toEqual({ status: "invalid" });
    const rows = await failuresFor("neha@capitup.test");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "invalid", ip: "10.1.1.1", user_agent: "vitest" });
  });

  it("records unknown emails too, lowercased", async () => {
    await signInWithPassword(world.ctx, { email: "Nobody@Capitup.test", password: "whatever-1" }, from());
    expect(await failuresFor("nobody@capitup.test")).toHaveLength(1);
  });

  it("does not record a successful sign-in", async () => {
    const result = await signInWithPassword(world.ctx, { email: "amit@capitup.test", password: PASSWORD }, from());
    expect(result.status).toBe("ok");
    expect(await failuresFor("amit@capitup.test")).toHaveLength(0);
  });

  it("alerts every active admin once when one account reaches the threshold", async () => {
    const target = "guessed@capitup.test";
    for (let i = 0; i < ALERT_PER_EMAIL + 2; i++) {
      await signInWithPassword(world.ctx, { email: target, password: `guess-${i}-xx` }, from());
    }
    const alerts = await alertsMatching(`%failed sign-ins for ${target}`);
    // One admin (Asha) in the test world, one alert for the whole burst.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ user_id: world.admin.id, kind: "other" });
    expect(alerts[0].read_at).toBeNull();
  });

  it("alerts when one address tries many accounts", async () => {
    const at = new Date();
    for (let i = 0; i < ALERT_PER_IP; i++) {
      await recordSignInFailure(world.ctx, { email: `spray${i}@capitup.test`, ip: "10.66.0.1", userAgent: null, reason: "invalid" }, at);
    }
    expect(await alertsMatching("%from 10.66.0.1")).toHaveLength(1);
  });

  it("does not count failures older than the window", async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    for (let i = 0; i < ALERT_PER_EMAIL - 1; i++) {
      await recordSignInFailure(world.ctx, { email: "slow@capitup.test", ip: null, userAgent: null, reason: "invalid" }, old);
    }
    await recordSignInFailure(world.ctx, { email: "slow@capitup.test", ip: null, userAgent: null, reason: "invalid" });
    expect(await alertsMatching("%for slow@capitup.test")).toHaveLength(0);
  });

  it("records a disabled account's sign-in as inactive", async () => {
    const temp = await createUser(world.ctx, world.admin, { email: "gone@capitup.test", fullName: "Gone Agent", password: PASSWORD });
    await setActive(world.ctx, world.admin, temp.id, false);
    const result = await signInWithPassword(world.ctx, { email: "gone@capitup.test", password: PASSWORD }, from());
    expect(result).toEqual({ status: "inactive" });
    expect((await failuresFor("gone@capitup.test")).map((r) => r.reason)).toEqual(["inactive"]);
  });

  it("logs but does not store attempts the rate limit blocked", async () => {
    const ip = "10.77.0.1";
    const results = [];
    for (let i = 0; i < 7; i++) {
      results.push((await signInWithPassword(world.ctx, { email: "flood@capitup.test", password: `flood-${i}-x` }, from(ip))).status);
    }
    expect(results).toContain("rate-limited");
    const stored = await failuresFor("flood@capitup.test");
    expect(stored.length).toBe(results.filter((s) => s === "invalid").length);
  });

  it("records failures sent straight to the sign-in API, skipping the login form", async () => {
    const response = await handleAuthRequest(
      world.ctx,
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", "cf-connecting-ip": "10.88.0.1" },
        body: JSON.stringify({ email: "script@capitup.test", password: "not-it-123" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await failuresFor("script@capitup.test")).toMatchObject([{ reason: "invalid", ip: "10.88.0.1" }]);
  });

  it("shows the list to admins only", async () => {
    const rows = await recentSignInFailures(world.ctx, world.admin);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].created_at >= rows[rows.length - 1].created_at).toBe(true);
    await expect(recentSignInFailures(world.ctx, world.amit)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("deletes rows older than 90 days as new ones arrive", async () => {
    await world.ctx.db
      .insert(signInFailures)
      .values({ email: "ancient@capitup.test", reason: "invalid", created_at: "2020-01-01T00:00:00.000Z" });
    await recordSignInFailure(world.ctx, { email: "fresh@capitup.test", ip: null, userAgent: null, reason: "invalid" });
    expect(await failuresFor("ancient@capitup.test")).toHaveLength(0);
  });
});

describe("passwords an admin set", () => {
  it("must be changed: new accounts and resets are flagged, the first admin is not", async () => {
    expect(world.admin.must_change_password).toBe(false);
    expect(world.amit.must_change_password).toBe(true);

    const kiran = await createUser(world.ctx, world.admin, { email: "kiran@capitup.test", fullName: "Kiran", password: PASSWORD });
    await world.ctx.db.update(profiles).set({ must_change_password: false }).where(eq(profiles.id, kiran.id));
    await resetPassword(world.ctx, world.admin, kiran.id, "temporary-pass-1");
    const after = await world.ctx.db.query.profiles.findFirst({ where: eq(profiles.id, kiran.id) });
    expect(after?.must_change_password).toBe(true);
  });

  it("is replaced by the user, which clears the flag, keeps this session and ends the others", async () => {
    const ravi = await createUser(world.ctx, world.admin, { email: "ravi@capitup.test", fullName: "Ravi", password: PASSWORD });
    const here = await signIn(world.ctx, "ravi@capitup.test");
    const elsewhere = await signIn(world.ctx, "ravi@capitup.test");
    const session = await world.ctx.auth.api.getSession({ headers: here.headers });
    const actor = (await resolveActor(world.ctx, here.headers)) as { status: "ok"; actor: typeof ravi };
    expect(actor.actor.must_change_password).toBe(true);

    await changeOwnPassword(world.ctx, actor.actor, { currentPassword: PASSWORD, newPassword: "ravi-own-secret-9" }, session!.session.token);

    const updated = await world.ctx.db.query.profiles.findFirst({ where: eq(profiles.id, ravi.id) });
    expect(updated?.must_change_password).toBe(false);
    expect((await resolveActor(world.ctx, here.headers)).status).toBe("ok");
    expect((await resolveActor(world.ctx, elsewhere.headers)).status).toBe("signed-out");
    expect((await signIn(world.ctx, "ravi@capitup.test", PASSWORD)).response.status).toBe(401);
    expect((await signIn(world.ctx, "ravi@capitup.test", "ravi-own-secret-9")).response.status).toBe(200);
  });

  it("needs the current password and a different new one", async () => {
    const sita = await createUser(world.ctx, world.admin, { email: "sita@capitup.test", fullName: "Sita", password: PASSWORD });
    await expect(
      changeOwnPassword(world.ctx, sita, { currentPassword: "not-the-password", newPassword: "something-new-1" }, null),
    ).rejects.toThrow("Your current password is not right.");
    await expect(changeOwnPassword(world.ctx, sita, { currentPassword: PASSWORD, newPassword: PASSWORD }, null)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(changeOwnPassword(world.ctx, sita, { currentPassword: PASSWORD, newPassword: "short" }, null)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    const unchanged = await world.ctx.db.query.profiles.findFirst({ where: eq(profiles.id, sita.id) });
    expect(unchanged?.must_change_password).toBe(true);
  });
});
