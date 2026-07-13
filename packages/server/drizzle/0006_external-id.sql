ALTER TABLE `sandboxes` RENAME COLUMN `user_key` TO `external_id`;--> statement-breakpoint
DROP INDEX `sandboxes_user_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `sandboxes_external_id_unique` ON `sandboxes` (`external_id`);--> statement-breakpoint
ALTER TABLE `activity` RENAME COLUMN `user_key` TO `external_id`;--> statement-breakpoint
UPDATE `activity` SET `kind` = 'destroyed' WHERE `kind` = 'released';
