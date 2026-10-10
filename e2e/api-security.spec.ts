import { expect, test, type APIRequestContext } from "@playwright/test";

import { uploadCard } from "@/server/data/cards";
import { createLead } from "@/server/data/leads";
import { setActive } from "@/server/data/users";

import {
  actor,
  BASE_URL,
  clientAddress,
  execute,
  openLocalDb,
  PASSWORD,
  queryFirst,
  retrying,
  USERS,
  type LocalDb,
  type UserKey,
} from "./fixtures";

// Someone can skip the screens and call the Worker's endpoints directly:
// the sign-in API, the card route and every page with any cookie they like.
// These tests do exactly that, over HTTP, and check the rules hold.

test.describe.configure({ mode: "serial" });

let db: LocalDb;
let nehaLead: number;

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

async function signInApi(request: APIRequestContext, email: string, password: string, ip = clientAddress(), origin = BASE_URL) {
  return request.post("/api/auth/sign-in/email", {
    headers: { origin, "cf-connecting-ip": ip },
    data: { email, password },
    maxRedirects: 0,
  });
}

/** A session cookie for a user, as a browser would hold it. */
async function sessionCookie(request: APIRequestContext, user: UserKey): Promise<string> {
  const response = await signInApi(request, USERS[user].email, PASSWORD);
  expect(response.status()).toBe(200);
  return response
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value.split(";")[0])
    .join("; ");
}

test.beforeAll(async () => {
  db = await openLocalDb();
  await execute(db, "delete from leads where client_name like 'API %'");
  const neha = await actor(db, "neha");
  const card = await uploadCard(db.ctx, neha, JPEG);
  nehaLead = await retrying(() =>
    createLead(db.ctx, neha, { client_name: "API Neha Co", notes: "Neha's secret notes", visiting_card_path: card }),
  );
});

test.afterAll(async () => {
  await db?.dispose();
});

test("sign-up is closed", async ({ request }) => {
  const response = await request.post("/api/auth/sign-up/email", {
    headers: { origin: BASE_URL, "cf-connecting-ip": clientAddress() },
    data: { email: "intruder@e2e.test", password: "intruder-Password-1", name: "Intruder" },
  });
  expect(response.ok()).toBe(false);
  const row = await queryFirst(db, "select id from user where email = 'intruder@e2e.test'");
  expect(row).toBeNull();
});

test("a sign-in from another site is refused", async ({ request }) => {
  const response = await signInApi(request, USERS.amit.email, PASSWORD, clientAddress(), "https://evil.example");
  expect(response.status()).toBe(403);
  expect(response.headers()["set-cookie"]).toBeUndefined();
});

test("password guessing is stopped after five tries a minute", async ({ request }) => {
  const ip = clientAddress();
  for (let i = 0; i < 5; i++) {
    expect((await signInApi(request, USERS.amit.email, "guess-" + i, ip)).status()).toBe(401);
  }
  expect((await signInApi(request, USERS.amit.email, PASSWORD, ip)).status()).toBe(429);
  // Other people keep signing in.
  expect((await signInApi(request, USERS.amit.email, PASSWORD)).status()).toBe(200);
});

test("signed-out and forged sessions see nothing", async ({ request }) => {
  const anonymous = await request.get(`/leads/${nehaLead}`, { maxRedirects: 0 });
  expect(anonymous.status()).toBe(307);
  expect(anonymous.headers().location).toContain("/login");

  const forged = await request.get(`/leads/${nehaLead}`, {
    headers: { cookie: "better-auth.session_token=forged.value" },
    maxRedirects: 0,
  });
  expect([303, 307, 308]).toContain(forged.status());
  expect(await forged.text()).not.toContain("Neha's secret notes");

  const card = await request.get(`/leads/${nehaLead}/card`, { maxRedirects: 0 });
  expect(card.status()).toBe(307);
});

test("an agent cannot open another agent's lead or visiting card", async ({ request }) => {
  const cookie = await sessionCookie(request, "amit");
  const page = await request.get(`/leads/${nehaLead}`, { headers: { cookie } });
  expect(page.status()).toBe(404);
  expect(await page.text()).not.toContain("Neha's secret notes");
  const card = await request.get(`/leads/${nehaLead}/card`, { headers: { cookie } });
  expect(card.status()).toBe(404);
});

test("the owner gets the card as an image that cannot run as a page", async ({ request }) => {
  const cookie = await sessionCookie(request, "neha");
  const card = await request.get(`/leads/${nehaLead}/card`, { headers: { cookie } });
  expect(card.status()).toBe(200);
  expect(card.headers()["content-type"]).toBe("image/jpeg");
  expect(card.headers()["x-content-type-options"]).toBe("nosniff");
  expect(new Uint8Array(await card.body())).toEqual(JPEG);
});

test("a deactivated agent's still-open session is shut out", async ({ request }) => {
  const cookie = await sessionCookie(request, "amit");
  const admin = await actor(db, "admin");
  const amit = await actor(db, "amit");
  await retrying(() => setActive(db.ctx, admin, amit.id, false));
  try {
    const response = await request.get("/my-day", { headers: { cookie }, maxRedirects: 0 });
    expect([303, 307, 308]).toContain(response.status());
    // Deactivating ends the session itself, so the cookie is now worthless.
    expect(response.headers().location).toMatch(/\/(login|auth\/signout\?reason=inactive)/);
    expect(await response.text()).not.toContain(USERS.amit.name);
    const sessions = await queryFirst<{ n: number }>(db, "select count(*) as n from session where user_id = ?", amit.id);
    expect(sessions?.n).toBe(0);
  } finally {
    await retrying(() => setActive(db.ctx, admin, amit.id, true));
  }
});

test("the reminder cron runs inside the Worker", async ({ request }) => {
  // wrangler dev --test-scheduled exposes the Cron Trigger for testing.
  const response = await request.get("/__scheduled?cron=*+*+*+*+*");
  expect(response.ok()).toBe(true);
});
