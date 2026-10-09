import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// D1 (SQLite) schema. Ported from supabase/migrations; the comments there
// still explain the business rules. Differences from Postgres:
//   * Enums are text columns with CHECK constraints.
//   * Timestamps are ISO-8601 UTC strings ("2026-10-09T10:00:00.000Z"), the
//     same shape the app already passes around, and they sort correctly.
//   * Nothing here knows who the user is. Who can read or change what is
//     enforced in src/server/data, the only code allowed to query D1.
//   * client_name_normalized is written by the data layer with
//     normalizeCompanyName() (SQLite cannot call it from a generated column).

export const USER_ROLES = ["ADMIN", "AGENT"] as const;
export const LEAD_TYPES = ["New", "Renewal"] as const;
export const BUSINESS_TYPES = ["Corporate", "Retail"] as const;
export const POLICY_PRODUCTS = ["Health", "Fire or Property", "Life", "Motor", "Liability", "Travel", "Marine", "Credit"] as const;
export const LEAD_STATUSES = ["Prospect", "Quoted", "Active Client", "Follow-up", "Closed Won", "Closed Lost"] as const;
export const AI_FEATURES = ["lead_intake", "card_ocr", "follow_up", "follow_up_rephrase", "bulk_mapping", "other"] as const;

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "));
const createdAt = () => text("created_at").notNull().default(now);
const updatedAt = () => text("updated_at").notNull().default(now);
const bool = (name: string) => integer(name, { mode: "boolean" });

// --- Better Auth tables (names and columns follow its Drizzle schema) -------

export const authUser = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: bool("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const authSession = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const authAccount = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const authVerification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

// --- App tables ------------------------------------------------------------

export const profiles = sqliteTable(
  "profiles",
  {
    id: text("id")
      .primaryKey()
      .references(() => authUser.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    fullName: text("full_name").notNull(),
    role: text("role", { enum: USER_ROLES }).notNull().default("AGENT"),
    isActive: bool("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("profiles_role_active_idx").on(t.role, t.isActive),
    check("profiles_full_name_len", sql`length(trim(${t.fullName})) between 1 and 120`),
    check("profiles_role", sql`${t.role} in (${inList(USER_ROLES)})`),
  ],
);

export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clientName: text("client_name").notNull(),
    clientNameNormalized: text("client_name_normalized").notNull(),
    type: text("type", { enum: LEAD_TYPES }).notNull().default("New"),
    businessType: text("business_type", { enum: BUSINESS_TYPES }).notNull().default("Corporate"),
    policyProduct: text("policy_product", { enum: POLICY_PRODUCTS }).notNull().default("Health"),
    subProductName: text("sub_product_name").notNull().default(""),
    renewalDate: text("renewal_date"),
    pocName: text("poc_name").notNull().default(""),
    pocDesignation: text("poc_designation").notNull().default("poc"),
    pocContactNumber: text("poc_contact_number").notNull().default(""),
    pocEmailId: text("poc_email_id").notNull().default(""),
    poc2Name: text("poc2_name").notNull().default(""),
    poc2Designation: text("poc2_designation").notNull().default(""),
    poc2ContactNumber: text("poc2_contact_number").notNull().default(""),
    poc2EmailId: text("poc2_email_id").notNull().default(""),
    address: text("address").notNull().default(""),
    notes: text("notes").notNull().default(""),
    status: text("status", { enum: LEAD_STATUSES }).notNull().default("Prospect"),
    assignedAgentId: text("assigned_agent_id").references(() => profiles.id, { onDelete: "set null" }),
    assignedAt: text("assigned_at"),
    isDuplicate: bool("is_duplicate").notNull().default(false),
    duplicateLabel: text("duplicate_label").notNull().default(""),
    duplicateResolvedAt: text("duplicate_resolved_at"),
    duplicateResolvedBy: text("duplicate_resolved_by").references(() => profiles.id, { onDelete: "set null" }),
    visitingCardPath: text("visiting_card_path"),
    createdBy: text("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("leads_client_name_normalized_idx").on(t.clientNameNormalized),
    index("leads_renewal_date_idx").on(t.renewalDate),
    index("leads_assigned_status_idx").on(t.assignedAgentId, t.status),
    index("leads_status_idx").on(t.status),
    index("leads_created_at_idx").on(t.createdAt),
    index("leads_updated_at_idx").on(t.updatedAt),
    index("leads_duplicate_idx").on(t.isDuplicate),
    check("leads_client_name_len", sql`length(trim(${t.clientName})) between 1 and 300`),
    check("leads_type", sql`${t.type} in (${inList(LEAD_TYPES)})`),
    check("leads_business_type", sql`${t.businessType} in (${inList(BUSINESS_TYPES)})`),
    check("leads_policy_product", sql`${t.policyProduct} in (${inList(POLICY_PRODUCTS)})`),
    check("leads_status", sql`${t.status} in (${inList(LEAD_STATUSES)})`),
    check("leads_renewal_date", sql`${t.renewalDate} is null or coalesce(${t.renewalDate} = date(${t.renewalDate}), 0)`),
    check("leads_sub_product_len", sql`length(${t.subProductName}) <= 200`),
    check("leads_poc_name_len", sql`length(${t.pocName}) <= 120 and length(${t.poc2Name}) <= 120`),
    check("leads_poc_designation_len", sql`length(${t.pocDesignation}) <= 120 and length(${t.poc2Designation}) <= 120`),
    check("leads_poc_phone_len", sql`length(${t.pocContactNumber}) <= 32 and length(${t.poc2ContactNumber}) <= 32`),
    check(
      "leads_poc_email",
      sql`(${t.pocEmailId} = '' or ${t.pocEmailId} glob '?*@?*.?*') and (${t.poc2EmailId} = '' or ${t.poc2EmailId} glob '?*@?*.?*')`,
    ),
    check("leads_address_len", sql`length(${t.address}) <= 1000`),
    check("leads_notes_len", sql`length(${t.notes}) <= 20000`),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    eventTimestamp: text("event_timestamp").notNull(),
    notes: text("notes").notNull().default(""),
    milestone: text("milestone"),
    isCompleted: bool("is_completed").notNull().default(false),
    completedAt: text("completed_at"),
    isSystemGenerated: bool("is_system_generated").notNull().default(false),
    isBackgroundReminder: bool("is_background_reminder").notNull().default(false),
    reminderSentAt: text("reminder_sent_at"),
    assignedAgentId: text("assigned_agent_id").references(() => profiles.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("events_lead_milestone_key")
      .on(t.leadId, t.milestone)
      .where(sql`${t.isSystemGenerated} = 1`),
    index("events_agent_time_idx").on(t.assignedAgentId, t.eventTimestamp),
    index("events_lead_idx").on(t.leadId),
    index("events_pending_reminders_idx")
      .on(t.eventTimestamp)
      .where(sql`${t.isBackgroundReminder} = 1 and ${t.reminderSentAt} is null`),
    check("events_title_len", sql`length(trim(${t.title})) between 1 and 300`),
    check("events_notes_len", sql`length(${t.notes}) <= 5000`),
    check(
      "events_system_milestone",
      sql`not ${t.isSystemGenerated} or (${t.leadId} is not null and ${t.milestone} is not null)`,
    ),
  ],
);

export const leadNotes = sqliteTable(
  "lead_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => profiles.id, { onDelete: "set null" }),
    agentName: text("agent_name").notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("lead_notes_lead_idx").on(t.leadId, t.createdAt),
    index("lead_notes_created_idx").on(t.createdAt),
    check("lead_notes_content_len", sql`length(trim(${t.content})) between 1 and 5000`),
  ],
);

export const leadNoteReads = sqliteTable(
  "lead_note_reads",
  {
    noteId: integer("note_id")
      .notNull()
      .references(() => leadNotes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    readAt: text("read_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.userId] }), index("lead_note_reads_user_idx").on(t.userId)],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["renewal_reminder", "other"] }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    leadId: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    eventId: integer("event_id").references(() => events.id, { onDelete: "set null" }),
    milestone: text("milestone"),
    createdAt: createdAt(),
    readAt: text("read_at"),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.readAt, t.createdAt),
    uniqueIndex("notifications_event_user_key").on(t.eventId, t.userId),
    check("notifications_kind", sql`${t.kind} in ('renewal_reminder', 'other')`),
    check("notifications_title_len", sql`length(${t.title}) between 1 and 300`),
    check("notifications_body_len", sql`length(${t.body}) <= 2000`),
  ],
);

export const renewalMilestoneOffsets = sqliteTable("renewal_milestone_offsets", {
  milestone: text("milestone").primaryKey(),
  offsetSeconds: integer("offset_seconds").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const aiModelPricing = sqliteTable(
  "ai_model_pricing",
  {
    modelName: text("model_name").primaryKey(),
    displayName: text("display_name").notNull(),
    inputUsdPerMillion: real("input_usd_per_million").notNull(),
    outputUsdPerMillion: real("output_usd_per_million").notNull(),
    isActive: bool("is_active").notNull().default(true),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by").references(() => profiles.id, { onDelete: "set null" }),
  },
  (t) => [check("ai_model_pricing_non_negative", sql`${t.inputUsdPerMillion} >= 0 and ${t.outputUsdPerMillion} >= 0`)],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  // JSON text, as the jsonb column held before.
  value: text("value", { mode: "json" }).notNull(),
  description: text("description").notNull().default(""),
  updatedAt: updatedAt(),
  updatedBy: text("updated_by").references(() => profiles.id, { onDelete: "set null" }),
});

export const aiUsageLogs = sqliteTable(
  "ai_usage_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").references(() => profiles.id, { onDelete: "set null" }),
    agentName: text("agent_name").notNull(),
    featureName: text("feature_name", { enum: AI_FEATURES }).notNull(),
    modelName: text("model_name").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costInr: real("cost_inr").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_usage_logs_user_idx").on(t.userId, t.createdAt),
    index("ai_usage_logs_feature_idx").on(t.featureName, t.createdAt),
    index("ai_usage_logs_created_idx").on(t.createdAt),
    check("ai_usage_logs_feature", sql`${t.featureName} in (${inList(AI_FEATURES)})`),
    check("ai_usage_logs_tokens", sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.costInr} >= 0`),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    action: text("action", { enum: ["INSERT", "UPDATE", "DELETE"] }).notNull(),
    actorId: text("actor_id"),
    oldData: text("old_data", { mode: "json" }),
    newData: text("new_data", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_record_idx").on(t.tableName, t.recordId, t.createdAt),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);
