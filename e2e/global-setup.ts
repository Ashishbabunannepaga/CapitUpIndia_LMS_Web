import { execute, openLocalDb, PASSWORD, USERS } from "./fixtures";
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
  } finally {
    await db.dispose();
  }
}
