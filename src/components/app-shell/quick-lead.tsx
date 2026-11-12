"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Dialog } from "radix-ui";
import { Loader2, Plus, X } from "lucide-react";

import { quickLeadSetup, type QuickLeadSetup } from "@/app/(app)/leads/actions";
import { IntakeWorkspace } from "@/components/intake/intake-workspace";
import { safeAction } from "@/lib/safe-action";

/** Pages that already are the add-lead form (or must not be left half-way). */
const HIDDEN_ON = ["/leads/new", "/intake", "/change-password"];

/**
 * The floating "+" on every page: opens AI intake or the manual form in a
 * window over the current page. Saving opens the new lead, as on Add lead.
 * The team list and AI status load only when the window opens.
 */
export function QuickLeadButton() {
  const pathname = usePathname();
  // Open for the page it was opened on: saving navigates to the new lead, which closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const [setup, setSetup] = useState<QuickLeadSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = openOn === pathname;

  if (HIDDEN_ON.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return null;

  function show(next: boolean) {
    setOpenOn(next ? pathname : null);
    if (!next || setup) return;
    setError(null);
    void safeAction(async () => {
      const loaded = await quickLeadSetup();
      if (!loaded) return { ok: false as const, error: "Your session has ended. Sign in again." };
      setSetup(loaded);
      return { ok: true as const };
    }).then((result) => {
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={show}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Add a lead"
          title="Add a lead"
          className="fixed right-4 bottom-4 z-30 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lift transition-transform duration-150 hover:scale-105 focus-visible:ring-4 focus-visible:ring-ring/40 focus-visible:outline-none active:scale-95 sm:right-6 sm:bottom-6 print:hidden"
        >
          <Plus className="size-6" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-in bg-black/40 fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-5 shadow-lift sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <Dialog.Title className="text-lg font-medium">Add a lead</Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                Capture it without leaving this page. Saving opens the new lead.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-1 text-muted-foreground hover:text-foreground">
                <X className="size-5" />
              </button>
            </Dialog.Close>
          </div>
          {setup ? (
            <IntakeWorkspace
              agents={setup.agents}
              currentUserId={setup.currentUserId}
              isAdmin={setup.isAdmin}
              aiConfigured={setup.aiConfigured}
              onCancel={() => show(false)}
            />
          ) : error ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : (
            <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
