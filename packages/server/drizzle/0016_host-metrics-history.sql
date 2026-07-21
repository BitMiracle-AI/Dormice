CREATE TABLE `host_metrics_samples` (
	`at` text PRIMARY KEY NOT NULL,
	`cpu_used_pct` real,
	`mem_total_bytes` integer NOT NULL,
	`mem_available_bytes` integer NOT NULL,
	`swap_total_bytes` integer,
	`swap_used_bytes` integer,
	`disk_total_bytes` integer,
	`disk_used_bytes` integer,
	`disk_available_bytes` integer
);
