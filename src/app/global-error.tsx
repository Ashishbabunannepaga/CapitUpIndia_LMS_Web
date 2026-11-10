"use client";

import "./globals.css";

import { ErrorScreen } from "@/components/app-shell/error-screen";

// Last resort: the root layout failed, so this draws its own document.
export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <html lang="en-IN">
      <body className="min-h-full bg-background font-sans antialiased">
        <title>CapitUp India LMS</title>
        <ErrorScreen error={error} retry={retry} />
      </body>
    </html>
  );
}
