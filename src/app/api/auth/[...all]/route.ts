import { getAuth } from "@/server/auth";

// Better Auth's endpoints (sign-in, sign-out, session). Sign-up is disabled
// in src/server/auth.ts.
async function handle(request: Request) {
  const auth = await getAuth();
  return auth.handler(request);
}

export const GET = handle;
export const POST = handle;
