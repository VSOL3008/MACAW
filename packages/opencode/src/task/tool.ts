import z from "zod"
import { Tool } from "../tool/tool"
import { Task } from "./task"
import { isCronContext } from "./scheduler"

const Action = z.enum(["create", "update", "list", "get", "pause", "resume", "run", "remove", "history"])

const parameters = z.object({
  action: Action.describe("Operation to perform on tasks."),
  id: z.string().optional().describe("Task id (required for update/get/pause/resume/run/remove/history)."),
  name: z.string().optional().describe("Display name. Defaults to first line of the prompt."),
  prompt: z.string().optional().describe("Self-contained instruction the scheduled agent will run in a fresh session."),
  schedule: z
    .object({
      kind: z.enum(["cron", "interval", "iso", "delay"]),
      expr: z
        .string()
        .describe(
          "kind=cron: 5-field expression (e.g. '0 9 * * 1-5'); interval: 'every 2h' / 'every 30m'; delay: '30m'/'2h'/'1d'; iso: ISO timestamp.",
        ),
    })
    .optional()
    .describe(
      "Normalized schedule. If the user described the timing in natural language, you must convert it to one of these forms. Pick interval for recurring at fixed period, cron for clock-aligned recurring, delay for one-shot in N minutes/hours/days, iso for one-shot at a specific time.",
    ),
  model: z.string().optional().describe("Per-task model override, e.g. 'lmstudio/llama-3.1-8b'."),
  agent: z.string().optional().describe("Agent name. Defaults to 'build' (Macaw)."),
  workdir: z.string().optional().describe("Absolute working directory for the cron run. Optional."),
  repeat: z.number().int().positive().optional().describe("How many times to fire. Omit for forever on recurring schedules."),
  silent_marker: z.string().optional().describe("Override the silent suppression marker (default '[SILENT]')."),
  timeout_ms: z.number().int().positive().optional().describe("Per-run timeout in ms. Default 1800000 (30 minutes)."),
  max_retries: z.number().int().nonnegative().optional().describe("Retries on failure. Default 1."),
  status: z.enum(["active", "paused"]).optional().describe("Initial status when creating; usually omitted."),
  limit: z.number().int().positive().max(200).optional().describe("Limit for history."),
})

const DESCRIPTION = `Default scheduler for MACAW. Use this for ANY user request that involves running something on a schedule, after a delay, or repeatedly: "every 20 seconds create a file", "every weekday at 9am summarize my inbox", "in 30 minutes remind me", "every 2 hours check the build", etc.
DO NOT use Windows Task Scheduler (schtasks, Register-ScheduledTask) or external cron unless the user explicitly says "Windows scheduled task" or "must run when I am not logged in". MACAW tasks run inside this app, persist across restarts, and catch up missed runs on startup.
Schedule shapes:
  interval — schedule.expr like "every 20s", "every 5m", "every 2h" (recurring fixed period).
  cron     — 5-field expression like "0 9 * * 1-5" (clock-aligned recurring).
  delay    — schedule.expr like "30m", "2h", "1d" (one-shot after delay).
  iso      — ISO-8601 timestamp (one-shot at exact time).
The prompt runs in a fresh session with no chat history; make it fully self-contained (target paths, filenames, exact tools to call). Tasks are mirrored into the MACAW wiki under tasks/ automatically.`

type Meta = { id?: string; action: string; count?: number }

export const TaskCronTool = Tool.define("task_cron", {
  description: DESCRIPTION,
  parameters,
  async execute(input): Promise<{ title: string; output: string; metadata: Meta }> {
    if (isCronContext()) {
      throw new Error("task_cron is disabled inside scheduled task runs to prevent recursion.")
    }
    const action = input.action

    if (action === "create") {
      if (!input.prompt) throw new Error("'prompt' is required for create")
      if (!input.schedule) throw new Error("'schedule' is required for create")
      if (!input.model) {
        return {
          title: "model required",
          output:
            "Cannot create task without a model. " +
            "Ask the user via the `question` tool which model to use (single-select from the providers/models you currently see in your context), " +
            "then call `task_cron` again with `model: \"provider/modelID\"`. Do not pick a model silently.",
          metadata: { action },
        }
      }
      const info = Task.create({
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        model: input.model,
        agent: input.agent,
        workdir: input.workdir,
        repeat: input.repeat,
        silent_marker: input.silent_marker,
        timeout_ms: input.timeout_ms,
        max_retries: input.max_retries,
        status: input.status,
      })
      return {
        title: `task: ${info.name}`,
        output: format(info),
        metadata: { id: info.id, action },
      }
    }

    if (action === "list") {
      const items = Task.list()
      const body = items.length === 0 ? "(no tasks)" : items.map(line).join("\n")
      return {
        title: `tasks (${items.length})`,
        output: body,
        metadata: { action, count: items.length },
      }
    }

    if (!input.id) throw new Error(`'id' is required for action '${action}'`)

    if (action === "get") {
      const info = Task.get(input.id)
      return { title: info.name, output: format(info), metadata: { id: info.id, action } }
    }
    if (action === "update") {
      const info = Task.update(input.id, {
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        model: input.model,
        agent: input.agent,
        workdir: input.workdir,
        repeat: input.repeat,
        silent_marker: input.silent_marker,
        timeout_ms: input.timeout_ms,
        max_retries: input.max_retries,
        status: input.status,
      })
      return { title: `updated: ${info.name}`, output: format(info), metadata: { id: info.id, action } }
    }
    if (action === "pause") {
      const info = Task.pause(input.id)
      return { title: `paused: ${info.name}`, output: format(info), metadata: { id: info.id, action } }
    }
    if (action === "resume") {
      const info = Task.resume(input.id)
      return { title: `resumed: ${info.name}`, output: format(info), metadata: { id: info.id, action } }
    }
    if (action === "run") {
      const info = Task.queueImmediate(input.id)
      return {
        title: `queued: ${info.name}`,
        output: `Queued '${info.name}' to run on the next scheduler tick.`,
        metadata: { id: info.id, action },
      }
    }
    if (action === "remove") {
      Task.remove(input.id)
      return { title: "removed", output: `Removed task ${input.id}.`, metadata: { id: input.id, action } }
    }
    if (action === "history") {
      const runs = Task.runs(input.id, input.limit ?? 20)
      const body = runs.length === 0 ? "(no runs yet)" : runs.map(runLine).join("\n")
      return { title: `history (${runs.length})`, output: body, metadata: { id: input.id, action, count: runs.length } }
    }
    throw new Error(`unknown action: ${action}`)
  },
})

function format(info: Task.Info): string {
  const next = info.next_run_at ? new Date(info.next_run_at).toISOString() : "(unscheduled)"
  const last = info.last_run_at ? new Date(info.last_run_at).toISOString() : "(never)"
  return [
    `id: ${info.id}`,
    `name: ${info.name}`,
    `status: ${info.status}`,
    `schedule: ${info.schedule.kind} '${info.schedule.expr}'`,
    `next: ${next}`,
    `last: ${last} (${info.last_status ?? "—"})`,
    `model: ${info.model ?? "(default)"}, agent: ${info.agent}`,
    info.workdir ? `workdir: ${info.workdir}` : null,
    `repeat_remaining: ${info.repeat_remaining ?? "∞"}`,
    "",
    "prompt:",
    info.prompt,
  ]
    .filter((x) => x !== null)
    .join("\n")
}

function line(info: Task.Info): string {
  const next = info.next_run_at ? new Date(info.next_run_at).toISOString() : "—"
  return `- [${info.status}] ${info.id} | ${info.name} | ${info.schedule.kind}:${info.schedule.expr} | next ${next}`
}

function runLine(run: Task.Run): string {
  const dur =
    run.finished_at && run.started_at ? `${Math.round((run.finished_at - run.started_at) / 1000)}s` : "running"
  const stamp = new Date(run.started_at).toISOString()
  const head = run.summary ? run.summary.split(/\r?\n/)[0].slice(0, 120) : run.error ? run.error.slice(0, 120) : ""
  return `- ${stamp} ${run.status} (${dur})${head ? " — " + head : ""}`
}
