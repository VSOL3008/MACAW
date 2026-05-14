import { AsyncLocalStorage } from "async_hooks"
import { Instance } from "../project/instance"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Provider } from "../provider/provider"
import type { ProviderID, ModelID } from "../provider/schema"
import { GlobalBus } from "../bus/global"
import { Log } from "../util/log"
import { Task } from "./task"
import * as Ollama from "./ollama"
import { Memory } from "../memory/memory"
import { AppFileSystem } from "../filesystem"
import path from "path"

const log = Log.create({ service: "task.scheduler" })

const TICK_MS = 60_000
const BACKOFF_MS = [5_000, 20_000, 60_000]
const PROGRESS_THROTTLE_MS = 500

const cronContext = new AsyncLocalStorage<{ taskID: string }>()

export function isCronContext(): boolean {
  return cronContext.getStore() !== undefined
}

let started = false
let timer: ReturnType<typeof setInterval> | undefined
let stopping = false

const inflight = new Set<string>()
const aborters = new Map<string, AbortController>()

export function start(): void {
  if (started) return
  started = true
  stopping = false
  log.info("starting task scheduler")
  try {
    Task.recoverInterrupted()
  } catch (err) {
    log.error("recoverInterrupted failed", { err })
  }
  void catchUp()
  timer = setInterval(() => {
    if (stopping) return
    void tick()
  }, TICK_MS)
}

export async function stop(): Promise<void> {
  if (!started) return
  stopping = true
  if (timer) clearInterval(timer)
  timer = undefined
  for (const ctl of aborters.values()) ctl.abort()
  const deadline = Date.now() + 3000
  while (inflight.size > 0 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50))
  }
  if (inflight.size > 0) {
    log.warn("draining timed out, marking inflight runs as failed", { count: inflight.size })
    try {
      Task.recoverInterrupted("interrupted (server shutting down)")
    } catch (err) {
      log.error("forced recovery failed", { err })
    }
  }
  inflight.clear()
  aborters.clear()
  started = false
  stopping = false
}

async function catchUp(): Promise<void> {
  const due = safeList()
  if (due.length === 0) return
  log.info("catch-up sweep", { count: due.length })
  await fanOut(due)
}

async function tick(): Promise<void> {
  const due = safeList()
  if (due.length === 0) return
  await fanOut(due)
}

async function fanOut(due: Task.Info[]): Promise<void> {
  const next = due.filter((task) => !inflight.has(task.id))
  if (next.length === 0) return
  await Promise.allSettled(next.map((task) => runOne(task)))
}

function safeList(): Task.Info[] {
  try {
    return Task.dueNow()
  } catch (err) {
    log.error("dueNow failed", { err })
    return []
  }
}

async function runOne(task: Task.Info): Promise<void> {
  if (inflight.has(task.id)) return
  inflight.add(task.id)
  const dir = task.workdir ?? process.cwd()
  await Instance.provide({
    directory: dir,
    fn: () => cronContext.run({ taskID: task.id }, () => execute(task)),
  })
    .catch((err) => log.error("instance.provide failed", { taskID: task.id, err }))
    .finally(() => {
      inflight.delete(task.id)
    })
}

type Tracker = {
  emit(kind: Task.StepKind, step: string): void
  detach(): void
}

function track(run: Task.Run, sessionID: string): Tracker {
  let last = ""
  let lastAt = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  let pendingKind: Task.StepKind = "info"

  const flush = (kind: Task.StepKind, step: string) => {
    if (step === last) return
    last = step
    lastAt = Date.now()
    Task.recordStep({ runID: run.id, kind, message: step })
  }

  const schedule = (kind: Task.StepKind, step: string) => {
    const now = Date.now()
    const wait = Math.max(0, PROGRESS_THROTTLE_MS - (now - lastAt))
    if (pending) clearTimeout(pending)
    pendingKind = kind
    if (wait === 0) return flush(kind, step)
    pending = setTimeout(() => flush(pendingKind, step), wait)
  }

  const handler = (envelope: { directory?: string; payload?: { type: string; properties: any } }) => {
    const payload = envelope?.payload
    if (!payload) return

    if (payload.type === "session.status") {
      if (payload.properties.sessionID !== sessionID) return
      const status = payload.properties.status
      if (status?.type === "busy") schedule("info", "thinking")
      else if (status?.type === "retry")
        schedule("info", `retrying (attempt ${status.attempt}): ${status.message}`)
      return
    }

    if (payload.type === "permission.asked") {
      if (payload.properties.sessionID !== sessionID) return
      const names = (payload.properties.patterns ?? []).slice(0, 2).join(", ")
      const label = payload.properties.permission ?? "unknown"
      schedule("info", `waiting for permission: ${label}${names ? ` (${names})` : ""}`)
      return
    }

    if (payload.type === "message.part.updated") {
      if (payload.properties.sessionID !== sessionID) return
      const part = payload.properties.part
      if (part?.type === "tool") {
        const tool = part.tool ?? "tool"
        const status = part.state?.status
        if (status === "running") schedule("tool_running", `running ${tool}`)
        else if (status === "pending") schedule("tool_running", `preparing ${tool}`)
        else if (status === "completed") schedule("tool_completed", `finished ${tool}`)
        else if (status === "error")
          schedule("tool_error", `failed ${tool}: ${part.state.error?.slice(0, 80) ?? ""}`)
        return
      }
      if (part?.type === "reasoning") schedule("info", "thinking")
      else if (part?.type === "text") schedule("info", "writing response")
    }
  }

  GlobalBus.on("event", handler)

  return {
    emit: (kind, step) => {
      if (kind === "summary" || kind === "error" || kind === "timeout" || kind === "cancelled") return flush(kind, step)
      schedule(kind, step)
    },
    detach: () => {
      GlobalBus.off("event", handler)
      if (pending) clearTimeout(pending)
    },
  }
}

async function execute(task: Task.Info): Promise<void> {
  log.info("running task", { id: task.id, name: task.name })
  const run = Task.startRun({ task })

  const fresh = await Session.create({ title: `Task: ${task.name}`, permission: perms(task) }).catch((err) => {
    log.error("session create failed", { err })
    return undefined
  })
  if (!fresh) {
    Task.recordStep({ runID: run.id, kind: "error", message: "could not create session" })
    Task.finishRun({ runID: run.id, status: "failed", error: "Could not create session" })
    Task.recordRunResult({ taskID: task.id, status: "failed", attempts: 1 })
    return
  }

  const tracker = track(run, fresh.id)
  Task.recordStep({ runID: run.id, kind: "info", message: `started in session ${fresh.id}` })
  try {
    await preflight(task, run, tracker)
    await runWithRetry(task, run, fresh.id, tracker)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error("unhandled task error", { id: task.id, err: msg })
    Task.recordStep({ runID: run.id, kind: "error", message: msg })
    Task.finishRun({ runID: run.id, status: "failed", error: msg, sessionID: fresh.id })
    Task.recordRunResult({ taskID: task.id, status: "failed", attempts: 1, sessionID: fresh.id })
  } finally {
    tracker.detach()
  }
}

function perms(task: Task.Info) {
  const dirs = [task.workdir, Memory.root()].filter((dir): dir is string => Boolean(dir))
  return dirs.map((dir) => ({
    permission: "external_directory",
    action: "allow" as const,
    pattern: glob(dir),
  }))
}

function glob(dir: string): string {
  const next = path.join(dir, "*")
  if (process.platform !== "win32") return next.replaceAll("\\", "/")
  return AppFileSystem.normalizePathPattern(next)
}

async function preflight(task: Task.Info, run: Task.Run, tracker: Tracker): Promise<void> {
  const parsed = task.model ? parseModel(task.model) : undefined
  if (!parsed || parsed.providerID !== "ollama") return
  tracker.emit("info", `loading model ${parsed.modelID}`)
  const result = await Ollama.ensureReady(parsed.modelID).catch(() => "skipped" as const)
  if (result === "warmed") tracker.emit("info", `model ${parsed.modelID} warmed`)
  else if (result === "skipped") tracker.emit("info", `model warm-up unavailable, proceeding`)
  void run
}

async function runWithRetry(task: Task.Info, run: Task.Run, sessionID: string, tracker: Tracker): Promise<void> {
  const maxAttempts = task.max_retries + 1
  let lastErr: unknown
  let attempt = 0
  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    if (stopping) {
      Task.recordStep({ runID: run.id, kind: "cancelled", message: "server shutting down" })
      Task.finishRun({ runID: run.id, status: "failed", error: "Server shutting down", sessionID, cancelled: true })
      Task.recordRunResult({ taskID: task.id, status: "failed", attempts: attempt, sessionID })
      return
    }

    if (attempt > 1) Task.bumpAttempts(run.id)

    const ctl = new AbortController()
    aborters.set(run.id, ctl)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      ctl.abort()
      void SessionPrompt.cancel(sessionID as any).catch(() => undefined)
    }, task.timeout_ms)

    const tried = await runPrompt(task, sessionID).catch((err) => {
      lastErr = err
      return undefined
    })
    clearTimeout(timeout)
    aborters.delete(run.id)

    if (timedOut) {
      tracker.emit("timeout", `timed out after ${Math.round(task.timeout_ms / 1000)}s`)
      lastErr = new Error(`timed out after ${Math.round(task.timeout_ms / 1000)}s`)
    } else if (tried) {
      const text = tried.text
      const silent = task.silent_marker.length > 0 && text.trim().startsWith(task.silent_marker)
      const status: Task.RunStatus = silent ? "silent" : "completed"
      tracker.emit("summary", text ? text.split(/\r?\n/)[0].slice(0, 200) : status)
      Task.finishRun({ runID: run.id, status, summary: text || null, sessionID })
      Task.recordRunResult({ taskID: task.id, status, summary: text, attempts: attempt, sessionID })
      return
    }

    if (attempt >= maxAttempts) break
    const retryable = timedOut ? true : isRetryable(lastErr)
    if (!retryable) break

    const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]
    const errMsg = errorOf(lastErr)
    tracker.emit("retry", `retrying (${attempt}/${task.max_retries}) in ${Math.round(wait / 1000)}s: ${errMsg.slice(0, 80)}`)
    log.warn("task attempt failed, retrying", { id: task.id, attempt, wait, err: errMsg })
    await new Promise((done) => setTimeout(done, wait))
  }

  const err = errorOf(lastErr)
  tracker.emit("error", err)
  Task.finishRun({ runID: run.id, status: "failed", error: err, sessionID })
  Task.recordRunResult({ taskID: task.id, status: "failed", attempts: attempt - 1, sessionID })
}

function errorOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err ?? "unknown error")
}

const RETRYABLE_HINTS = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "fetch failed",
  "ZlibError",
  "model not found",
  "loading model",
  "model is loading",
  "service unavailable",
  "503",
  "502",
  "504",
  "429",
]

const NON_RETRYABLE_HINTS = ["unauthorized", "401", "403", "schema", "invalid argument", "cancelled"]

function isRetryable(err: unknown): boolean {
  const text = errorOf(err).toLowerCase()
  if (!text) return false
  if (NON_RETRYABLE_HINTS.some((hint) => text.includes(hint.toLowerCase()))) return false
  if (RETRYABLE_HINTS.some((hint) => text.includes(hint.toLowerCase()))) return true
  return true
}

async function runPrompt(task: Task.Info, sessionID: string): Promise<{ text: string } | undefined> {
  const model = task.model ? parseModel(task.model) : undefined
  const parts = await SessionPrompt.resolvePromptParts(task.prompt)
  const result = await SessionPrompt.prompt({
    sessionID: sessionID as any,
    agent: task.agent,
    model,
    parts,
  })
  const text = result.parts.findLast((p) => p.type === "text")?.text ?? ""
  return { text }
}

function parseModel(input: string): { providerID: ProviderID; modelID: ModelID } | undefined {
  try {
    return Provider.parseModel(input)
  } catch (err) {
    log.warn("invalid model on task", { input, err })
    return undefined
  }
}
