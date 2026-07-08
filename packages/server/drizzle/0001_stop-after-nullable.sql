PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sandboxes` (
	`sandbox_id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`state` text NOT NULL,
	`node_id` text NOT NULL,
	`freeze_after_seconds` integer NOT NULL,
	`stop_after_seconds` integer,
	`archive_after_seconds` integer,
	`created_at` text NOT NULL,
	`last_active_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sandboxes`("sandbox_id", "user_key", "state", "node_id", "freeze_after_seconds", "stop_after_seconds", "archive_after_seconds", "created_at", "last_active_at") SELECT "sandbox_id", "user_key", "state", "node_id", "freeze_after_seconds", "stop_after_seconds", "archive_after_seconds", "created_at", "last_active_at" FROM `sandboxes`;--> statement-breakpoint
DROP TABLE `sandboxes`;--> statement-breakpoint
ALTER TABLE `__new_sandboxes` RENAME TO `sandboxes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sandboxes_user_key_unique` ON `sandboxes` (`user_key`);