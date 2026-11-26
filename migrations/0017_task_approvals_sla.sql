CREATE TABLE `business_holidays` (
	`date` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_sla_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tag` text NOT NULL,
	`priority` text,
	`soon_minutes` integer NOT NULL,
	`nudge_minutes` integer NOT NULL,
	`escalate_minutes` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "task_sla_rules_minutes" CHECK("task_sla_rules"."soon_minutes" between 0 and 10080 and "task_sla_rules"."nudge_minutes" between 5 and 43200 and "task_sla_rules"."escalate_minutes" between 5 and 43200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_sla_rules_tag_priority` ON `task_sla_rules` (`tag`,`priority`);--> statement-breakpoint
ALTER TABLE `work_tasks` ADD `approval` text;--> statement-breakpoint
ALTER TABLE `work_tasks` ADD `approval_note` text;--> statement-breakpoint
ALTER TABLE `work_tasks` ADD `approval_by` text;--> statement-breakpoint
ALTER TABLE `work_tasks` ADD `approval_at` text;