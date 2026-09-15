CREATE TABLE `fleet_state_samples` (
	`at` text NOT NULL,
	`active` integer NOT NULL,
	`frozen` integer NOT NULL,
	`stopped` integer NOT NULL,
	`archived` integer NOT NULL,
	`restoring` integer NOT NULL,
	`total` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fleet_state_samples_at_idx` ON `fleet_state_samples` (`at`);