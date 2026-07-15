CREATE TABLE `fleet_snapshots` (
	`at` text PRIMARY KEY NOT NULL,
	`active` integer NOT NULL,
	`frozen` integer NOT NULL,
	`stopped` integer NOT NULL,
	`archived` integer NOT NULL,
	`restoring` integer NOT NULL,
	`total` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sandbox_metrics_samples` (
	`sandbox_id` text NOT NULL,
	`at` text NOT NULL,
	`cpu_count` real NOT NULL,
	`cpu_used_pct` real NOT NULL,
	`mem_used_bytes` integer NOT NULL,
	`mem_total_bytes` integer NOT NULL,
	`mem_cache_bytes` integer NOT NULL,
	`disk_used_bytes` integer NOT NULL,
	`disk_total_bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sandbox_metrics_samples_sandbox_at_idx` ON `sandbox_metrics_samples` (`sandbox_id`,`at`);--> statement-breakpoint
CREATE INDEX `sandbox_metrics_samples_at_idx` ON `sandbox_metrics_samples` (`at`);