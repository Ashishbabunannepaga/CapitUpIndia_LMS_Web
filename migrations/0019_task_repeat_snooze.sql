ALTER TABLE `work_tasks` ADD `repeat` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_tasks` ADD `snoozed_until` text;