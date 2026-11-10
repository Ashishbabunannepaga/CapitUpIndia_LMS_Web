"use client";

import { ErrorScreen } from "@/components/app-shell/error-screen";

// Catches failures in the signed-in layout itself and in /login, /setup.
export default function RootError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return <ErrorScreen error={error} retry={retry} />;
}
