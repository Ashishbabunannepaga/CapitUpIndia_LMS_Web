"use client";

import { ErrorScreen } from "@/components/app-shell/error-screen";

// Keeps the sidebar when a page inside the app fails.
export default function AppError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return <ErrorScreen error={error} retry={retry} />;
}
