CREATE TABLE `ai_model_pricing` (
	`model_name` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`input_usd_per_million` real NOT NULL,
	`output_usd_per_million` real NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_model_pricing_non_negative" CHECK("ai_model_pricing"."input_usd_per_million" >= 0 and "ai_model_pricing"."output_usd_per_million" >= 0)
);
--> statement-breakpoint
CREATE TABLE `ai_usage_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`agent_name` text NOT NULL,
	`feature_name` text NOT NULL,
	`model_name` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_inr` real NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_usage_logs_feature" CHECK("ai_usage_logs"."feature_name" in ('lead_intake', 'card_ocr', 'follow_up', 'follow_up_rephrase', 'bulk_mapping', 'other')),
	CONSTRAINT "ai_usage_logs_tokens" CHECK("ai_usage_logs"."input_tokens" >= 0 and "ai_usage_logs"."output_tokens" >= 0 and "ai_usage_logs"."cost_inr" >= 0)
);
--> statement-breakpoint
CREATE INDEX `ai_usage_logs_user_idx` ON `ai_usage_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_usage_logs_feature_idx` ON `ai_usage_logs` (`feature_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_usage_logs_created_idx` ON `ai_usage_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_name` text NOT NULL,
	`record_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text,
	`old_data` text,
	`new_data` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_record_idx` ON `audit_logs` (`table_name`,`record_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer,
	`title` text NOT NULL,
	`event_timestamp` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`milestone` text,
	`is_completed` integer DEFAULT false NOT NULL,
	`completed_at` text,
	`is_system_generated` integer DEFAULT false NOT NULL,
	`is_background_reminder` integer DEFAULT false NOT NULL,
	`reminder_sent_at` text,
	`assigned_agent_id` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_agent_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "events_title_len" CHECK(length(trim("events"."title")) between 1 and 300),
	CONSTRAINT "events_notes_len" CHECK(length("events"."notes") <= 5000),
	CONSTRAINT "events_system_milestone" CHECK(not "events"."is_system_generated" or ("events"."lead_id" is not null and "events"."milestone" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_lead_milestone_key` ON `events` (`lead_id`,`milestone`) WHERE "events"."is_system_generated" = 1;--> statement-breakpoint
CREATE INDEX `events_agent_time_idx` ON `events` (`assigned_agent_id`,`event_timestamp`);--> statement-breakpoint
CREATE INDEX `events_lead_idx` ON `events` (`lead_id`);--> statement-breakpoint
CREATE INDEX `events_pending_reminders_idx` ON `events` (`event_timestamp`) WHERE "events"."is_background_reminder" = 1 and "events"."reminder_sent_at" is null;--> statement-breakpoint
CREATE TABLE `lead_note_reads` (
	`note_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`read_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`note_id`, `user_id`),
	FOREIGN KEY (`note_id`) REFERENCES `lead_notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lead_note_reads_user_idx` ON `lead_note_reads` (`user_id`);--> statement-breakpoint
CREATE TABLE `lead_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`agent_id` text,
	`agent_name` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "lead_notes_content_len" CHECK(length(trim("lead_notes"."content")) between 1 and 5000)
);
--> statement-breakpoint
CREATE INDEX `lead_notes_lead_idx` ON `lead_notes` (`lead_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `lead_notes_created_idx` ON `lead_notes` (`created_at`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_name` text NOT NULL,
	`client_name_normalized` text NOT NULL,
	`type` text DEFAULT 'New' NOT NULL,
	`business_type` text DEFAULT 'Corporate' NOT NULL,
	`policy_product` text DEFAULT 'Health' NOT NULL,
	`sub_product_name` text DEFAULT '' NOT NULL,
	`renewal_date` text,
	`poc_name` text DEFAULT '' NOT NULL,
	`poc_designation` text DEFAULT 'poc' NOT NULL,
	`poc_contact_number` text DEFAULT '' NOT NULL,
	`poc_email_id` text DEFAULT '' NOT NULL,
	`poc2_name` text DEFAULT '' NOT NULL,
	`poc2_designation` text DEFAULT '' NOT NULL,
	`poc2_contact_number` text DEFAULT '' NOT NULL,
	`poc2_email_id` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'Prospect' NOT NULL,
	`assigned_agent_id` text,
	`assigned_at` text,
	`is_duplicate` integer DEFAULT false NOT NULL,
	`duplicate_label` text DEFAULT '' NOT NULL,
	`duplicate_resolved_at` text,
	`duplicate_resolved_by` text,
	`visiting_card_path` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`assigned_agent_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`duplicate_resolved_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "leads_client_name_len" CHECK(length(trim("leads"."client_name")) between 1 and 300),
	CONSTRAINT "leads_type" CHECK("leads"."type" in ('New', 'Renewal')),
	CONSTRAINT "leads_business_type" CHECK("leads"."business_type" in ('Corporate', 'Retail')),
	CONSTRAINT "leads_policy_product" CHECK("leads"."policy_product" in ('Health', 'Fire or Property', 'Life', 'Motor', 'Liability', 'Travel', 'Marine', 'Credit')),
	CONSTRAINT "leads_status" CHECK("leads"."status" in ('Prospect', 'Quoted', 'Active Client', 'Follow-up', 'Closed Won', 'Closed Lost')),
	CONSTRAINT "leads_renewal_date" CHECK("leads"."renewal_date" is null or coalesce("leads"."renewal_date" = date("leads"."renewal_date"), 0)),
	CONSTRAINT "leads_sub_product_len" CHECK(length("leads"."sub_product_name") <= 200),
	CONSTRAINT "leads_poc_name_len" CHECK(length("leads"."poc_name") <= 120 and length("leads"."poc2_name") <= 120),
	CONSTRAINT "leads_poc_designation_len" CHECK(length("leads"."poc_designation") <= 120 and length("leads"."poc2_designation") <= 120),
	CONSTRAINT "leads_poc_phone_len" CHECK(length("leads"."poc_contact_number") <= 32 and length("leads"."poc2_contact_number") <= 32),
	CONSTRAINT "leads_poc_email" CHECK(("leads"."poc_email_id" = '' or "leads"."poc_email_id" glob '?*@?*.?*') and ("leads"."poc2_email_id" = '' or "leads"."poc2_email_id" glob '?*@?*.?*')),
	CONSTRAINT "leads_address_len" CHECK(length("leads"."address") <= 1000),
	CONSTRAINT "leads_notes_len" CHECK(length("leads"."notes") <= 20000)
);
--> statement-breakpoint
CREATE INDEX `leads_client_name_normalized_idx` ON `leads` (`client_name_normalized`);--> statement-breakpoint
CREATE INDEX `leads_renewal_date_idx` ON `leads` (`renewal_date`);--> statement-breakpoint
CREATE INDEX `leads_assigned_status_idx` ON `leads` (`assigned_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `leads_status_idx` ON `leads` (`status`);--> statement-breakpoint
CREATE INDEX `leads_created_at_idx` ON `leads` (`created_at`);--> statement-breakpoint
CREATE INDEX `leads_updated_at_idx` ON `leads` (`updated_at`);--> statement-breakpoint
CREATE INDEX `leads_duplicate_idx` ON `leads` (`is_duplicate`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`lead_id` integer,
	`event_id` integer,
	`milestone` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`read_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notifications_kind" CHECK("notifications"."kind" in ('renewal_reminder', 'other')),
	CONSTRAINT "notifications_title_len" CHECK(length("notifications"."title") between 1 and 300),
	CONSTRAINT "notifications_body_len" CHECK(length("notifications"."body") <= 2000)
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_event_user_key` ON `notifications` (`event_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`full_name` text NOT NULL,
	`role` text DEFAULT 'AGENT' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "profiles_full_name_len" CHECK(length(trim("profiles"."full_name")) between 1 and 120),
	CONSTRAINT "profiles_role" CHECK("profiles"."role" in ('ADMIN', 'AGENT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_email_unique` ON `profiles` (`email`);--> statement-breakpoint
CREATE INDEX `profiles_role_active_idx` ON `profiles` (`role`,`is_active`);--> statement-breakpoint
CREATE TABLE `renewal_milestone_offsets` (
	`milestone` text PRIMARY KEY NOT NULL,
	`offset_seconds` integer NOT NULL,
	`sort_order` integer NOT NULL
);
