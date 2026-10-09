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

// Sign-in attempts per IP and endpoint (Better Auth rate limiting). Stored in
// D1 so every Worker instance sees the same counts.
export const authRateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

// --- App tables ------------------------------------------------------------

export const profiles = sqliteTable(
  "profiles",
  {
    id: text("id")
      .primaryKey()
      .references(() => authUser.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    full_name: text("full_name").notNull(),
    role: text("role", { enum: USER_ROLES }).notNull().default("AGENT"),
    is_active: bool("is_active").notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("profiles_role_active_idx").on(t.role, t.is_active),
    check("profiles_full_name_len", sql`length(trim(${t.full_name})) between 1 and 120`),
    check("profiles_role", sql`${t.role} in (${inList(USER_ROLES)})`),
  ],
);

export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    client_name: text("client_name").notNull(),
    client_name_normalized: text("client_name_normalized").notNull(),
    type: text("type", { enum: LEAD_TYPES }).notNull().default("New"),
    business_type: text("business_type", { enum: BUSINESS_TYPES }).notNull().default("Corporate"),
    policy_product: text("policy_product", { enum: POLICY_PRODUCTS }).notNull().default("Health"),
    sub_product_name: text("sub_product_name").notNull().default(""),
    renewal_date: text("renewal_date"),
    poc_name: text("poc_name").notNull().default(""),
    poc_designation: text("poc_designation").notNull().default("poc"),
    poc_contact_number: text("poc_contact_number").notNull().default(""),
    poc_email_id: text("poc_email_id").notNull().default(""),
    poc2_name: text("poc2_name").notNull().default(""),
    poc2_designation: text("poc2_designation").notNull().default(""),
    poc2_contact_number: text("poc2_contact_number").notNull().default(""),
    poc2_email_id: text("poc2_email_id").notNull().default(""),
    address: text("address").notNull().default(""),
    notes: text("notes").notNull().default(""),
    status: text("status", { enum: LEAD_STATUSES }).notNull().default("Prospect"),
    assigned_agent_id: text("assigned_agent_id").references(() => profiles.id, { onDelete: "set null" }),
    assigned_at: text("assigned_at"),
    is_duplicate: bool("is_duplicate").notNull().default(false),
    duplicate_label: text("duplicate_label").notNull().default(""),
    duplicate_resolved_at: text("duplicate_resolved_at"),
    duplicate_resolved_by: text("duplicate_resolved_by").references(() => profiles.id, { onDelete: "set null" }),
    visiting_card_path: text("visiting_card_path"),
    created_by: text("created_by").references(() => profiles.id, { onDelete: "set null" }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("leads_client_name_normalized_idx").on(t.client_name_normalized),
    index("leads_renewal_date_idx").on(t.renewal_date),
    index("leads_assigned_status_idx").on(t.assigned_agent_id, t.status),
    index("leads_status_idx").on(t.status),
    index("leads_created_at_idx").on(t.created_at),
    index("leads_updated_at_idx").on(t.updated_at),
    index("leads_duplicate_idx").on(t.is_duplicate),
    check("leads_client_name_len", sql`length(trim(${t.client_name})) between 1 and 300`),
    check("leads_type", sql`${t.type} in (${inList(LEAD_TYPES)})`),
    check("leads_business_type", sql`${t.business_type} in (${inList(BUSINESS_TYPES)})`),
    check("leads_policy_product", sql`${t.policy_product} in (${inList(POLICY_PRODUCTS)})`),
    check("leads_status", sql`${t.status} in (${inList(LEAD_STATUSES)})`),
    check("leads_renewal_date", sql`${t.renewal_date} is null or coalesce(${t.renewal_date} = date(${t.renewal_date}), 0)`),
    check("leads_sub_product_len", sql`length(${t.sub_product_name}) <= 200`),
    check("leads_poc_name_len", sql`length(${t.poc_name}) <= 120 and length(${t.poc2_name}) <= 120`),
    check("leads_poc_designation_len", sql`length(${t.poc_designation}) <= 120 and length(${t.poc2_designation}) <= 120`),
    check("leads_poc_phone_len", sql`length(${t.poc_contact_number}) <= 32 and length(${t.poc2_contact_number}) <= 32`),
    check(
      "leads_poc_email",
      sql`(${t.poc_email_id} = '' or ${t.poc_email_id} glob '?*@?*.?*') and (${t.poc2_email_id} = '' or ${t.poc2_email_id} glob '?*@?*.?*')`,
    ),
    check("leads_address_len", sql`length(${t.address}) <= 1000`),
    check("leads_notes_len", sql`length(${t.notes}) <= 20000`),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lead_id: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    event_timestamp: text("event_timestamp").notNull(),
    notes: text("notes").notNull().default(""),
    milestone: text("milestone"),
    is_completed: bool("is_completed").notNull().default(false),
    completed_at: text("completed_at"),
    is_system_generated: bool("is_system_generated").notNull().default(false),
    is_background_reminder: bool("is_background_reminder").notNull().default(false),
    reminder_sent_at: text("reminder_sent_at"),
    assigned_agent_id: text("assigned_agent_id").references(() => profiles.id, { onDelete: "set null" }),
    created_by: text("created_by").references(() => profiles.id, { onDelete: "set null" }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("events_lead_milestone_key")
      .on(t.lead_id, t.milestone)
      .where(sql`${t.is_system_generated} = 1`),
    index("events_agent_time_idx").on(t.assigned_agent_id, t.event_timestamp),
    index("events_lead_idx").on(t.lead_id),
    index("events_pending_reminders_idx")
      .on(t.event_timestamp)
      .where(sql`${t.is_background_reminder} = 1 and ${t.reminder_sent_at} is null`),
    check("events_title_len", sql`length(trim(${t.title})) between 1 and 300`),
    check("events_notes_len", sql`length(${t.notes}) <= 5000`),
    check(
      "events_system_milestone",
      sql`not ${t.is_system_generated} or (${t.lead_id} is not null and ${t.milestone} is not null)`,
    ),
  ],
);

export const leadNotes = sqliteTable(
  "lead_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lead_id: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    agent_id: text("agent_id").references(() => profiles.id, { onDelete: "set null" }),
    agent_name: text("agent_name").notNull(),
    content: text("content").notNull(),
    created_at: createdAt(),
  },
  (t) => [
    index("lead_notes_lead_idx").on(t.lead_id, t.created_at),
    index("lead_notes_created_idx").on(t.created_at),
    check("lead_notes_content_len", sql`length(trim(${t.content})) between 1 and 5000`),
  ],
);

export const leadNoteReads = sqliteTable(
  "lead_note_reads",
  {
    note_id: integer("note_id")
      .notNull()
      .references(() => leadNotes.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    read_at: text("read_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.note_id, t.user_id] }), index("lead_note_reads_user_idx").on(t.user_id)],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: text("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["renewal_reminder", "other"] }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    lead_id: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    event_id: integer("event_id").references(() => events.id, { onDelete: "set null" }),
    milestone: text("milestone"),
    created_at: createdAt(),
    read_at: text("read_at"),
  },
  (t) => [
    index("notifications_user_idx").on(t.user_id, t.read_at, t.created_at),
    uniqueIndex("notifications_event_user_key").on(t.event_id, t.user_id),
    check("notifications_kind", sql`${t.kind} in ('renewal_reminder', 'other')`),
    check("notifications_title_len", sql`length(${t.title}) between 1 and 300`),
    check("notifications_body_len", sql`length(${t.body}) <= 2000`),
  ],
);

export const renewalMilestoneOffsets = sqliteTable("renewal_milestone_offsets", {
  milestone: text("milestone").primaryKey(),
  offset_seconds: integer("offset_seconds").notNull(),
  sort_order: integer("sort_order").notNull(),
});

export const aiModelPricing = sqliteTable(
  "ai_model_pricing",
  {
    model_name: text("model_name").primaryKey(),
    display_name: text("display_name").notNull(),
    input_usd_per_million: real("input_usd_per_million").notNull(),
    output_usd_per_million: real("output_usd_per_million").notNull(),
    is_active: bool("is_active").notNull().default(true),
    updated_at: updatedAt(),
    updated_by: text("updated_by").references(() => profiles.id, { onDelete: "set null" }),
  },
  (t) => [check("ai_model_pricing_non_negative", sql`${t.input_usd_per_million} >= 0 and ${t.output_usd_per_million} >= 0`)],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  // JSON text, as the jsonb column held before.
  value: text("value", { mode: "json" }).notNull(),
  description: text("description").notNull().default(""),
  updated_at: updatedAt(),
  updated_by: text("updated_by").references(() => profiles.id, { onDelete: "set null" }),
});

export const aiUsageLogs = sqliteTable(
  "ai_usage_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: text("user_id").references(() => profiles.id, { onDelete: "set null" }),
    agent_name: text("agent_name").notNull(),
    feature_name: text("feature_name", { enum: AI_FEATURES }).notNull(),
    model_name: text("model_name").notNull(),
    input_tokens: integer("input_tokens").notNull(),
    output_tokens: integer("output_tokens").notNull(),
    cost_inr: real("cost_inr").notNull(),
    created_at: createdAt(),
  },
  (t) => [
    index("ai_usage_logs_user_idx").on(t.user_id, t.created_at),
    index("ai_usage_logs_feature_idx").on(t.feature_name, t.created_at),
    index("ai_usage_logs_created_idx").on(t.created_at),
    check("ai_usage_logs_feature", sql`${t.feature_name} in (${inList(AI_FEATURES)})`),
    check("ai_usage_logs_tokens", sql`${t.input_tokens} >= 0 and ${t.output_tokens} >= 0 and ${t.cost_inr} >= 0`),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    table_name: text("table_name").notNull(),
    record_id: text("record_id").notNull(),
    action: text("action", { enum: ["INSERT", "UPDATE", "DELETE"] }).notNull(),
    actor_id: text("actor_id"),
    old_data: text("old_data", { mode: "json" }),
    new_data: text("new_data", { mode: "json" }),
    created_at: createdAt(),
  },
  (t) => [
    index("audit_logs_record_idx").on(t.table_name, t.record_id, t.created_at),
    index("audit_logs_created_idx").on(t.created_at),
  ],
);
