import { adminClient, PASSWORD, USERS } from "./fixtures";

// Creates the test accounts the way an admin does in the Supabase dashboard
// (sign-up is off), then promotes the admin.
export default async function globalSetup() {
  const admin = adminClient();
  const { data: existing, error: listError } = await admin.auth.admin.listUsers();
  if (listError) throw listError;

  for (const user of Object.values(USERS)) {
    if (!existing.users.some((u) => u.email === user.email)) {
      const { error } = await admin.auth.admin.createUser({
        email: user.email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: user.name },
      });
      if (error) throw error;
    }
    const { error } = await admin.from("profiles").update({ role: user.role, is_active: true }).eq("email", user.email);
    if (error) throw error;
  }
}
