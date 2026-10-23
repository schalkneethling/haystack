CREATE TABLE `enrichment_failures` (
	`bookmark_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`attempts` integer NOT NULL,
	`consecutive_failures` integer NOT NULL,
	`last_error` text NOT NULL,
	`last_attempt_at` integer NOT NULL,
	PRIMARY KEY(`bookmark_id`, `schema_version`),
	FOREIGN KEY (`bookmark_id`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `enrichments` (
	`id` text PRIMARY KEY NOT NULL,
	`bookmark_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`kind` text NOT NULL,
	`kind_probabilities` text NOT NULL,
	`data` text NOT NULL,
	`match_text` text NOT NULL,
	`match_text_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bookmark_id`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrichments_bookmark_id_schema_version_unique` ON `enrichments` (`bookmark_id`,`schema_version`);--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `sensitive_canonical_dropped` integer;