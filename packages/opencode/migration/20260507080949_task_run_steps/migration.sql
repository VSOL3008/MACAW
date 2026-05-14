CREATE TABLE `task_run_step` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	CONSTRAINT `fk_task_run_step_run_id_task_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `task_run`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `task_run_step_run_at_idx` ON `task_run_step` (`run_id`,`at`);--> statement-breakpoint
ALTER TABLE `task_run` ADD `attempts` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_run` ADD `cancelled_at` integer;
