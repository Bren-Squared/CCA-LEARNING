CREATE TABLE `bulk_gen_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`anthropic_batch_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_n` integer NOT NULL,
	`targets` text NOT NULL,
	`cost_projected_cents` integer NOT NULL,
	`cost_actual_cents` integer,
	`succeeded_count` integer DEFAULT 0 NOT NULL,
	`rejected_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`submitted_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`ended_at` integer,
	`processed_at` integer
);
