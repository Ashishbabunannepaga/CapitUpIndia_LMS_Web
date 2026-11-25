-- Task Grid: tasks with a conversation thread (src/server/data/work-tasks.ts).
CREATE TABLE `work_task_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`author_id` text,
	`author_name` text NOT NULL,
	`kind` text DEFAULT 'message' NOT NULL,
	`via` text DEFAULT 'text' NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `work_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "work_task_messages_kind" CHECK("work_task_messages"."kind" in ('message', 'system')),
	CONSTRAINT "work_task_messages_via" CHECK("work_task_messages"."via" in ('text', 'voice')),
	CONSTRAINT "work_task_messages_body_len" CHECK(length(trim("work_task_messages"."body")) between 1 and 4000)
);
--> statement-breakpoint
CREATE INDEX `work_task_messages_task_idx` ON `work_task_messages` (`task_id`,`id`);--> statement-breakpoint
CREATE TABLE `work_task_reads` (
	`task_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`last_read_message_id` integer DEFAULT 0 NOT NULL,
	`read_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `work_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_task_reads_user_idx` ON `work_task_reads` (`user_id`);--> statement-breakpoint
CREATE TABLE `work_task_tags` (
	`task_id` integer NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`task_id`, `tag`),
	FOREIGN KEY (`task_id`) REFERENCES `work_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_task_tags_tag_len" CHECK(length("work_task_tags"."tag") between 1 and 30)
);
--> statement-breakpoint
CREATE INDEX `work_task_tags_tag_idx` ON `work_task_tags` (`tag`,`task_id`);--> statement-breakpoint
CREATE TABLE `work_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text DEFAULT 'personal' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`due_at` text,
	`assignee_id` text NOT NULL,
	`created_by` text,
	`created_by_name` text DEFAULT '' NOT NULL,
	`lead_id` integer,
	`seen_at` text,
	`nudged_at` text,
	`completed_at` text,
	`last_activity_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`assignee_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "work_tasks_kind" CHECK("work_tasks"."kind" in ('personal', 'assigned')),
	CONSTRAINT "work_tasks_priority" CHECK("work_tasks"."priority" in ('P1', 'P2', 'P3')),
	CONSTRAINT "work_tasks_status" CHECK("work_tasks"."status" in ('todo', 'in_progress', 'blocked', 'done')),
	CONSTRAINT "work_tasks_title_len" CHECK(length(trim("work_tasks"."title")) between 1 and 200),
	CONSTRAINT "work_tasks_description_len" CHECK(length("work_tasks"."description") <= 5000)
);
--> statement-breakpoint
CREATE INDEX `work_tasks_assignee_idx` ON `work_tasks` (`assignee_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `work_tasks_creator_idx` ON `work_tasks` (`created_by`,`status`);--> statement-breakpoint
CREATE INDEX `work_tasks_lead_idx` ON `work_tasks` (`lead_id`);--> statement-breakpoint
-- Hand-edited: ADD COLUMN, never a rebuild of notifications; cascade like the schema says.
ALTER TABLE `notifications` ADD `task_id` integer REFERENCES work_tasks(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `notifications_task_idx` ON `notifications` (`task_id`) WHERE `task_id` IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER `work_tasks_bump_change_version_insert` AFTER INSERT ON `work_tasks`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `work_tasks_bump_change_version_update` AFTER UPDATE ON `work_tasks`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `work_tasks_bump_change_version_delete` AFTER DELETE ON `work_tasks`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `work_task_messages_bump_change_version_insert` AFTER INSERT ON `work_task_messages`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `work_task_messages_bump_change_version_update` AFTER UPDATE ON `work_task_messages`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `work_task_messages_bump_change_version_delete` AFTER DELETE ON `work_task_messages`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `work_task_tags_bump_change_version_insert` AFTER INSERT ON `work_task_tags`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `work_task_tags_bump_change_version_update` AFTER UPDATE ON `work_task_tags`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `work_task_tags_bump_change_version_delete` AFTER DELETE ON `work_task_tags`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
