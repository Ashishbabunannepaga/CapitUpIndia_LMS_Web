import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";

vi.mock("server-only", () => ({}));

import { auditLogs } from "../../db/schema";
import { resolveActor } from "../actor";
import { AccessDeniedError } from "../errors";
import { confirmTwoFactorSetup, signInWithPassword, startTwoFactorSetup, verifyTwoFactorSignIn, type RequestInfo } from "../sessions";
import { createUser, hasTwoFactor, listTwoFactorUsers, resetTwoFactor, twoFactorRequired } from "../users";
import { PASSWORD, signIn, testWorld } from "./helpers";

// Audit R11: admins sign in with a password and a code from an authenticator
// app; a backup code works once; another admin can reset it after a lost phone.

let w: Awaited<ReturnType<typeof testWorld>>;
let address = 0;

beforeAll(async () => {
  w = await testWorld();
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

const from = (): RequestInfo => ({ origin: "http://localhost:3000", ip: `10.42.0.${++address % 250}`, userAgent: "vitest" });
const cookieOf = (setCookies: string[]) => setCookies.map((c) => c.split(";")[0]).join("; ");
const codeFor = (uri: string) => {
  const raw = new TextDecoder().decode(base32.decode(new URL(uri).searchParams.get("secret")!));
  return createOTP(raw).totp();
};

/** Signs in with the password and switches two-step sign-in on. Returns the authenticator link and backup codes. */
async function enrol(email: string) {
  const { headers } = await signIn(w.ctx, email);
  const cookie = headers.get("cookie")!;
  expect(await startTwoFactorSetup(w.ctx, { password: "wrong-password", cookie }, from())).toBeNull();
  const setup = (await startTwoFactorSetup(w.ctx, { password: PASSWORD, cookie }, from()))!;
  expect(setup.backupCodes).toHaveLength(10);
  expect(setup.secret.length).toBeGreaterThan(20);
  expect(await confirmTwoFactorSetup(w.ctx, { code: "000000", cookie }, from())).toEqual({ status: "invalid" });
  const confirmed = await confirmTwoFactorSetup(w.ctx, { code: await codeFor(setup.totpURI), cookie }, from());
  expect(confirmed.status).toBe("ok");
  return setup;
}

describe("two-step sign-in", () => {
  it("is required for admins only", () => {
    expect(twoFactorRequired(w.admin)).toBe(true);
    expect(twoFactorRequired(w.amit)).toBe(false);
  });

  it("asks for a code after the password once it is on, and the code opens the session", async () => {
    expect(await hasTwoFactor(w.ctx, w.admin.id)).toBe(false);
    const setup = await enrol("asha@capitup.test");
    expect(await hasTwoFactor(w.ctx, w.admin.id)).toBe(true);
    expect(await listTwoFactorUsers(w.ctx, w.admin)).toEqual(new Set([w.admin.id]));

    const first = await signInWithPassword(w.ctx, { email: "asha@capitup.test", password: PASSWORD }, from());
    expect(first.status).toBe("two-factor");
    const challenge = cookieOf(first.status === "two-factor" ? first.setCookies : []);
    // The password step alone gives no session.
    expect(await resolveActor(w.ctx, new Headers({ cookie: challenge }))).toEqual({ status: "signed-out" });

    const wrong = await verifyTwoFactorSignIn(w.ctx, { code: "123456", kind: "totp", trustDevice: false, cookie: challenge }, from());
    expect(wrong).toEqual({ status: "invalid" });
    const right = await verifyTwoFactorSignIn(
      w.ctx,
      { code: await codeFor(setup.totpURI), kind: "totp", trustDevice: false, cookie: challenge },
      from(),
    );
    expect(right.status).toBe("ok");
    const session = await resolveActor(w.ctx, new Headers({ cookie: cookieOf(right.status === "ok" ? right.setCookies : []) }));
    expect(session).toMatchObject({ status: "ok", actor: { id: w.admin.id } });

    // A backup code works once.
    const [backup] = setup.backupCodes;
    const again = await signInWithPassword(w.ctx, { email: "asha@capitup.test", password: PASSWORD }, from());
    const viaBackup = await verifyTwoFactorSignIn(
      w.ctx,
      { code: backup, kind: "backup", trustDevice: false, cookie: cookieOf(again.status === "two-factor" ? again.setCookies : []) },
      from(),
    );
    expect(viaBackup.status).toBe("ok");
    const third = await signInWithPassword(w.ctx, { email: "asha@capitup.test", password: PASSWORD }, from());
    const reused = await verifyTwoFactorSignIn(
      w.ctx,
      { code: backup, kind: "backup", trustDevice: false, cookie: cookieOf(third.status === "two-factor" ? third.setCookies : []) },
      from(),
    );
    expect(reused).toEqual({ status: "invalid" });
  });

  it("agents without it still sign in with the password alone", async () => {
    expect((await signInWithPassword(w.ctx, { email: "amit@capitup.test", password: PASSWORD }, from())).status).toBe("ok");
  });

  it("lets another admin reset it after a lost phone, with an audit row", async () => {
    const ravi = await createUser(w.ctx, w.admin, { email: "ravi@capitup.test", fullName: "Ravi Admin", password: PASSWORD, role: "ADMIN" });
    // A new account must change its password first; that doesn't block enrolment here.
    await enrol("ravi@capitup.test");
    expect(await hasTwoFactor(w.ctx, ravi.id)).toBe(true);

    await expect(resetTwoFactor(w.ctx, w.amit, ravi.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(resetTwoFactor(w.ctx, w.admin, w.admin.id)).rejects.toBeInstanceOf(AccessDeniedError);
    await resetTwoFactor(w.ctx, w.admin, ravi.id);
    expect(await hasTwoFactor(w.ctx, ravi.id)).toBe(false);
    expect((await signInWithPassword(w.ctx, { email: "ravi@capitup.test", password: PASSWORD }, from())).status).toBe("ok");
    const rows = await w.ctx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.table_name, "user"), eq(auditLogs.record_id, ravi.id)));
    expect(rows).toEqual([expect.objectContaining({ actor_id: w.admin.id, action: "UPDATE" })]);
  });
});
