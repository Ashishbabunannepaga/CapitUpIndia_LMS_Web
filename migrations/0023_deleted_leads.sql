CREATE TABLE `deleted_leads` (
	`lead_id` integer PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`assigned_agent_id` text,
	`deleted_by` text,
	`deleted_at` text NOT NULL,
	`snapshot` text NOT NULL,
	FOREIGN KEY (`deleted_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deleted_leads_deleted_idx` ON `deleted_leads` (`deleted_at`);