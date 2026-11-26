ALTER TABLE `notifications` ADD `whatsapp_at` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `whatsapp_msg_id` text;--> statement-breakpoint
CREATE INDEX `notifications_whatsapp_idx` ON `notifications` (`whatsapp_msg_id`) WHERE "notifications"."whatsapp_msg_id" is not null;--> statement-breakpoint
ALTER TABLE `profiles` ADD `whatsapp_phone` text;--> statement-breakpoint
ALTER TABLE `profiles` ADD `whatsapp_on` integer DEFAULT false NOT NULL;