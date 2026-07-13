CREATE TABLE `console_account` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`session_secret` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
