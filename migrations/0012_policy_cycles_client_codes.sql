PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_usage_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`agent_name` text NOT NULL,
	`feature_name` text NOT NULL,
	`model_name` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_inr` real NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_usage_logs_feature" CHECK("__new_ai_usage_logs"."feature_name" in ('lead_intake', 'card_ocr', 'follow_up', 'follow_up_rephrase', 'bulk_mapping', 'policy_ocr', 'other')),
	CONSTRAINT "ai_usage_logs_tokens" CHECK("__new_ai_usage_logs"."input_tokens" >= 0 and "__new_ai_usage_logs"."output_tokens" >= 0 and "__new_ai_usage_logs"."cost_inr" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_ai_usage_logs`("id", "user_id", "agent_name", "feature_name", "model_name", "input_tokens", "output_tokens", "cost_inr", "created_at") SELECT "id", "user_id", "agent_name", "feature_name", "model_name", "input_tokens", "output_tokens", "cost_inr", "created_at" FROM `ai_usage_logs`;--> statement-breakpoint
DROP TABLE `ai_usage_logs`;--> statement-breakpoint
ALTER TABLE `__new_ai_usage_logs` RENAME TO `ai_usage_logs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_usage_logs_user_idx` ON `ai_usage_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_usage_logs_feature_idx` ON `ai_usage_logs` (`feature_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_usage_logs_created_idx` ON `ai_usage_logs` (`created_at`);--> statement-breakpoint
-- Hand-written from here, not the generated `leads` and `lead_transactions`
-- rebuilds: on D1, dropping and recreating `leads` cascades and deletes every
-- event, note and reminder, and a rebuild of `lead_transactions` would drop
-- its triggers. Adding columns keeps every row. The snapshot matches the
-- schema, so later `npm run d1:generate` runs see no difference here.
-- (ai_usage_logs above has no dependants and no triggers, so its rebuild is safe.)
--
-- 1. Statuses: Renewed folds into Closed Won; new Closed Awaiting Policy and
-- Auto Renewed. The `lead_status` CHECK cannot take new values, so the status
-- moves to `pipeline_status`; `lead_status` stays, unused.
ALTER TABLE `leads` ADD `pipeline_status` text DEFAULT 'Prospect' NOT NULL CONSTRAINT "leads_pipeline_status" CHECK(`pipeline_status` in ('Prospect', 'Quoted', 'Follow-up', 'Closed Awaiting Policy', 'Closed Won', 'Auto Renewed', 'Closed Lost'));
--> statement-breakpoint
ALTER TABLE `leads` ADD `status_changed_at` text;
--> statement-breakpoint
-- 2. Client codes: a permanent client number per client, and the current code.
ALTER TABLE `leads` ADD `client_no` integer;
--> statement-breakpoint
ALTER TABLE `leads` ADD `client_code` text;
--> statement-breakpoint
-- Copying values is not an edit, so pause the updated_at trigger while it runs.
DROP TRIGGER `leads_set_updated_at`;
--> statement-breakpoint
UPDATE `leads` SET `pipeline_status` = CASE WHEN `lead_status` = 'Renewed' THEN 'Closed Won' ELSE `lead_status` END;
--> statement-breakpoint
-- Today's clients get numbers in the order they were added. The code's year
-- is the current policy year: a year before the next renewal date, or the
-- year the lead was last changed when it has no date.
UPDATE `leads` SET `client_no` = (
  SELECT count(*) FROM `leads` AS `earlier`
  WHERE `earlier`.`pipeline_status` = 'Closed Won' AND `earlier`.`id` <= `leads`.`id`
) WHERE `pipeline_status` = 'Closed Won';
--> statement-breakpoint
UPDATE `leads` SET `client_code` = 'CAP-CLI-' || CASE
    WHEN `renewal_date` IS NOT NULL THEN CAST(substr(`renewal_date`, 1, 4) AS integer) - 1
    ELSE CAST(substr(`updated_at`, 1, 4) AS integer)
  END || '-' || printf('%04d', `client_no`)
WHERE `client_no` IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `leads_set_updated_at` AFTER UPDATE ON `leads` WHEN new.updated_at = old.updated_at BEGIN
	UPDATE `leads` SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = new.id;
END;
--> statement-breakpoint
DROP INDEX `leads_assigned_lead_status_idx`;
--> statement-breakpoint
DROP INDEX `leads_lead_status_idx`;
--> statement-breakpoint
CREATE INDEX `leads_assigned_pipeline_status_idx` ON `leads` (`assigned_agent_id`,`pipeline_status`);
--> statement-breakpoint
CREATE INDEX `leads_pipeline_status_idx` ON `leads` (`pipeline_status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_client_no_idx` ON `leads` (`client_no`);
--> statement-breakpoint
CREATE INDEX `leads_client_code_idx` ON `leads` (`client_code`);
--> statement-breakpoint
-- 3. Policy history: lead_transactions becomes one row per policy year with
-- what the policy says and how it was checked.
ALTER TABLE `lead_transactions` ADD `policy_end_date` text CONSTRAINT "lead_transactions_end_date" CHECK(`policy_end_date` is null or `policy_end_date` = date(`policy_end_date`));
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `premium` real CONSTRAINT "lead_transactions_premium" CHECK(`premium` is null or `premium` >= 0);
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `sum_insured` real CONSTRAINT "lead_transactions_sum_insured" CHECK(`sum_insured` is null or `sum_insured` >= 0);
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `insurer` text DEFAULT '' NOT NULL CONSTRAINT "lead_transactions_insurer_len" CHECK(length(`insurer`) <= 200);
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `policy_number` text DEFAULT '' NOT NULL CONSTRAINT "lead_transactions_policy_number_len" CHECK(length(`policy_number`) <= 100);
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `product` text;
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `kind` text DEFAULT 'won' NOT NULL CONSTRAINT "lead_transactions_kind" CHECK(`kind` in ('won', 'renewal', 'auto_renewed'));
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `verification` text DEFAULT 'not_checked' NOT NULL CONSTRAINT "lead_transactions_verification" CHECK(`verification` in ('pending', 'verified', 'differences', 'manual', 'not_checked'));
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `client_code` text;
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `extracted` text;
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `checks` text;
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `previous_renewal_date` text;
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `next_renewal_date` text;
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `confirmed_at` text;
--> statement-breakpoint
ALTER TABLE `lead_transactions` ADD `confirmed_by` text REFERENCES `profiles`(`id`) ON DELETE set null;
--> statement-breakpoint
-- Rows entered since 17 Nov keep their place in the history with the code of their year.
UPDATE `lead_transactions` SET
  `product` = (SELECT `product` FROM `leads` WHERE `leads`.`id` = `lead_transactions`.`lead_id`),
  `client_code` = (
    SELECT 'CAP-CLI-' || substr(coalesce(`lead_transactions`.`policy_start_date`, `lead_transactions`.`transaction_date`), 1, 4)
      || '-' || printf('%04d', `leads`.`client_no`)
    FROM `leads` WHERE `leads`.`id` = `lead_transactions`.`lead_id` AND `leads`.`client_no` IS NOT NULL
  );
--> statement-breakpoint
CREATE INDEX `lead_transactions_client_code_idx` ON `lead_transactions` (`client_code`);
