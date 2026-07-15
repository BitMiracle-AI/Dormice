ALTER TABLE `templates` ADD `updated_at` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `templates` SET `updated_at` = `created_at`;