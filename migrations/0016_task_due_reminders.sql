ALTER TABLE `work_tasks` ADD `reminder_stage` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `work_tasks` ADD `reminder_for` text;