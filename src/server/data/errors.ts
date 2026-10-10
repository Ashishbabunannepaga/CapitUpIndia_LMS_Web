// Errors data functions throw. Pages and actions show `message` to the user.

/** The caller may not do this (the database's RLS errors, 42501, before). */
export class AccessDeniedError extends Error {
  constructor(message = "You do not have access to do that.") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

/** The request is understood but the input is not acceptable. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/** True for SQLite's RAISE(ABORT, ...) from a guard trigger with this text. */
export function isTriggerError(error: unknown, text: string): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : "";
  return message.includes(text);
}
