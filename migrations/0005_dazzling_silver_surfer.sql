CREATE TABLE `sign_in_failures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "sign_in_failures_reason" CHECK("sign_in_failures"."reason" in ('invalid', 'inactive')),
	CONSTRAINT "sign_in_failures_email_len" CHECK(length("sign_in_failures"."email") <= 320)
);
--> statement-breakpoint
CREATE INDEX `sign_in_failures_created_idx` ON `sign_in_failures` (`created_at`);--> statement-breakpoint
CREATE INDEX `sign_in_failures_email_idx` ON `sign_in_failures` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `sign_in_failures_ip_idx` ON `sign_in_failures` (`ip`,`created_at`);--> statement-breakpoint
ALTER TABLE `profiles` ADD `must_change_password` integer DEFAULT false NOT NULL;