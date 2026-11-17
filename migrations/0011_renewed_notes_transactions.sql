CREATE TABLE `lead_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`transaction_date` text NOT NULL,
	`policy_start_date` text,
	`policy_status` text DEFAULT 'Policy Yet to Receive' NOT NULL,
	`policy_doc_path` text,
	`policy_doc_name` text DEFAULT '' NOT NULL,
	`policy_doc_mime` text,
	`created_by` text,
	`updated_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "lead_transactions_dates" CHECK("lead_transactions"."transaction_date" = date("lead_transactions"."transaction_date") and ("lead_transactions"."policy_start_date" is null or "lead_transactions"."policy_start_date" = date("lead_transactions"."policy_start_date"))),
	CONSTRAINT "lead_transactions_policy_status" CHECK("lead_transactions"."policy_status" in ('Policy Received', 'Policy Yet to Receive')),
	CONSTRAINT "lead_transactions_doc_name_len" CHECK(length("lead_transactions"."policy_doc_name") <= 200),
	CONSTRAINT "lead_transactions_doc_mime" CHECK("lead_transactions"."policy_doc_mime" is null or "lead_transactions"."policy_doc_mime" in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
CREATE INDEX `lead_transactions_lead_idx` ON `lead_transactions` (`lead_id`,`transaction_date`);--> statement-breakpoint
CREATE INDEX `lead_transactions_start_idx` ON `lead_transactions` (`policy_start_date`);--> statement-breakpoint
-- Open tabs refresh when transactions change, like leads and notes (see 0003).
CREATE TRIGGER `lead_transactions_bump_change_version_insert` AFTER INSERT ON `lead_transactions`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `lead_transactions_bump_change_version_update` AFTER UPDATE ON `lead_transactions`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `lead_transactions_bump_change_version_delete` AFTER DELETE ON `lead_transactions`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
-- Hand-written from here, not the generated `leads` table rebuild: on D1,
-- dropping and recreating `leads` cascades and deletes every event, note and
-- reminder. Adding columns keeps every row. The snapshot matches the schema,
-- so later `npm run d1:generate` runs see no difference here.
--
-- 1. "Renewed" status. The old `status` CHECK cannot take a new value, so the
-- status moves to `lead_status`; `status` stays, unused.
ALTER TABLE `leads` ADD `lead_status` text DEFAULT 'Prospect' NOT NULL CONSTRAINT "leads_lead_status" CHECK(`lead_status` in ('Prospect', 'Quoted', 'Follow-up', 'Closed Won', 'Renewed', 'Closed Lost'));
--> statement-breakpoint
-- Copying values is not an edit, so pause the updated_at trigger while it runs.
DROP TRIGGER `leads_set_updated_at`;
--> statement-breakpoint
UPDATE `leads` SET `lead_status` = CASE WHEN `status` = 'Active Client' THEN 'Closed Won' ELSE `status` END;
--> statement-breakpoint
CREATE TRIGGER `leads_set_updated_at` AFTER UPDATE ON `leads` WHEN new.updated_at = old.updated_at BEGIN
	UPDATE `leads` SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = new.id;
END;
--> statement-breakpoint
DROP INDEX `leads_assigned_status_idx`;
--> statement-breakpoint
DROP INDEX `leads_status_idx`;
--> statement-breakpoint
CREATE INDEX `leads_assigned_lead_status_idx` ON `leads` (`assigned_agent_id`,`lead_status`);
--> statement-breakpoint
CREATE INDEX `leads_lead_status_idx` ON `leads` (`lead_status`);
--> statement-breakpoint
-- 2. Notes can be edited: remember when.
ALTER TABLE `lead_notes` ADD `edited_at` text;
