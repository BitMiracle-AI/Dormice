ALTER TABLE `nodes` ADD `last_check_in_at` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `interval_seconds` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `config_version` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `build` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `reading` text;