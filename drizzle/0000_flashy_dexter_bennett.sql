CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`weight_bps` integer NOT NULL,
	`order_index` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `flashcards` (
	`id` text PRIMARY KEY NOT NULL,
	`task_statement_id` text NOT NULL,
	`front` text NOT NULL,
	`back` text NOT NULL,
	`bloom_level` integer NOT NULL,
	`ease_factor` real DEFAULT 2.5 NOT NULL,
	`interval_days` real DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`reviews_count` integer DEFAULT 0 NOT NULL,
	`last_reviewed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`task_statement_id`) REFERENCES `task_statements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mastery_snapshots` (
	`task_statement_id` text NOT NULL,
	`bloom_level` integer NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`task_statement_id`, `bloom_level`),
	FOREIGN KEY (`task_statement_id`) REFERENCES `task_statements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mock_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`question_ids` text NOT NULL,
	`answers` text NOT NULL,
	`scenario_ids` text NOT NULL,
	`raw_score` integer,
	`scaled_score` integer,
	`passed` integer
);
--> statement-breakpoint
CREATE TABLE `preparation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`step_id` text NOT NULL,
	`artifact_text` text NOT NULL,
	`grade` real,
	`feedback` text,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `preparation_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `preparation_exercises` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`domains_reinforced` text NOT NULL,
	`order_index` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preparation_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`exercise_id` text NOT NULL,
	`step_idx` integer NOT NULL,
	`prompt` text NOT NULL,
	`rubric` text,
	FOREIGN KEY (`exercise_id`) REFERENCES `preparation_exercises`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `progress_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`kind` text NOT NULL,
	`task_statement_id` text NOT NULL,
	`bloom_level` integer NOT NULL,
	`success` integer NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`task_statement_id`) REFERENCES `task_statements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`stem` text NOT NULL,
	`options` text NOT NULL,
	`correct_index` integer NOT NULL,
	`explanations` text NOT NULL,
	`task_statement_id` text NOT NULL,
	`scenario_id` text,
	`difficulty` integer NOT NULL,
	`bloom_level` integer NOT NULL,
	`bloom_justification` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`task_statement_id`) REFERENCES `task_statements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `scenario_domain_map` (
	`scenario_id` text NOT NULL,
	`domain_id` text NOT NULL,
	`is_primary` integer NOT NULL,
	PRIMARY KEY(`scenario_id`, `domain_id`),
	FOREIGN KEY (`scenario_id`) REFERENCES `scenarios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`order_index` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`api_key_encrypted` text,
	`default_model` text DEFAULT 'claude-sonnet-4-6' NOT NULL,
	`cheap_model` text DEFAULT 'claude-haiku-4-5-20251001' NOT NULL,
	`token_budget_month_usd` real DEFAULT 50 NOT NULL,
	`bulk_cost_ceiling_usd` real DEFAULT 1 NOT NULL,
	`review_half_life_days` real DEFAULT 14 NOT NULL,
	`dark_mode` integer DEFAULT false NOT NULL,
	`ingest_pdf_hash` text,
	`ingested_at` integer
);
--> statement-breakpoint
CREATE TABLE `task_statements` (
	`id` text PRIMARY KEY NOT NULL,
	`domain_id` text NOT NULL,
	`title` text NOT NULL,
	`knowledge_bullets` text NOT NULL,
	`skills_bullets` text NOT NULL,
	`order_index` integer NOT NULL,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tutor_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`messages` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
