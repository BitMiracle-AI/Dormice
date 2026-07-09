ALTER TABLE `sandboxes` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `envs` text;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `deadline_at` text;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `on_deadline` text;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `paused_by_user` integer DEFAULT false NOT NULL;