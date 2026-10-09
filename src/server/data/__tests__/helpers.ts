import { createDataContext, type DataContext } from "../context";
import { freshD1 } from "../../db/test-d1";
import { createFirstAdmin, createUser } from "../users";

export const PASSWORD = "correct-horse-battery";

/** A fresh D1 with an admin (Asha) and two agents (Amit, Neha). */
export async function testWorld() {
  const { db: d1, cards, dispose } = await freshD1();
  const ctx = createDataContext(d1, { BETTER_AUTH_SECRET: "test-secret-".padEnd(48, "x"), BETTER_AUTH_URL: "http://localhost:3000" }, cards);
  const adminProfile = await createFirstAdmin(ctx, { email: "asha@capitup.test", fullName: "Asha Admin", password: PASSWORD });
  const admin = adminProfile;
  const amit = await createUser(ctx, admin, { email: "amit@capitup.test", fullName: "Amit Agent", password: PASSWORD });
  const neha = await createUser(ctx, admin, { email: "neha@capitup.test", fullName: "Neha Agent", password: PASSWORD });
  return { ctx, d1, admin, amit, neha, dispose };
}


let ip = 0;

/** Signs in through the real auth endpoint; returns the response and cookie headers. */
export async function signIn(ctx: DataContext, email: string, password = PASSWORD) {
  // A distinct client address per attempt keeps tests clear of the rate limit,
  // except where a test reuses one on purpose.
  return signInFrom(ctx, email, password, `10.0.0.${++ip % 250}`);
}

export async function signInFrom(ctx: DataContext, email: string, password: string, address: string) {
  // Through the HTTP handler, like a browser, so rate limits and origin checks apply.
  const response = await ctx.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", "cf-connecting-ip": address },
      body: JSON.stringify({ email, password }),
    }),
  );
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { response, headers: new Headers({ cookie }) };
}
