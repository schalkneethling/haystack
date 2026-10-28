CREATE TABLE `eval_labels` (
	`eval_query_id` text NOT NULL,
	`bookmark_id` text NOT NULL,
	`relevant` integer NOT NULL,
	`labeled_at` integer NOT NULL,
	PRIMARY KEY(`eval_query_id`, `bookmark_id`),
	FOREIGN KEY (`eval_query_id`) REFERENCES `eval_queries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookmark_id`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `eval_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`query` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eval_queries_user_id_query_unique` ON `eval_queries` (`user_id`,`query`);--> statement-breakpoint
CREATE TABLE `search_answers` (
	`search_run_id` text NOT NULL,
	`bookmark_id` text NOT NULL,
	`noul` real,
	`score` real,
	`score_probabilities` text,
	`score_confidence` real,
	`shown` integer NOT NULL,
	`clicked` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`search_run_id`, `bookmark_id`),
	FOREIGN KEY (`search_run_id`) REFERENCES `search_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookmark_id`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "search_answers_score_complete" CHECK(("search_answers"."score" IS NULL) = ("search_answers"."score_probabilities" IS NULL) AND ("search_answers"."score" IS NULL) = ("search_answers"."score_confidence" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `search_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`query` text NOT NULL,
	`channel` text NOT NULL,
	`input_mode` text,
	`request_mode` text NOT NULL,
	`jev_model` text NOT NULL,
	`questions` text NOT NULL,
	`display_signal` text NOT NULL,
	`noul_threshold` real NOT NULL,
	`score_threshold` real NOT NULL,
	`input_tokens` integer,
	`latency_ms` integer,
	`outcome` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "search_runs_channel" CHECK("search_runs"."channel" IN ('web', 'webmcp', 'mcp', 'eval')),
	CONSTRAINT "search_runs_input_mode" CHECK("search_runs"."input_mode" IN ('typed', 'web-speech', 'whisper')),
	CONSTRAINT "search_runs_request_mode" CHECK("search_runs"."request_mode" IN ('pair', 'batched')),
	CONSTRAINT "search_runs_questions" CHECK("search_runs"."questions" IN ('both', 'noul', 'score')),
	CONSTRAINT "search_runs_display_signal" CHECK("search_runs"."display_signal" IN ('noul', 'score')),
	CONSTRAINT "search_runs_outcome" CHECK("search_runs"."outcome" IN ('ok', 'partial', 'failed'))
);
