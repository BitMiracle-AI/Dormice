CREATE TABLE `sandboxes` (
	`sandbox_id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`state` text NOT NULL,
	`node_id` text NOT NULL,
	`freeze_after_seconds` integer NOT NULL,
	`stop_after_seconds` integer NOT NULL,
	`archive_after_seconds` integer,
	`created_at` text NOT NULL,
	`last_active_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandboxes_user_key_unique` ON `sandboxes` (`user_key`);