import { getDataContext } from "@/server/data/context";
import { handleAuthRequest } from "@/server/data/sessions";

// Better Auth's endpoints (sign-in, sign-out, session). Sign-up is disabled
// in src/server/auth.ts. Failed sign-ins made here are logged like the login
// form's (src/server/data/sign-in-failures.ts).
async function handle(request: Request) {
  return handleAuthRequest(await getDataContext(), request);
}

export const GET = handle;
export const POST = handle;
