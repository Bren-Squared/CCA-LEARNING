CREATE TABLE `mcq_review_state` (
	`question_id` text PRIMARY KEY NOT NULL,
	`ease_factor` real DEFAULT 2.5 NOT NULL,
	`interval_days` real DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`last_grade` integer NOT NULL,
	`reviews_count` integer DEFAULT 0 NOT NULL,
	`last_reviewed_at` integer,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcq_review_state_due_at_idx` ON `mcq_review_state` (`due_at`);--> statement-breakpoint
CREATE TABLE `user_skill` (
	`task_statement_id` text NOT NULL,
	`bloom_level` integer NOT NULL,
	`elo_rating` real DEFAULT 1500 NOT NULL,
	`elo_volatility` real DEFAULT 350 NOT NULL,
	`attempts_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`task_statement_id`, `bloom_level`),
	FOREIGN KEY (`task_statement_id`) REFERENCES `task_statements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `questions` ADD `knowledge_bullet_idxs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `skills_bullet_idxs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `elo_rating` real DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `elo_volatility` real DEFAULT 350 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `attempts_count` integer DEFAULT 0 NOT NULL;