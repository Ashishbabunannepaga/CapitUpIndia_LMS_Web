ALTER TABLE `leads` ADD `app_user_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `leads_app_user_id_idx` ON `leads` (`app_user_id`);