"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

/**
 * Re-renders the current page when leads, notes, events or notifications change, so
 * assignments, status changes and new notes from teammates show up without a
 * reload. Supabase Realtime applies RLS, so each user only hears about rows
 * they can see. Bursts of changes are collapsed into one refresh.
 */
export function RealtimeRefresh() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 750);
    };

    const channel = supabase
      .channel("workspace-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "lead_notes" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, refresh)
      .subscribe();

    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
