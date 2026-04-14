CREATE TABLE `scenario_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_id` text NOT NULL,
	`answer_text` text NOT NULL,
	`overall_score` real NOT NULL,
	`feedback` text NOT NULL,
	`progress_event_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `scenario_prompts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`progress_event_id`) REFERENCES `progress_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scenario_attempts_prompt_idx` ON `scenario_attempts` (`prompt_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `scenario_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`scenario_id` text NOT NULL,
	`task_statement_id` text NOT NULL,
	`bloom_level` integer NOT NULL,
	`prompt_text` text NOT NULL,
	`rubric` text,
	`rubric_generated_at` integer,
	`order_index` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_statement_id`) REFERENCES `task_statements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scenario_prompts_scenario_idx` ON `scenario_prompts` (`scenario_id`,`order_index`);