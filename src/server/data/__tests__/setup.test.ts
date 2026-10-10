import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { freshD1 } from "../../db/test-d1";
import { createDataContext, type DataContext } from "../context";
import { AccessDeniedError, InvalidInputError } from "../errors";
import { completeSetup, isSetupOpen } from "../setup";

// The first-run /setup page: one admin, only with the setup code, only once.

const CODE = "a-long-setup-code-123";
const details = { email: "owner@capitup.test", fullName: "Owner Admin", password: "owner-password-1" };

let ctx: DataContext;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const d1 = await freshD1();
  ctx = createDataContext(d1.db, { BETTER_AUTH_SECRET: "test-secret-".padEnd(48, "x") }, d1.cards);
  dispose = d1.dispose;
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

describe("first-run setup", () => {
  it("is closed when no setup code is configured", async () => {
    expect(await isSetupOpen(ctx, undefined)).toBe(false);
    await expect(completeSetup(ctx, undefined, { code: "", ...details })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(completeSetup(ctx, "short", { code: "short", ...details })).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("needs the exact code", async () => {
    expect(await isSetupOpen(ctx, CODE)).toBe(true);
    await expect(completeSetup(ctx, CODE, { code: "a-long-setup-code-124", ...details })).rejects.toThrow("setup code");
    await expect(completeSetup(ctx, CODE, { code: undefined, ...details })).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("validates the account details", async () => {
    await expect(completeSetup(ctx, CODE, { code: CODE, ...details, password: "short" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it("creates one admin, then closes for good", async () => {
    const admin = await completeSetup(ctx, CODE, { code: ` ${CODE} `, ...details });
    expect(admin).toMatchObject({ email: details.email, role: "ADMIN", is_active: true });
    expect(await isSetupOpen(ctx, CODE)).toBe(false);
    await expect(
      completeSetup(ctx, CODE, { code: CODE, ...details, email: "second@capitup.test" }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
