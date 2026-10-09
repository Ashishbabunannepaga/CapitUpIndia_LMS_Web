import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveActor } from "../actor";
import { AccessDeniedError, InvalidInputError } from "../errors";
import {
  createFirstAdmin,
  createUser,
  listActiveAgents,
  listTeam,
  renameUser,
  resetPassword,
  setActive,
  setRole,
} from "../users";
import { PASSWORD, signIn, signInFrom, testWorld } from "./helpers";

// Sign-in, sessions and team accounts on D1. These replace the profile and
// auth cases in supabase/tests (access_control and edge_cases).

let world: Awaited<ReturnType<typeof testWorld>>;

beforeAll(async () => {
  world = await testWorld();
}, 60_000);

afterAll(async () => {
  await world?.dispose();
});

describe("signing in", () => {
  it("works with the right password and resolves the active user", async () => {
    const { response, headers } = await signIn(world.ctx, "amit@capitup.test");
    expect(response.status).toBe(200);
    const result = await resolveActor(world.ctx, headers);
    expect(result).toEqual({ status: "ok", actor: world.amit });
  });

  it("matches the email case-insensitively", async () => {
    const { response } = await signIn(world.ctx, "AMIT@CapitUp.test");
    expect(response.status).toBe(200);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const wrong = await signIn(world.ctx, "amit@capitup.test", "not-the-password");
    const unknown = await signIn(world.ctx, "nobody@capitup.test", "not-the-password");
    expect(wrong.response.status).toBe(401);
    expect(unknown.response.status).toBe(401);
    expect(await wrong.response.json()).toEqual(await unknown.response.json());
  });

  it("slows down password guessing from one address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const { response } = await signInFrom(world.ctx, "neha@capitup.test", `guess-${i}-xxxx`, "203.0.113.9");
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another address is unaffected.
    expect((await signIn(world.ctx, "neha@capitup.test")).response.status).toBe(200);
  });

  it("treats no cookie, a forged cookie and a signed-out session as signed out", async () => {
    expect(await resolveActor(world.ctx, new Headers())).toEqual({ status: "signed-out" });
    const forged = new Headers({ cookie: "better-auth.session_token=forged.value" });
    expect(await resolveActor(world.ctx, forged)).toEqual({ status: "signed-out" });

    const { headers } = await signIn(world.ctx, "amit@capitup.test");
    await world.ctx.auth.api.signOut({ headers });
    expect(await resolveActor(world.ctx, headers)).toEqual({ status: "signed-out" });
  });

  it("refuses a sign-in posted from another site", async () => {
    const response = await world.ctx.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example", cookie: "x=1" },
        body: JSON.stringify({ email: "amit@capitup.test", password: PASSWORD }),
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("has no public sign-up", async () => {
    const response = await world.ctx.auth.api.signUpEmail({
      body: { email: "intruder@capitup.test", password: "intruder-password", name: "Intruder" },
      asResponse: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await listTeam(world.ctx, world.admin)).toHaveLength(3);
  });
});

describe("deactivating someone", () => {
  it("cuts off a session that is still open and blocks new sign-ins from using the app", async () => {
    const { ctx, admin } = world;
    const temp = await createUser(ctx, admin, { email: "temp@capitup.test", fullName: "Temp", password: PASSWORD });
    const { headers } = await signIn(ctx, "temp@capitup.test");
    expect((await resolveActor(ctx, headers)).status).toBe("ok");

    await setActive(ctx, admin, temp.id, false);
    expect(await resolveActor(ctx, headers)).toEqual({ status: "signed-out" });

    // The password still works at the auth layer, but the app refuses them.
    const again = await signIn(ctx, "temp@capitup.test");
    expect(await resolveActor(ctx, again.headers)).toEqual({ status: "inactive" });

    await setActive(ctx, admin, temp.id, true);
    expect((await resolveActor(ctx, again.headers)).status).toBe("ok");
  });
});

describe("team accounts", () => {
  it("only admins create accounts", async () => {
    await expect(
      createUser(world.ctx, world.amit, { email: "x@capitup.test", fullName: "X", password: PASSWORD }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("rejects bad input with a plain message", async () => {
    const make = (input: object) => createUser(world.ctx, world.admin, { email: "y@capitup.test", fullName: "Y", password: PASSWORD, ...input });
    await expect(make({ email: "not-an-email" })).rejects.toThrow("Enter a valid email address.");
    await expect(make({ password: "short" })).rejects.toThrow("at least 8");
    await expect(make({ fullName: "   " })).rejects.toThrow("Enter a name.");
    await expect(make({ role: "OWNER" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(make({ email: "AMIT@capitup.test" })).rejects.toThrow("already uses that email");
  });

  it("stores emails lowercased and cuts long names to 120 characters", async () => {
    const member = await createUser(world.ctx, world.admin, {
      email: "  Long.Name@CapitUp.test ",
      fullName: "L".repeat(200),
      password: PASSWORD,
    });
    expect(member.email).toBe("long.name@capitup.test");
    expect(member.fullName).toHaveLength(120);
    expect((await signIn(world.ctx, "long.name@capitup.test")).response.status).toBe(200);
  });

  it("does not allow a second first admin", async () => {
    await expect(
      createFirstAdmin(world.ctx, { email: "sneaky@capitup.test", fullName: "Sneaky", password: PASSWORD }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("only admins change roles, status or passwords", async () => {
    const { ctx, amit, neha } = world;
    await expect(setRole(ctx, amit, amit.id, "ADMIN")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(setActive(ctx, amit, neha.id, false)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(resetPassword(ctx, amit, neha.id, "new-password-123")).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("lets users rename themselves but not others", async () => {
    const { ctx, amit, neha } = world;
    await renameUser(ctx, amit, amit.id, "  Amit Kumar  ");
    await expect(renameUser(ctx, amit, neha.id, "Hacked")).rejects.toBeInstanceOf(AccessDeniedError);
    const team = await listTeam(ctx, amit);
    expect(team.find((m) => m.id === amit.id)?.fullName).toBe("Amit Kumar");
    expect(team.find((m) => m.id === neha.id)?.fullName).toBe("Neha Agent");
  });

  it("resetting a password signs the user out and the new one works", async () => {
    const { ctx, admin, neha } = world;
    const { headers } = await signIn(ctx, "neha@capitup.test");
    await resetPassword(ctx, admin, neha.id, "brand-new-password");
    expect(await resolveActor(ctx, headers)).toEqual({ status: "signed-out" });
    expect((await signIn(ctx, "neha@capitup.test")).response.status).toBe(401);
    expect((await signIn(ctx, "neha@capitup.test", "brand-new-password")).response.status).toBe(200);
    await resetPassword(ctx, admin, neha.id, PASSWORD);
  });

  it("always keeps an active admin", async () => {
    const { ctx, admin } = world;
    await expect(setRole(ctx, admin, admin.id, "AGENT")).rejects.toThrow("Keep at least one active admin.");
    await expect(setActive(ctx, admin, admin.id, false)).rejects.toThrow("Keep at least one active admin.");
  });

  it("lists active agents for assignment", async () => {
    const agents = await listActiveAgents(world.ctx, world.amit);
    expect(agents.map((a) => a.fullName)).toContain("Neha Agent");
    expect(agents.map((a) => a.fullName)).not.toContain("Asha Admin");
  });

  it("reports an unknown team member plainly", async () => {
    await expect(setActive(world.ctx, world.admin, "missing", false)).rejects.toThrow("does not exist");
  });
});
