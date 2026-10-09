import "server-only";

import { AccessDeniedError, InvalidInputError } from "@/server/data/errors";

/** What to tell the user when a data function fails. */
export function friendlyError(error: unknown): string {
  if (error instanceof AccessDeniedError || error instanceof InvalidInputError) return error.message;
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : "";
  if (text.includes("CHECK constraint failed")) return "Some details are not in a valid format.";
  if (text.includes("The last active admin")) return "The last active admin cannot be removed.";
  console.error(error);
  return "Something went wrong. Try again.";
}
