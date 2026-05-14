CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`schedule_kind` text NOT NULL,
	`schedule_expr` text NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_status` text,
	`status` text NOT NULL,
	`model` text,
	`agent` text NOT NULL,
	`workdir` text,
	`repeat_remaining` integer,
	`silent_marker` text NOT NULL,
	`timeout_ms` integer NOT NULL,
	`max_retries` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_status_next_idx` ON `task` (`status`,`next_run_at`);
--> statement-breakpoint
CREATE INDEX `task_name_idx` ON `task` (`name`);
--> statement-breakpoint
CREATE TABLE `task_run` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`session_id` text,
	`status` text NOT NULL,
	`summary` text,
	`error` text,
	CONSTRAINT `fk_task_run_task_id_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `task_run_task_started_idx` ON `task_run` (`task_id`,`started_at`);
