-- Duplicate search, rules that need no knowledge of the signed-in user, and
-- seed data. Access rules live in src/server/data, not here.

-- Trigram index over normalized company names, replacing pg_trgm. It finds
-- candidates; src/server/data/duplicates.ts scores them.
CREATE VIRTUAL TABLE `leads_name_fts` USING fts5(
	`client_name_normalized`,
	content = 'leads',
	content_rowid = 'id',
	tokenize = 'trigram'
);
--> statement-breakpoint
CREATE TRIGGER `leads_name_fts_insert` AFTER INSERT ON `leads` BEGIN
	INSERT INTO `leads_name_fts` (rowid, `client_name_normalized`) VALUES (new.id, new.client_name_normalized);
END;
--> statement-breakpoint
CREATE TRIGGER `leads_name_fts_delete` AFTER DELETE ON `leads` BEGIN
	INSERT INTO `leads_name_fts` (`leads_name_fts`, rowid, `client_name_normalized`) VALUES ('delete', old.id, old.client_name_normalized);
END;
--> statement-breakpoint
CREATE TRIGGER `leads_name_fts_update` AFTER UPDATE OF `client_name_normalized` ON `leads` BEGIN
	INSERT INTO `leads_name_fts` (`leads_name_fts`, rowid, `client_name_normalized`) VALUES ('delete', old.id, old.client_name_normalized);
	INSERT INTO `leads_name_fts` (rowid, `client_name_normalized`) VALUES (new.id, new.client_name_normalized);
END;
--> statement-breakpoint

-- updated_at, unless the writer set it explicitly.
CREATE TRIGGER `profiles_set_updated_at` AFTER UPDATE ON `profiles` WHEN new.updated_at = old.updated_at BEGIN
	UPDATE `profiles` SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = new.id;
END;
--> statement-breakpoint
CREATE TRIGGER `leads_set_updated_at` AFTER UPDATE ON `leads` WHEN new.updated_at = old.updated_at BEGIN
	UPDATE `leads` SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = new.id;
END;
--> statement-breakpoint
CREATE TRIGGER `events_set_updated_at` AFTER UPDATE ON `events` WHEN new.updated_at = old.updated_at BEGIN
	UPDATE `events` SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `id` = new.id;
END;
--> statement-breakpoint
CREATE TRIGGER `ai_model_pricing_set_updated_at` AFTER UPDATE ON `ai_model_pricing` WHEN new.updated_at = old.updated_at BEGIN
	UPDATE `ai_model_pricing` SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `model_name` = new.model_name;
END;
--> statement-breakpoint
CREATE TRIGGER `app_settings_set_updated_at` AFTER UPDATE ON `app_settings` WHEN new.updated_at = old.updated_at BEGIN
	UPDATE `app_settings` SET `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `key` = new.key;
END;
--> statement-breakpoint

-- There is always at least one active admin.
CREATE TRIGGER `profiles_keep_last_admin_update` BEFORE UPDATE OF `role`, `is_active` ON `profiles`
WHEN old.role = 'ADMIN' AND old.is_active = 1 AND (new.role <> 'ADMIN' OR new.is_active = 0)
	AND (SELECT count(*) FROM `profiles` WHERE `role` = 'ADMIN' AND `is_active` = 1) <= 1
BEGIN
	SELECT RAISE(ABORT, 'The last active admin cannot be removed');
END;
--> statement-breakpoint
CREATE TRIGGER `profiles_keep_last_admin_delete` BEFORE DELETE ON `profiles`
WHEN old.role = 'ADMIN' AND old.is_active = 1
	AND (SELECT count(*) FROM `profiles` WHERE `role` = 'ADMIN' AND `is_active` = 1) <= 1
BEGIN
	SELECT RAISE(ABORT, 'The last active admin cannot be removed');
END;
--> statement-breakpoint

-- Seed data, as in the Supabase migrations.
INSERT INTO `renewal_milestone_offsets` (`milestone`, `offset_seconds`, `sort_order`) VALUES
	('T-30 Days', 2592000, 1),
	('T-10 Days', 864000, 2),
	('T-5 Days', 432000, 3),
	('T-3 Days', 259200, 4),
	('T-24 Hours', 86400, 5),
	('T-10 Hours', 36000, 6),
	('T-1 Hour', 3600, 7),
	('T-30 Minutes', 1800, 8),
	('T-5 Minutes', 300, 9);
--> statement-breakpoint
INSERT INTO `app_settings` (`key`, `value`, `description`) VALUES
	('usd_to_inr', '83.5', 'Exchange rate used to convert Gemini USD pricing to INR'),
	('renewal_due_time', '"10:00"', 'Local time of day a policy is treated as due on its renewal date (HH:MM)'),
	('timezone', '"Asia/Kolkata"', 'Business timezone for renewal dates and reminders'),
	('round_robin_cursor', '0', 'Position of the next agent in bulk-import round-robin'),
	('ai_hourly_limit_per_user', '200', 'Maximum Gemini calls a user can make per hour');
--> statement-breakpoint
INSERT INTO `ai_model_pricing` (`model_name`, `display_name`, `input_usd_per_million`, `output_usd_per_million`) VALUES
	('gemini-3.5-flash', 'Gemini 3.5 Flash', 0.075, 0.30),
	('gemini-2.5-flash', 'Gemini 2.5 Flash', 0.075, 0.30),
	('gemini-2.5-pro', 'Gemini 2.5 Pro', 1.25, 5.00),
	('gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)', 2.00, 12.00);
