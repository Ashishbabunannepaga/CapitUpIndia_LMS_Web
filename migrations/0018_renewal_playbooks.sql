CREATE TABLE `playbook_tasks` (
	`step_id` integer NOT NULL,
	`lead_id` integer NOT NULL,
	`renewal_date` text NOT NULL,
	`task_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`step_id`, `lead_id`, `renewal_date`),
	FOREIGN KEY (`step_id`) REFERENCES `task_playbook_steps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `work_tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `task_playbook_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playbook_id` integer NOT NULL,
	`day_offset` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`playbook_id`) REFERENCES `task_playbooks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_playbook_steps_offset" CHECK("task_playbook_steps"."day_offset" between -365 and 60),
	CONSTRAINT "task_playbook_steps_title_len" CHECK(length(trim("task_playbook_steps"."title")) between 1 and 200),
	CONSTRAINT "task_playbook_steps_priority" CHECK("task_playbook_steps"."priority" in ('P1', 'P2', 'P3'))
);
--> statement-breakpoint
CREATE INDEX `task_playbook_steps_playbook_idx` ON `task_playbook_steps` (`playbook_id`,`day_offset`);--> statement-breakpoint
CREATE TABLE `task_playbooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`applies_to` text DEFAULT 'any' NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "task_playbooks_name_len" CHECK(length(trim("task_playbooks"."name")) between 1 and 80),
	CONSTRAINT "task_playbooks_scope" CHECK("task_playbooks"."applies_to" in ('any', 'Corporate', 'Retail'))
);
--> statement-breakpoint
INSERT INTO `task_playbooks` (`id`, `name`, `applies_to`, `active`) VALUES (1, 'Corporate renewal', 'Corporate', 0), (2, 'Retail renewal', 'Retail', 0);--> statement-breakpoint
INSERT INTO `task_playbook_steps` (`playbook_id`, `day_offset`, `title`, `description`, `priority`, `tags`) VALUES
  (1, -60, 'Collect last policy and employee list from {client}', 'Get the current policy copy, claims history and the updated employee list.', 'P2', 'renewal,docs'),
  (1, -45, 'Send {client} renewal to 3 insurers for quotes', 'Share the data with at least three insurers and note the quote due dates.', 'P2', 'renewal,quote'),
  (1, -30, 'Share the renewal quote comparison with {client}', 'Send the comparison and recommendation, and book a call to walk them through it.', 'P1', 'renewal,quote'),
  (1, -10, 'Get the renewal decision from {client}', 'Confirm the insurer and plan, and collect the proposal form and payment.', 'P1', 'renewal'),
  (1, -3, 'Renewal not confirmed yet: {client}', 'Three days left. Escalate if the client has not confirmed.', 'P1', 'renewal,urgent'),
  (2, -15, 'Send the renewal reminder to {client}', 'Share the renewal premium and the payment link.', 'P2', 'renewal'),
  (2, -5, 'Call {client} to confirm the renewal payment', '', 'P1', 'renewal'),
  (2, 1, 'Check {client} renewed and the policy is uploaded', 'Mark it Closed Won and upload the new policy.', 'P2', 'renewal,policy');
