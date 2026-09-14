CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`disabled_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_active_name_idx` ON `api_keys` (`name`) WHERE "api_keys"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `console_account` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`session_secret` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`sandbox_cpus` real NOT NULL,
	`sandbox_memory_gb` real NOT NULL,
	`sandbox_disk_gb` real NOT NULL,
	`default_freeze_after_seconds` integer NOT NULL,
	`default_stop_after_seconds` integer,
	`default_archive_after_seconds` integer,
	`s3_endpoint` text,
	`s3_bucket` text,
	`s3_access_key_id` text,
	`s3_secret_access_key` text,
	`s3_region` text,
	`s3_force_path_style` integer,
	`sandbox_domain` text,
	`sandbox_domain_aliases` text NOT NULL,
	`pids_limit` integer NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`name` text PRIMARY KEY NOT NULL,
	`image` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `nodes` ADD `swap_gb` integer DEFAULT 0 NOT NULL;