CREATE TABLE `templates` (
	`name` text PRIMARY KEY NOT NULL,
	`image` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `template` text;