CREATE TABLE `lead_contact_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`agent_id` text,
	`agent_name` text NOT NULL,
	`channel` text NOT NULL,
	`with_draft` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "lead_contact_logs_channel" CHECK("lead_contact_logs"."channel" in ('call', 'whatsapp', 'email'))
);
--> statement-breakpoint
CREATE INDEX `lead_contact_logs_lead_idx` ON `lead_contact_logs` (`lead_id`,`created_at`);