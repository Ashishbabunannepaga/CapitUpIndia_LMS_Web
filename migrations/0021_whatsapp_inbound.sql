CREATE TABLE `whatsapp_inbound` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `whatsapp_inbound_created_idx` ON `whatsapp_inbound` (`created_at`);