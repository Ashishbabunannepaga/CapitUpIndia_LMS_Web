import { openLocalDb, PASSWORD, USERS } from "./fixtures";
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
  } finally {
    await db.dispose();
  }
}
