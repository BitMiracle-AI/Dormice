CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`user_key` text,
	`sandbox_id` text,
	`detail` text NOT NULL
);
