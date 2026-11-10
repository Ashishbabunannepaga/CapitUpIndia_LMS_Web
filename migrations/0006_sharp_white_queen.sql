CREATE TABLE `visiting_card_previews` (
	`path` text PRIMARY KEY NOT NULL,
	`mime` text NOT NULL,
	`data` blob NOT NULL,
	`byte_size` integer NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "visiting_card_previews_mime" CHECK("visiting_card_previews"."mime" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "visiting_card_previews_size" CHECK("visiting_card_previews"."byte_size" between 1 and 307200)
);
--> statement-breakpoint
-- Hand-written, not the generated table rebuild: on D1, dropping and
-- recreating `leads` cascades and deletes every event and lead note. Adding
-- columns keeps every row. The snapshot matches the schema, so later
-- `npm run d1:generate` runs see no difference here.
-- Lead type (New, Renewal, Rollover) moves to `lead_type`; `type` stays unused.
ALTER TABLE `leads` ADD `lead_type` text DEFAULT 'New' NOT NULL CONSTRAINT "leads_lead_type" CHECK(`lead_type` in ('New', 'Renewal', 'Rollover'));
--> statement-breakpoint
-- The copy is not an edit, so pause the updated_at trigger while it runs.
DROP TRIGGER `leads_set_updated_at`;
--> statement-breakpoint
UPDATE `leads` SET `lead_type` = `type` WHERE `lead_type` <> `type`;
--> statement-breakpoint
CREATE TRIGGER `leads_set_updated_at` AFTER UPDATE ON `leads` WHEN new.updated_at = old.updated_at BEGIN
	UPDATE `leads` SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = new.id;
END;
--> statement-breakpoint
ALTER TABLE `leads` ADD `relationship_manager` text DEFAULT '' NOT NULL CONSTRAINT "leads_relationship_manager_len" CHECK(length(`relationship_manager`) <= 200);
