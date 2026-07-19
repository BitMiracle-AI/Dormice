CREATE TABLE `runtime_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`max_sandboxes` integer NOT NULL,
	`sandbox_cpus` real NOT NULL,
	`sandbox_memory_gb` real NOT NULL,
	`sandbox_disk_gb` real NOT NULL,
	`default_freeze_after_seconds` integer NOT NULL,
	`default_stop_after_seconds` integer,
	`default_archive_after_seconds` integer,
	`updated_at` text
);
