-- Open tabs poll this one row (see src/server/data/changes.ts) and re-render
-- only when it moves. Bumped at most once a second so bulk writes cost one
-- extra row write, not one per row.
CREATE TABLE `change_version` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `change_version` (`id`, `version`) VALUES (1, CAST(strftime('%s', 'now') AS integer));
--> statement-breakpoint
CREATE TRIGGER `leads_bump_change_version_insert` AFTER INSERT ON `leads`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `leads_bump_change_version_update` AFTER UPDATE ON `leads`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `leads_bump_change_version_delete` AFTER DELETE ON `leads`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `lead_notes_bump_change_version_insert` AFTER INSERT ON `lead_notes`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `lead_notes_bump_change_version_update` AFTER UPDATE ON `lead_notes`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `lead_notes_bump_change_version_delete` AFTER DELETE ON `lead_notes`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `lead_note_reads_bump_change_version_insert` AFTER INSERT ON `lead_note_reads`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `lead_note_reads_bump_change_version_update` AFTER UPDATE ON `lead_note_reads`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `lead_note_reads_bump_change_version_delete` AFTER DELETE ON `lead_note_reads`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `events_bump_change_version_insert` AFTER INSERT ON `events`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `events_bump_change_version_update` AFTER UPDATE ON `events`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `events_bump_change_version_delete` AFTER DELETE ON `events`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `notifications_bump_change_version_insert` AFTER INSERT ON `notifications`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `notifications_bump_change_version_update` AFTER UPDATE ON `notifications`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `notifications_bump_change_version_delete` AFTER DELETE ON `notifications`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `profiles_bump_change_version_insert` AFTER INSERT ON `profiles`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `profiles_bump_change_version_update` AFTER UPDATE ON `profiles`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `profiles_bump_change_version_delete` AFTER DELETE ON `profiles`
WHEN (SELECT `version` FROM `change_version` WHERE `id` = 1) < CAST(strftime('%s', 'now') AS integer) BEGIN
  UPDATE `change_version` SET `version` = CAST(strftime('%s', 'now') AS integer) WHERE `id` = 1;
END;
