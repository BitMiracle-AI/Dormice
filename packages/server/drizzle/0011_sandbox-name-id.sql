ALTER TABLE `sandboxes` RENAME COLUMN `sandbox_id` TO `id`;--> statement-breakpoint
ALTER TABLE `sandboxes` RENAME COLUMN `external_id` TO `name`;--> statement-breakpoint
DROP INDEX `sandboxes_external_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `sandboxes_name_unique` ON `sandboxes` (`name`);--> statement-breakpoint
ALTER TABLE `activity` RENAME COLUMN `external_id` TO `sandbox_name`;
