import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const TaskTable = sqliteTable(
  "task",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    prompt: text().notNull(),
    schedule_kind: text().notNull(),
    schedule_expr: text().notNull(),
    next_run_at: integer(),
    last_run_at: integer(),
    last_status: text(),
    status: text().notNull(),
    model: text(),
    agent: text().notNull(),
    workdir: text(),
    repeat_remaining: integer(),
    silent_marker: text().notNull(),
    timeout_ms: integer().notNull(),
    max_retries: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("task_status_next_idx").on(table.status, table.next_run_at),
    index("task_name_idx").on(table.name),
  ],
)

export const TaskRunTable = sqliteTable(
  "task_run",
  {
    id: text().primaryKey(),
    task_id: text()
      .notNull()
      .references(() => TaskTable.id, { onDelete: "cascade" }),
    started_at: integer().notNull(),
    finished_at: integer(),
    session_id: text(),
    status: text().notNull(),
    summary: text(),
    error: text(),
    attempts: integer().notNull().default(1),
    cancelled_at: integer(),
  },
  (table) => [
    index("task_run_task_started_idx").on(table.task_id, table.started_at),
  ],
)

export const TaskRunStepTable = sqliteTable(
  "task_run_step",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => TaskRunTable.id, { onDelete: "cascade" }),
    at: integer().notNull(),
    kind: text().notNull(),
    message: text().notNull(),
  },
  (table) => [index("task_run_step_run_at_idx").on(table.run_id, table.at)],
)
