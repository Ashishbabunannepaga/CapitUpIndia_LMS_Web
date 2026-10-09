// Row types for the D1 schema in src/server/db/schema.ts. Type-only, so
// client components can use them without pulling in the database code.

import type {
  AI_FEATURES,
  BUSINESS_TYPES,
  LEAD_STATUSES,
  LEAD_TYPES,
  POLICY_PRODUCTS,
  USER_ROLES,
  aiModelPricing,
  aiUsageLogs,
  events,
  leadNotes,
  leads,
  notifications,
  profiles,
} from "@/server/db/schema";

export type UserRole = (typeof USER_ROLES)[number];
export type LeadType = (typeof LEAD_TYPES)[number];
export type BusinessType = (typeof BUSINESS_TYPES)[number];
export type PolicyProduct = (typeof POLICY_PRODUCTS)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type AiFeature = (typeof AI_FEATURES)[number];
export type NotificationKind = AppNotification["kind"];

export type Profile = typeof profiles.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type LeadEvent = typeof events.$inferSelect;
export type LeadNote = typeof leadNotes.$inferSelect;
export type AiUsageLog = typeof aiUsageLogs.$inferSelect;
export type AppNotification = typeof notifications.$inferSelect;
export type ModelPricing = typeof aiModelPricing.$inferSelect;
