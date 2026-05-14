import z from "zod"
import { randomBytes } from "crypto"
import { Database, NotFoundError, eq, and, desc, asc } from "../storage/db"
import { TaskTable, TaskRunTable, TaskRunStepTable } from "./task.sql"
import { GlobalBus } from "../bus/global"
import { BusEvent } from "../bus/bus-event"
import { Memory } from "../memory/memory"
import { Log } from "../util/log"
import { nextAfter, describe, recurrence, validate, type Schedule, type ScheduleKind } from "./cron"

const log = Log.create({ service: "task" })

export namespace Task {
  export const Status = z.enum(["active", "paused"])
  export type Status = z.infer<typeof Status>

  export const RunStatus = z.enum(["running", "completed", "failed", "silent"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const Kind = z.enum(["cron", "interval", "iso", "delay"])

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      prompt: z.string(),
      schedule: z.object({
        kind: Kind,
        expr: z.string(),
      }),
      status: Status,
      next_run_at: z.number().nullable(),
      last_run_at: z.number().nullable(),
      last_status: z.string().nullable(),
      model: z.string().nullable(),
      agent: z.string(),
      workdir: z.string().nullable(),
      repeat_remaining: z.number().nullable(),
      silent_marker: z.string(),
      timeout_ms: z.number(),
      max_retries: z.number(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
      }),
    })
    .meta({ ref: "Task" })
  export type Info = z.infer<typeof Info>

  export const Run = z
    .object({
      id: z.string(),
      task_id: z.string(),
      started_at: z.number(),
      finished_at: z.number().nullable(),
      session_id: z.string().nullable(),
      status: RunStatus,
      summary: z.string().nullable(),
      error: z.string().nullable(),
      attempts: z.number(),
      cancelled_at: z.number().nullable(),
    })
    .meta({ ref: "TaskRun" })
  export type Run = z.infer<typeof Run>

  export const StepKind = z.enum([
    "info",
    "tool_running",
    "tool_completed",
    "tool_error",
    "retry",
    "timeout",
    "cancelled",
    "summary",
    "error",
  ])
  export type StepKind = z.infer<typeof StepKind>

  export const Step = z
    .object({
      id: z.string(),
      run_id: z.string(),
      at: z.number(),
      kind: StepKind,
      message: z.string(),
    })
    .meta({ ref: "TaskRunStep" })
  export type Step = z.infer<typeof Step>

  export const Created = BusEvent.define("task.created", z.object({ info: Info }))
  export const Updated = BusEvent.define("task.updated", z.object({ info: Info }))
  export const Removed = BusEvent.define("task.removed", z.object({ id: z.string() }))
  export const RunStarted = BusEvent.define("task.run.started", z.object({ run: Run, task: Info }))
  export const RunCompleted = BusEvent.define("task.run.completed", z.object({ run: Run, task: Info }))
  export const RunProgress = BusEvent.define(
    "task.run.progress",
    z.object({
      run_id: z.string(),
      task_id: z.string(),
      step: z.string(),
      kind: StepKind,
      at: z.number(),
    }),
  )

  export function publishProgress(input: {
    run_id: string
    task_id: string
    step: string
    kind?: StepKind
  }): void {
    emit(RunProgress, {
      run_id: input.run_id,
      task_id: input.task_id,
      step: input.step,
      kind: input.kind ?? "info",
      at: Date.now(),
    })
  }

  export const CreateInput = z.object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1),
    schedule: z.object({
      kind: Kind,
      expr: z.string().min(1),
    }),
    model: z.string().optional(),
    agent: z.string().optional(),
    workdir: z.string().optional(),
    repeat: z.number().int().positive().optional(),
    silent_marker: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_retries: z.number().int().nonnegative().optional(),
    status: Status.optional(),
  })
  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = CreateInput.partial()
  export type UpdateInput = z.infer<typeof UpdateInput>

  function id() {
    return "tsk_" + randomBytes(16).toString("hex")
  }

  function runId() {
    return "tsr_" + randomBytes(16).toString("hex")
  }

  function stepId() {
    return "tss_" + randomBytes(16).toString("hex")
  }

  function fromRow(row: typeof TaskTable.$inferSelect): Info {
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      schedule: { kind: row.schedule_kind as ScheduleKind, expr: row.schedule_expr },
      status: row.status as Status,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      last_status: row.last_status,
      model: row.model,
      agent: row.agent,
      workdir: row.workdir,
      repeat_remaining: row.repeat_remaining,
      silent_marker: row.silent_marker,
      timeout_ms: row.timeout_ms,
      max_retries: row.max_retries,
      time: {
        created: row.time_created,
        updated: row.time_updated,
      },
    }
  }

  function runFromRow(row: typeof TaskRunTable.$inferSelect): Run {
    return {
      id: row.id,
      task_id: row.task_id,
      started_at: row.started_at,
      finished_at: row.finished_at,
      session_id: row.session_id,
      status: row.status as RunStatus,
      summary: row.summary,
      error: row.error,
      attempts: row.attempts ?? 1,
      cancelled_at: row.cancelled_at,
    }
  }

  function stepFromRow(row: typeof TaskRunStepTable.$inferSelect): Step {
    return {
      id: row.id,
      run_id: row.run_id,
      at: row.at,
      kind: row.kind as StepKind,
      message: row.message,
    }
  }

  function emit<D extends BusEvent.Definition>(def: D, properties: z.infer<D["properties"]>) {
    GlobalBus.emit("event", {
      payload: { type: def.type, properties },
    })
  }

  function nameFor(input: { name?: string; prompt: string }) {
    if (input.name && input.name.trim()) return input.name.trim()
    const first = input.prompt.split(/\r?\n/)[0].trim()
    return first.length > 60 ? first.slice(0, 60) + "…" : first || "Untitled task"
  }

  export function create(input: CreateInput): Info {
    const parsed = CreateInput.parse(input)
    const schedule: Schedule = parsed.schedule
    validate(schedule)

    const now = Date.now()
    const next = nextAfter(schedule, now)
    const repeat =
      parsed.repeat !== undefined
        ? parsed.repeat
        : recurrence(schedule.kind) === "once"
          ? 1
          : null

    const row = {
      id: id(),
      name: nameFor(parsed),
      prompt: parsed.prompt,
      schedule_kind: schedule.kind,
      schedule_expr: schedule.expr,
      next_run_at: next,
      last_run_at: null,
      last_status: null,
      status: parsed.status ?? ("active" as const),
      model: parsed.model ?? null,
      agent: parsed.agent ?? "build",
      workdir: parsed.workdir ?? null,
      repeat_remaining: repeat,
      silent_marker: parsed.silent_marker ?? "[SILENT]",
      timeout_ms: parsed.timeout_ms ?? 30 * 60_000,
      max_retries: parsed.max_retries ?? 1,
      time_created: now,
      time_updated: now,
    }

    Database.use((db) => db.insert(TaskTable).values(row).run())
    const info = fromRow(row as any)
    void writeWiki(info).catch((err) => log.error("wiki write failed", { err }))
    emit(Created, { info })
    return info
  }

  export function get(taskID: string): Info {
    const row = Database.use((db) => db.select().from(TaskTable).where(eq(TaskTable.id, taskID)).get())
    if (!row) throw new NotFoundError({ message: `Task not found: ${taskID}` })
    return fromRow(row)
  }

  export function list(): Info[] {
    const rows = Database.use((db) =>
      db.select().from(TaskTable).orderBy(desc(TaskTable.time_updated)).all(),
    )
    return rows.map(fromRow)
  }

  export function update(taskID: string, input: UpdateInput): Info {
    const parsed = UpdateInput.parse(input)
    const cur = get(taskID)
    const now = Date.now()
    const schedule: Schedule = parsed.schedule ?? cur.schedule
    if (parsed.schedule) validate(schedule)

    const scheduleChanged =
      !!parsed.schedule && (parsed.schedule.kind !== cur.schedule.kind || parsed.schedule.expr !== cur.schedule.expr)
    const next = scheduleChanged ? nextAfter(schedule, now) : cur.next_run_at
    const repeat =
      parsed.repeat !== undefined
        ? parsed.repeat
        : scheduleChanged
          ? recurrence(schedule.kind) === "once"
            ? 1
            : null
          : cur.repeat_remaining

    const patch = {
      name: parsed.name !== undefined ? nameFor({ name: parsed.name, prompt: parsed.prompt ?? cur.prompt }) : cur.name,
      prompt: parsed.prompt ?? cur.prompt,
      schedule_kind: schedule.kind,
      schedule_expr: schedule.expr,
      next_run_at: next,
      status: parsed.status ?? cur.status,
      model: parsed.model !== undefined ? parsed.model || null : cur.model,
      agent: parsed.agent ?? cur.agent,
      workdir: parsed.workdir !== undefined ? parsed.workdir || null : cur.workdir,
      repeat_remaining: repeat,
      silent_marker: parsed.silent_marker ?? cur.silent_marker,
      timeout_ms: parsed.timeout_ms ?? cur.timeout_ms,
      max_retries: parsed.max_retries ?? cur.max_retries,
      time_updated: now,
    }

    Database.use((db) => db.update(TaskTable).set(patch).where(eq(TaskTable.id, taskID)).run())
    const info = get(taskID)
    void writeWiki(info).catch((err) => log.error("wiki write failed", { err }))
    emit(Updated, { info })
    return info
  }

  export function remove(taskID: string): void {
    const cur = get(taskID)
    Database.use((db) => db.delete(TaskTable).where(eq(TaskTable.id, taskID)).run())
    void removeWiki(cur).catch((err) => log.error("wiki remove failed", { err }))
    emit(Removed, { id: taskID })
  }

  export function pause(taskID: string): Info {
    return update(taskID, { status: "paused" })
  }

  export function queueImmediate(taskID: string): Info {
    get(taskID)
    const now = Date.now()
    Database.use((db) =>
      db
        .update(TaskTable)
        .set({ next_run_at: now, status: "active", time_updated: now })
        .where(eq(TaskTable.id, taskID))
        .run(),
    )
    const info = get(taskID)
    emit(Updated, { info })
    return info
  }

  export function resume(taskID: string): Info {
    const cur = get(taskID)
    const next = nextAfter(cur.schedule, Date.now())
    Database.use((db) =>
      db
        .update(TaskTable)
        .set({ status: "active", next_run_at: next, time_updated: Date.now() })
        .where(eq(TaskTable.id, taskID))
        .run(),
    )
    const info = get(taskID)
    void writeWiki(info).catch((err) => log.error("wiki write failed", { err }))
    emit(Updated, { info })
    return info
  }

  export function dueNow(now = Date.now()): Info[] {
    const rows = Database.use((db) =>
      db
        .select()
        .from(TaskTable)
        .where(and(eq(TaskTable.status, "active")))
        .all(),
    )
    const candidates = rows.map(fromRow).filter((t) => t.next_run_at !== null && t.next_run_at <= now)
    if (candidates.length === 0) return candidates
    const busy = new Set(
      Database.use((db) =>
        db
          .select({ task_id: TaskRunTable.task_id })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.status, "running"))
          .all(),
      ).map((row) => row.task_id),
    )
    return candidates.filter((t) => !busy.has(t.id))
  }

  export function runs(taskID: string, limit = 50): Run[] {
    const rows = Database.use((db) =>
      db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.task_id, taskID))
        .orderBy(desc(TaskRunTable.started_at))
        .limit(limit)
        .all(),
    )
    return rows.map(runFromRow)
  }

  export function startRun(input: { task: Info; sessionID?: string }): Run {
    const row = {
      id: runId(),
      task_id: input.task.id,
      started_at: Date.now(),
      finished_at: null,
      session_id: input.sessionID ?? null,
      status: "running" as const,
      summary: null,
      error: null,
      attempts: 1,
      cancelled_at: null,
    }
    Database.use((db) => db.insert(TaskRunTable).values(row).run())
    const run = runFromRow(row as any)
    emit(RunStarted, { run, task: input.task })
    return run
  }

  export function finishRun(input: {
    runID: string
    status: RunStatus
    summary?: string | null
    error?: string | null
    sessionID?: string | null
    cancelled?: boolean
  }): Run {
    const now = Date.now()
    Database.use((db) =>
      db
        .update(TaskRunTable)
        .set({
          finished_at: now,
          status: input.status,
          summary: input.summary ?? null,
          error: input.error ?? null,
          session_id: input.sessionID ?? null,
          ...(input.cancelled ? { cancelled_at: now } : {}),
        })
        .where(eq(TaskRunTable.id, input.runID))
        .run(),
    )
    const row = Database.use((db) => db.select().from(TaskRunTable).where(eq(TaskRunTable.id, input.runID)).get())
    if (!row) throw new NotFoundError({ message: `Run not found: ${input.runID}` })
    const run = runFromRow(row)
    const task = get(run.task_id)
    emit(RunCompleted, { run, task })
    return run
  }

  export function bumpAttempts(runID: string): void {
    const row = Database.use((db) => db.select().from(TaskRunTable).where(eq(TaskRunTable.id, runID)).get())
    if (!row) return
    Database.use((db) =>
      db
        .update(TaskRunTable)
        .set({ attempts: (row.attempts ?? 1) + 1 })
        .where(eq(TaskRunTable.id, runID))
        .run(),
    )
  }

  export function recordStep(input: { runID: string; kind: StepKind; message: string }): Step {
    const row = {
      id: stepId(),
      run_id: input.runID,
      at: Date.now(),
      kind: input.kind,
      message: input.message,
    }
    Database.use((db) => db.insert(TaskRunStepTable).values(row).run())
    const run = Database.use((db) => db.select().from(TaskRunTable).where(eq(TaskRunTable.id, input.runID)).get())
    if (run) {
      emit(RunProgress, {
        run_id: input.runID,
        task_id: run.task_id,
        step: input.message,
        kind: input.kind,
        at: row.at,
      })
    }
    return stepFromRow(row as any)
  }

  export function steps(runID: string, limit = 500): Step[] {
    const rows = Database.use((db) =>
      db
        .select()
        .from(TaskRunStepTable)
        .where(eq(TaskRunStepTable.run_id, runID))
        .orderBy(asc(TaskRunStepTable.at))
        .limit(limit)
        .all(),
    )
    return rows.map(stepFromRow)
  }

  export function activeRun(taskID: string): Run | null {
    const row = Database.use((db) =>
      db
        .select()
        .from(TaskRunTable)
        .where(and(eq(TaskRunTable.task_id, taskID), eq(TaskRunTable.status, "running")))
        .orderBy(desc(TaskRunTable.started_at))
        .limit(1)
        .get(),
    )
    return row ? runFromRow(row) : null
  }

  export function cancel(taskID: string): Run | null {
    const run = activeRun(taskID)
    if (!run) return null
    recordStep({ runID: run.id, kind: "cancelled", message: "cancelled by user" })
    return finishRun({
      runID: run.id,
      status: "failed",
      error: "cancelled by user",
      sessionID: run.session_id,
      cancelled: true,
    })
  }

  /**
   * Mark every run still in `running` state as failed (interrupted).
   * Called at scheduler start so ghost runs left over from a crash or
   * forced quit don't linger in the UI as perpetually "running". For each
   * affected run we also push the task's next_run_at forward so the task
   * isn't stuck firing every tick after a hard crash.
   */
  export function recoverInterrupted(reason = "interrupted (server restart)"): number {
    const rows = Database.use((db) =>
      db.select().from(TaskRunTable).where(eq(TaskRunTable.status, "running")).all(),
    )
    if (rows.length === 0) return 0
    const now = Date.now()
    const seen = new Set<string>()
    for (const row of rows) {
      recordStep({ runID: row.id, kind: "cancelled", message: reason })
      Database.use((db) =>
        db
          .update(TaskRunTable)
          .set({ finished_at: now, status: "failed", error: reason, cancelled_at: now })
          .where(eq(TaskRunTable.id, row.id))
          .run(),
      )
      if (seen.has(row.task_id)) continue
      seen.add(row.task_id)
      const task = Database.use((db) =>
        db.select().from(TaskTable).where(eq(TaskTable.id, row.task_id)).get(),
      )
      if (!task) continue
      const schedule: Schedule = { kind: task.schedule_kind as ScheduleKind, expr: task.schedule_expr }
      const next = nextAfter(schedule, now)
      Database.use((db) =>
        db
          .update(TaskTable)
          .set({ last_run_at: now, last_status: "failed", next_run_at: next, time_updated: now })
          .where(eq(TaskTable.id, row.task_id))
          .run(),
      )
    }
    log.info("recovered interrupted runs", { count: rows.length })
    return rows.length
  }

  export function recordRunResult(input: {
    taskID: string
    status: RunStatus
    summary?: string | null
    attempts?: number
    sessionID?: string | null
  }): Info {
    const cur = get(input.taskID)
    const now = Date.now()
    const repeat = cur.repeat_remaining === null ? null : Math.max(0, cur.repeat_remaining - 1)
    const exhausted = repeat !== null && repeat <= 0
    const nextStatus: Status = exhausted ? "paused" : cur.status
    const next = exhausted ? null : nextAfter(cur.schedule, now)
    Database.use((db) =>
      db
        .update(TaskTable)
        .set({
          last_run_at: now,
          last_status: input.status,
          next_run_at: next,
          repeat_remaining: repeat,
          status: nextStatus,
          time_updated: now,
        })
        .where(eq(TaskTable.id, input.taskID))
        .run(),
    )
    const info = get(input.taskID)
    void appendWikiRun(info, input.status, input.summary, input.attempts, input.sessionID).catch((err) =>
      log.error("wiki append failed", { err }),
    )
    emit(Updated, { info })
    return info
  }

  function slugify(input: string): string {
    return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  }

  function wikiPath(info: Info): string {
    const slug = slugify(info.name) || "task"
    return `tasks/${slug}-${info.id.slice(-8)}.md`
  }

  async function writeWiki(info: Info): Promise<void> {
    const next = info.next_run_at ? new Date(info.next_run_at).toISOString() : "(not scheduled)"
    const body = [
      `# ${info.name}`,
      "",
      `- id: \`${info.id}\``,
      `- schedule: ${describe(info.schedule)} (${info.schedule.kind})`,
      `- status: ${info.status}`,
      `- model: ${info.model ?? "(default)"}`,
      `- agent: ${info.agent}`,
      `- next: ${next}`,
      "",
      "## Prompt",
      "",
      info.prompt,
      "",
      "## Recent runs",
      "",
      "(populated as the task fires)",
      "",
    ].join("\n")
    await Memory.write(wikiPath(info), body)
  }

  async function appendWikiRun(
    info: Info,
    status: RunStatus,
    summary?: string | null,
    attempts?: number,
    sessionID?: string | null,
  ): Promise<void> {
    if (status === "silent") return
    const stamp = new Date().toISOString()
    const head = summary ? summary.split(/\r?\n/)[0].slice(0, 200) : ""
    const meta: string[] = []
    if (attempts && attempts > 1) meta.push(`${attempts} attempts`)
    if (sessionID) meta.push(`session: ${sessionID}`)
    const tail = meta.length > 0 ? ` (${meta.join(", ")})` : ""
    const line = `- ${stamp} ${status}${tail}${head ? " — " + head : ""}`
    await Memory.append(wikiPath(info), line)
  }

  async function removeWiki(info: Info): Promise<void> {
    const fs = await import("fs/promises")
    const path = await import("path")
    const root = Memory.root()
    const full = path.join(root, wikiPath(info))
    await fs.unlink(full).catch(() => undefined)
  }
}
