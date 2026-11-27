import { writeFileSync } from "node:fs";

import { ADMIN_TOTP_FILE, BASE_URL, execute, openLocalDb, PASSWORD, totpSecretFromUri, USERS } from "./fixtures";
import { createOTP } from "@better-auth/utils/otp";
import { confirmTwoFactorSetup, signInWithPassword, startTwoFactorSetup, type RequestInfo } from "@/server/data/sessions";
import { createFirstAdmin, createUser, listTeam } from "@/server/data/users";

// Creates the test accounts the way the app does: the first admin on an
// empty team, then the agents by that admin. scripts/e2e.sh starts from an
// empty database.
export default async function globalSetup() {
  const db = await openLocalDb();
  try {
    const admin = await createFirstAdmin(db.ctx, { email: USERS.admin.email, fullName: USERS.admin.name, password: PASSWORD });
    const team = await listTeam(db.ctx, admin);
    for (const user of [USERS.amit, USERS.neha]) {
      if (!team.some((m) => m.email === user.email)) {
        await createUser(db.ctx, admin, { email: user.email, fullName: user.name, password: PASSWORD });
      }
    }
    // The shared agents stand for people who already chose their own
    // password; the forced change has its own test in app.spec.ts.
    await execute(db, "update profiles set must_change_password = 0 where email in (?, ?)", USERS.amit.email, USERS.neha.email);

    // Admins must have two-step sign-in (audit R11): switch it on for the
    // e2e admin the way a person does, and keep the secret for the tests.
    const info: RequestInfo = { origin: BASE_URL, ip: "10.250.0.1", userAgent: "e2e-setup" };
    const signedIn = await signInWithPassword(db.ctx, { email: USERS.admin.email, password: PASSWORD }, info);
    if (signedIn.status !== "ok") throw new Error(`e2e admin sign-in for two-step setup failed: ${signedIn.status}`);
    const cookie = signedIn.setCookies.map((c) => c.split(";")[0]).join("; ");
    const setup = await startTwoFactorSetup(db.ctx, { password: PASSWORD, cookie }, info);
    if (!setup) throw new Error("e2e admin two-step setup failed");
    const secret = totpSecretFromUri(setup.totpURI);
    const confirmed = await confirmTwoFactorSetup(db.ctx, { code: await createOTP(secret).totp(), cookie }, info);
    if (confirmed.status !== "ok") throw new Error("e2e admin two-step confirm failed");
    writeFileSync(ADMIN_TOTP_FILE, secret);
  } finally {
    await db.dispose();
  }
}
