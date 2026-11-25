CREATE TABLE `work_task_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`due_in_days` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_task_templates_priority" CHECK("work_task_templates"."priority" in ('P1', 'P2', 'P3')),
	CONSTRAINT "work_task_templates_name_len" CHECK(length(trim("work_task_templates"."name")) between 1 and 80),
	CONSTRAINT "work_task_templates_title_len" CHECK(length(trim("work_task_templates"."title")) between 1 and 200),
	CONSTRAINT "work_task_templates_description_len" CHECK(length("work_task_templates"."description") <= 5000),
	CONSTRAINT "work_task_templates_due" CHECK("work_task_templates"."due_in_days" is null or "work_task_templates"."due_in_days" between 0 and 365)
);
--> statement-breakpoint
CREATE INDEX `work_task_templates_owner_idx` ON `work_task_templates` (`owner_id`);--> statement-breakpoint
CREATE INDEX `work_task_templates_shared_idx` ON `work_task_templates` (`shared`);--> statement-breakpoint
ALTER TABLE `work_task_messages` ADD `audio_key` text;--> statement-breakpoint
ALTER TABLE `work_task_messages` ADD `audio_ms` integer;--> statement-breakpoint
ALTER TABLE `work_tasks` ADD `raised` integer DEFAULT false NOT NULL;