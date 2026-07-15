CREATE TABLE `daemon_secrets` (
	`id` integer PRIMARY KEY NOT NULL,
	`envd_signing_secret` text NOT NULL,
	`created_at` text NOT NULL
);
