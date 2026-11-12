CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_sent_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "push_subscriptions_endpoint" CHECK("push_subscriptions"."endpoint" like 'https://%' and length("push_subscriptions"."endpoint") <= 1000),
	CONSTRAINT "push_subscriptions_keys_len" CHECK(length("push_subscriptions"."p256dh") <= 200 and length("push_subscriptions"."auth") <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
-- Hand-written from here, not the generated table rebuilds: on D1, dropping
-- and recreating `events` or `leads` cascades (deleting every event, note and
-- reminder, or nulling notification links). Adding columns keeps every row.
-- The snapshot matches the schema, so later `npm run d1:generate` runs see no
-- difference here.
--
-- 1. Meetings on the calendar: events get a kind (task or meeting).
ALTER TABLE `events` ADD `kind` text DEFAULT 'task' NOT NULL CONSTRAINT "events_kind" CHECK(`kind` in ('task', 'meeting'));
--> statement-breakpoint
-- 2. "Not Specified" policy product. The old `policy_product` CHECK cannot
-- take a new value, so the product moves to `product` (default Not
-- Specified); `policy_product` stays, unused.
ALTER TABLE `leads` ADD `product` text DEFAULT 'Not Specified' NOT NULL CONSTRAINT "leads_product" CHECK(`product` in ('Not Specified', 'Health', 'Fire or Property', 'Life', 'Motor', 'Liability', 'Travel', 'Marine', 'Credit'));
--> statement-breakpoint
-- Copying values and folding statuses are not edits, so pause the updated_at
-- trigger while they run.
DROP TRIGGER `leads_set_updated_at`;
--> statement-breakpoint
UPDATE `leads` SET `product` = `policy_product` WHERE `product` <> `policy_product`;
--> statement-breakpoint
-- 3. "Active Client" is retired: a Closed Won lead is an active client.
UPDATE `leads` SET `status` = 'Closed Won' WHERE `status` = 'Active Client';
--> statement-breakpoint
CREATE TRIGGER `leads_set_updated_at` AFTER UPDATE ON `leads` WHEN new.updated_at = old.updated_at BEGIN
	UPDATE `leads` SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = new.id;
END;
--> statement-breakpoint
-- 4. Browser push: notifications remember when they were pushed. Everything
-- already in the bell counts as pushed, so nobody gets a burst of old alerts.
ALTER TABLE `notifications` ADD `pushed_at` text;
--> statement-breakpoint
UPDATE `notifications` SET `pushed_at` = `created_at` WHERE `pushed_at` IS NULL;
