import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

// Shared accounts and clients for the end-to-end tests. Keys come from the
// local Supabase stack (scripts/e2e.sh); none of this touches a real project.

export const PASSWORD = "e2e-Password-1!";

export const USERS = {
  admin: { email: "admin@e2e.test", name: "Esha Admin", role: "ADMIN" as const },
  amit: { email: "amit@e2e.test", name: "Amit E2E", role: "AGENT" as const },
  neha: { email: "neha@e2e.test", name: "Neha E2E", role: "AGENT" as const },
};
export type UserKey = keyof typeof USERS;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run the tests with npm run test:e2e`);
  return value;
}

export const supabaseUrl = () => env("NEXT_PUBLIC_SUPABASE_URL");

/** Service-role client: bypasses RLS, for setup and assertions only. */
export function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(supabaseUrl(), env("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client exactly as the browser has it: publishable key, no session. */
export function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(supabaseUrl(), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client signed in as one of the test users, talking to the API directly. */
export async function userClient(user: UserKey): Promise<SupabaseClient<Database>> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email: USERS[user].email, password: PASSWORD });
  if (error) throw error;
  return client;
}

export async function userId(user: UserKey): Promise<string> {
  const { data, error } = await adminClient().from("profiles").select("id").eq("email", USERS[user].email).single();
  if (error) throw error;
  return data.id;
}
