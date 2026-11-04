ALTER TABLE `leads` ADD `office_lead_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `leads_office_lead_id_idx` ON `leads` (`office_lead_id`);