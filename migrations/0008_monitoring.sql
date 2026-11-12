CREATE TABLE `app_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`source` text NOT NULL,
	`path` text,
	`status` integer,
	`message` text,
	`user_id` text,
	CONSTRAINT "app_errors_source" CHECK("app_errors"."source" in ('server', 'browser', 'job')),
	CONSTRAINT "app_errors_path_len" CHECK(length("app_errors"."path") <= 300),
	CONSTRAINT "app_errors_message_len" CHECK(length("app_errors"."message") <= 1000)
);
--> statement-breakpoint
CREATE INDEX `app_errors_created_idx` ON `app_errors` (`created_at`);--> statement-breakpoint
CREATE TABLE `health_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checked_at` text NOT NULL,
	`ok` integer NOT NULL,
	`db_ok` integer NOT NULL,
	`db_ms` integer,
	`site_status` integer,
	`site_ms` integer,
	`server_errors` integer DEFAULT 0 NOT NULL,
	`browser_errors` integer DEFAULT 0 NOT NULL,
	`job_errors` integer DEFAULT 0 NOT NULL,
	`problem` text
);
--> statement-breakpoint
CREATE INDEX `health_checks_checked_idx` ON `health_checks` (`checked_at`);