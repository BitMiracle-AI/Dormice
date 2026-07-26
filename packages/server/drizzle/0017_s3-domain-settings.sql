ALTER TABLE `runtime_settings` ADD `s3_endpoint` text;--> statement-breakpoint
ALTER TABLE `runtime_settings` ADD `s3_bucket` text;--> statement-breakpoint
ALTER TABLE `runtime_settings` ADD `s3_access_key_id` text;--> statement-breakpoint
ALTER TABLE `runtime_settings` ADD `s3_secret_access_key` text;--> statement-breakpoint
ALTER TABLE `runtime_settings` ADD `s3_region` text;--> statement-breakpoint
ALTER TABLE `runtime_settings` ADD `s3_force_path_style` integer;--> statement-breakpoint
ALTER TABLE `runtime_settings` ADD `sandbox_domain` text;