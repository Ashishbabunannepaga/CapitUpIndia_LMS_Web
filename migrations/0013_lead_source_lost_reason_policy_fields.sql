-- Lead source, lost reason and policy facts on leads, all ADD COLUMN (no
-- rebuild of `leads`, which on D1 would delete every event and note). Allowed
-- values are checked in src/server/data/leads.ts. Plus an index for the
-- per-minute task and meeting reminders.
ALTER TABLE `leads` ADD `lead_source` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `lost_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `lost_reason_detail` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `premium_inr` real;--> statement-breakpoint
ALTER TABLE `leads` ADD `insurer_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `policy_number` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `events_pending_task_reminders_idx` ON `events` (`event_timestamp`) WHERE "events"."is_system_generated" = 0 and "events"."is_completed" = 0 and "events"."reminder_sent_at" is null;