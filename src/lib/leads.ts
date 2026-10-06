import "server-only";

import { cache } from "react";

import type { Lead, LeadStatus, Profile } from "@/lib/database.types";
import { addDays, todayInBusinessTz } from "@/lib/dates";
import { LEAD_STATUSES } from "@/lib/domain";
import type { LeadFilters } from "@/lib/lead-filters";
import { createClient } from "@/lib/supabase/server";

// Reads for the workspace screens. Everything runs as the signed-in user, so
// RLS decides which leads come back; nothing here filters by role for safety.

export type TeamMember = Pick<Profile, "id" | "full_name" | "role" | "is_active">;

export type LeadWithAgent = Lead & { agent_name: string | null };

/** Everyone the caller can see (active users see the whole team). */
export const getTeam = cache(async (): Promise<TeamMember[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active")
    .order("full_name");
  if (error) throw error;
  return data;
});

export async function withAgentNames<T extends Pick<Lead, "assigned_agent_id">>(
  leads: T[],
): Promise<(T & { agent_name: string | null })[]> {
  const team = await getTeam();
  const names = new Map(team.map((member) => [member.id, member.full_name]));
  return leads.map((lead) => ({
    ...lead,
    agent_name: lead.assigned_agent_id ? (names.get(lead.assigned_agent_id) ?? null) : null,
  }));
}

/** Strips characters that have meaning inside a PostgREST or() filter. */
function searchTerm(q: string): string {
  return q.replace(/[,()*%\\:"']/g, " ").replace(/\s+/g, " ").trim();
}

export const LEAD_LIST_LIMIT = 500;

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** The leads matching the list filters; `head` counts them without loading rows. */
function filteredLeads(supabase: Supabase, filters: LeadFilters, today: string, head?: { count: "exact"; head: true }) {
  let query = supabase.from("leads").select("*", head);

  const term = searchTerm(filters.q);
  if (term) {
    const like = `%${term}%`;
    query = query.or(
      [
        `client_name.ilike.${like}`,
        `poc_name.ilike.${like}`,
        `poc2_name.ilike.${like}`,
        `sub_product_name.ilike.${like}`,
        `poc_contact_number.ilike.${like}`,
        `poc_email_id.ilike.${like}`,
        `poc2_email_id.ilike.${like}`,
        `notes.ilike.${like}`,
      ].join(","),
    );
  }
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.product) query = query.eq("policy_product", filters.product);
  if (filters.type) query = query.eq("type", filters.type);
  if (filters.agent === "unassigned") query = query.is("assigned_agent_id", null);
  else if (filters.agent) query = query.eq("assigned_agent_id", filters.agent);
  if (filters.duplicates) query = query.eq("is_duplicate", true);

  switch (filters.renewal) {
    case "overdue":
      query = query.lt("renewal_date", today).not("status", "in", '("Closed Won","Closed Lost")');
      break;
    case "7":
    case "30":
    case "90":
      query = query.gte("renewal_date", today).lte("renewal_date", addDays(today, Number(filters.renewal)));
      break;
    case "none":
      query = query.is("renewal_date", null);
      break;
  }
  return query;
}

export async function listLeads(filters: LeadFilters): Promise<{ leads: LeadWithAgent[]; truncated: boolean }> {
  const supabase = await createClient();
  let query = filteredLeads(supabase, filters, todayInBusinessTz());

  switch (filters.sort) {
    case "name":
      query = query.order("client_name_normalized").order("id");
      break;
    case "renewal_asc":
      query = query.order("renewal_date", { ascending: true, nullsFirst: false }).order("id");
      break;
    case "renewal_desc":
      query = query.order("renewal_date", { ascending: false, nullsFirst: false }).order("id");
      break;
    case "created":
      query = query.order("created_at", { ascending: false }).order("id", { ascending: false });
      break;
    default:
      query = query.order("updated_at", { ascending: false }).order("id", { ascending: false });
  }

  const { data, error } = await query.limit(LEAD_LIST_LIMIT + 1);
  if (error) throw error;
  const truncated = data.length > LEAD_LIST_LIMIT;
  return { leads: await withAgentNames(data.slice(0, LEAD_LIST_LIMIT)), truncated };
}

/** How many leads match the filters in each status, for board columns beyond the list limit. */
export async function countLeadsByStatus(filters: LeadFilters): Promise<Record<LeadStatus, number>> {
  const supabase = await createClient();
  const today = todayInBusinessTz();
  const counts = await Promise.all(
    LEAD_STATUSES.map(async (status) => {
      const { count, error } = await filteredLeads(supabase, { ...filters, status }, today, { count: "exact", head: true });
      if (error) throw error;
      return [status, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(counts) as Record<LeadStatus, number>;
}

export async function getLead(id: number): Promise<LeadWithAgent | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("leads").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [lead] = await withAgentNames([data]);
  return lead;
}

export async function getLeadNotes(leadId: number) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("lead_notes")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw error;
  return data;
}

/** Visible calendar events for a lead (the renewal due date and tasks), oldest first. */
export async function getLeadEvents(leadId: number) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("lead_id", leadId)
    .order("event_timestamp");
  if (error) throw error;
  return data;
}

/** Other companies with a similar name, across all agents (owner names only). */
export async function findSimilarLeads(clientName: string, excludeId?: number) {
  if (!clientName.trim()) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("find_similar_leads", {
    p_client_name: clientName,
    p_exclude_id: excludeId ?? null,
  });
  if (error) throw error;
  return data;
}

/** Recent renewal reminders for the bell, and how many are unread. */
export const getRecentNotifications = cache(async () => {
  const supabase = await createClient();
  const [{ data }, { count }] = await Promise.all([
    supabase
      .from("notifications")
      .select("id, title, body, lead_id, created_at, read_at")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
  ]);
  return { items: data ?? [], unread: count ?? 0 };
});

export const getUnreadNoteCount = cache(async (): Promise<number> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("count_unread_lead_notes");
  if (error) return 0;
  return data ?? 0;
});
