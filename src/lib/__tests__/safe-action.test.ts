import { redirect } from "next/navigation";
import { describe, expect, it } from "vitest";

import { actionFailureMessage, isStaleBuildError, safeAction } from "@/lib/safe-action";

describe("safeAction", () => {
  it("passes the action's own result through", async () => {
    await expect(safeAction(async () => ({ ok: true as const }))).resolves.toEqual({ ok: true });
    await expect(safeAction(async () => ({ ok: false as const, error: "No access" }))).resolves.toEqual({
      ok: false,
      error: "No access",
    });
  });

  it("turns a failed call into an error result instead of throwing", async () => {
    const result = await safeAction(async () => {
      throw new Error("An unexpected response was received from the server.");
    });
    expect(result).toEqual({ ok: false, error: "The server did not answer, so nothing was saved. Try again in a moment." });
  });

  it("still lets Next.js redirects through", async () => {
    await expect(safeAction(async () => redirect("/leads/1"))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });
});

describe("isStaleBuildError", () => {
  it.each([
    'Server Action "7f3a9c" was not found on the server.',
    "Failed to find Server Action. This request might be from an older or newer deployment.",
    "Loading chunk 812 failed.",
    "Failed to fetch dynamically imported module: https://lms.capitupindia.com/_next/static/chunks/a.js",
  ])("spots an old tab after a deploy: %s", (message) => {
    expect(isStaleBuildError(new Error(message))).toBe(true);
    expect(actionFailureMessage(new Error(message))).toMatch(/updated/);
  });

  it("does not treat ordinary failures as a new deploy", () => {
    expect(isStaleBuildError(new Error("Failed to fetch"))).toBe(false);
    expect(isStaleBuildError("boom")).toBe(false);
  });
});
