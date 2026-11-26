CREATE TABLE `whatsapp_lead_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`lead` text NOT NULL,
	`dropped` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `whatsapp_lead_drafts_user_idx` ON `whatsapp_lead_drafts` (`user_id`,`created_at`);