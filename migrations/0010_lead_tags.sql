CREATE TABLE `lead_tags` (
	`lead_id` integer NOT NULL,
	`tag` text NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`lead_id`, `tag`),
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "lead_tags_tag" CHECK("lead_tags"."tag" in ('Hot', 'VIP', 'Price sensitive', 'Referral', 'Cold'))
);
--> statement-breakpoint
CREATE INDEX `lead_tags_tag_idx` ON `lead_tags` (`tag`,`lead_id`);--> statement-breakpoint
-- Open tabs refresh when tags change, like leads and notes (see 0003).
CREATE TRIGGER `lead_tags_bump_change_version_insert` AFTER INSERT ON `lead_tags`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `lead_tags_bump_change_version_delete` AFTER DELETE ON `lead_tags`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
