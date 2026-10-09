import "server-only";

import { cache } from "react";

import type { LeadStatus, Profile } from "@/lib/database.types";
import type { LeadFilters } from "@/lib/lead-filters";
import { requireSession } from "@/lib/auth";
import * as leadData from "@/server/data/leads";
import { findSimilarLeads as findSimilar } from "@/server/data/duplicates";
import { recentNotifications } from "@/server/data/notifications";
import { listTeam } from "@/server/data/users";

// Reads for the workspace screens, as the signed-in user. The data layer
// (src/server/data) decides which leads come back.

export type TeamMember = Pick<Profile, "id" | "full_name" | "role" | "is_active">;

export type LeadWithAgent = leadData.LeadWithAgent;

export const LEAD_LIST_LIMIT = leadData.LEAD_LIST_LIMIT;

/** The whole team (every active user can see it). */
export const getTeam = cache(async (): Promise<TeamMember[]> => {
  const { ctx, actor } = await requireSession();
  const team = await listTeam(ctx, actor);
  return team.map(({ id, full_name, role, is_active }) => ({ id, full_name, role, is_active }));
});

export async function listLeads(filters: LeadFilters): Promise<{ leads: LeadWithAgent[]; truncated: boolean }> {
  const { ctx, actor } = await requireSession();
  return leadData.listLeads(ctx, actor, filters);
}

/** How many leads match the filters in each status, for board columns beyond the list limit. */
export async function countLeadsByStatus(filters: LeadFilters): Promise<Record<LeadStatus, number>> {
  const { ctx, actor } = await requireSession();
  return leadData.countLeadsByStatus(ctx, actor, filters);
}

export async function getLead(id: number): Promise<LeadWithAgent | null> {
  const { ctx, actor } = await requireSession();
  return leadData.getLead(ctx, actor, id);
}

export async function getLeadNotes(leadId: number) {
  const { ctx, actor } = await requireSession();
  return leadData.getLeadNotes(ctx, actor, leadId);
}

/** Visible calendar events for a lead (the renewal due date and tasks), oldest first. */
export async function getLeadEvents(leadId: number) {
  const { ctx, actor } = await requireSession();
  return leadData.getLeadEvents(ctx, actor, leadId);
}

/** Other companies with a similar name, across all agents (owner names only). */
export async function findSimilarLeads(clientName: string, excludeId?: number) {
  if (!clientName.trim()) return [];
  const { ctx, actor } = await requireSession();
  return findSimilar(ctx, actor, clientName, { excludeId });
}

/** Recent renewal reminders for the bell, and how many are unread. */
export const getRecentNotifications = cache(async () => {
  const { ctx, actor } = await requireSession();
  return recentNotifications(ctx, actor, 20);
});

export const getUnreadNoteCount = cache(async (): Promise<number> => {
  const { ctx, actor } = await requireSession();
  return leadData.countUnreadLeadNotes(ctx, actor);
});

export async function withAgentNames<T extends Pick<LeadWithAgent, "assigned_agent_id">>(
  leads: T[],
): Promise<(T & { agent_name: string | null })[]> {
  const team = await getTeam();
  const names = new Map(team.map((member) => [member.id, member.full_name]));
  return leads.map((lead) => ({
    ...lead,
    agent_name: lead.assigned_agent_id ? (names.get(lead.assigned_agent_id) ?? null) : null,
  }));
}
