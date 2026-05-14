import { describe, expect, test } from "bun:test"
import { validate, MIN_INTERVAL_MS, nextAfter } from "../../src/task/cron"
import { Task } from "../../src/task/task"

describe("cron.validate", () => {
  test("rejects sub-minute intervals", () => {
    expect(() => validate({ kind: "interval", expr: "every 30s" })).toThrow(/1 minute/)
    expect(() => validate({ kind: "interval", expr: "every 5s" })).toThrow(/1 minute/)
  })

  test("rejects sub-minute delays", () => {
    expect(() => validate({ kind: "delay", expr: "45s" })).toThrow(/1 minute/)
  })

  test("accepts >= 1 minute schedules", () => {
    expect(() => validate({ kind: "interval", expr: "every 1m" })).not.toThrow()
    expect(() => validate({ kind: "interval", expr: "every 2h" })).not.toThrow()
    expect(() => validate({ kind: "delay", expr: "1d" })).not.toThrow()
    expect(() => validate({ kind: "cron", expr: "0 9 * * 1-5" })).not.toThrow()
  })

  test("constant matches expected ms", () => {
    expect(MIN_INTERVAL_MS).toBe(60_000)
  })

  test("nextAfter advances", () => {
    const now = 1_700_000_000_000
    const next = nextAfter({ kind: "interval", expr: "every 5m" }, now)
    expect(next).toBe(now + 300_000)
  })
})

describe("Task DB ops", () => {
  test("create / get / list / pause / resume / remove", () => {
    const info = Task.create({
      name: "test-task",
      prompt: "hello world",
      schedule: { kind: "interval", expr: "every 5m" },
      model: "ollama/foo",
    })
    expect(info.id).toMatch(/^tsk_/)
    expect(info.status).toBe("active")
    expect(Task.get(info.id).name).toBe("test-task")
    expect(Task.list().some((t) => t.id === info.id)).toBe(true)

    const paused = Task.pause(info.id)
    expect(paused.status).toBe("paused")

    const resumed = Task.resume(info.id)
    expect(resumed.status).toBe("active")

    Task.remove(info.id)
    expect(() => Task.get(info.id)).toThrow()
  })

  test("recordStep + steps + bumpAttempts + activeRun + cancel", () => {
    const info = Task.create({
      name: "cancel-me",
      prompt: "loop forever",
      schedule: { kind: "interval", expr: "every 5m" },
      model: "ollama/foo",
    })
    const run = Task.startRun({ task: info, sessionID: "ses_test" })
    expect(run.status).toBe("running")
    expect(run.attempts).toBe(1)

    Task.recordStep({ runID: run.id, kind: "info", message: "started" })
    Task.recordStep({ runID: run.id, kind: "tool_running", message: "running bash" })
    Task.recordStep({ runID: run.id, kind: "retry", message: "retrying" })
    Task.bumpAttempts(run.id)

    const steps = Task.steps(run.id)
    expect(steps).toHaveLength(3)
    expect(steps.map((s) => s.kind)).toEqual(["info", "tool_running", "retry"])
    expect(steps[0].message).toBe("started")

    expect(Task.activeRun(info.id)?.id).toBe(run.id)
    expect(Task.activeRun(info.id)?.attempts).toBe(2)

    const cancelled = Task.cancel(info.id)
    expect(cancelled?.id).toBe(run.id)
    expect(cancelled?.status).toBe("failed")
    expect(cancelled?.cancelled_at).toBeGreaterThan(0)
    expect(cancelled?.error).toBe("cancelled by user")

    expect(Task.activeRun(info.id)).toBeNull()
    const finalSteps = Task.steps(run.id)
    expect(finalSteps[finalSteps.length - 1].kind).toBe("cancelled")

    Task.remove(info.id)
  })

  test("cancel returns null when no active run", () => {
    const info = Task.create({
      name: "no-run",
      prompt: "nothing",
      schedule: { kind: "delay", expr: "2h" },
      model: "ollama/foo",
    })
    expect(Task.cancel(info.id)).toBeNull()
    Task.remove(info.id)
  })

  test("create rejects sub-minute schedule", () => {
    expect(() =>
      Task.create({
        name: "too-fast",
        prompt: "x",
        schedule: { kind: "interval", expr: "every 20s" },
        model: "ollama/foo",
      }),
    ).toThrow(/1 minute/)
  })

  test("dueNow only returns active tasks past their next_run_at", () => {
    const info = Task.create({
      name: "due-soon",
      prompt: "x",
      schedule: { kind: "delay", expr: "1m" },
      model: "ollama/foo",
    })
    const before = Task.dueNow(Date.now())
    expect(before.some((t) => t.id === info.id)).toBe(false)

    const after = Task.dueNow(Date.now() + 120_000)
    expect(after.some((t) => t.id === info.id)).toBe(true)

    Task.pause(info.id)
    const paused = Task.dueNow(Date.now() + 120_000)
    expect(paused.some((t) => t.id === info.id)).toBe(false)

    Task.remove(info.id)
  })

  test("dueNow skips tasks that already have a running run", () => {
    const info = Task.create({
      name: "busy-task",
      prompt: "x",
      schedule: { kind: "interval", expr: "every 5m" },
      model: "ollama/foo",
    })
    Task.queueImmediate(info.id)
    expect(Task.dueNow().some((t) => t.id === info.id)).toBe(true)

    Task.startRun({ task: info, sessionID: "ses_busy" })
    expect(Task.dueNow().some((t) => t.id === info.id)).toBe(false)

    Task.cancel(info.id)
    expect(Task.dueNow().some((t) => t.id === info.id)).toBe(true)

    Task.remove(info.id)
  })

  test("recoverInterrupted fails stuck runs and advances next_run_at", () => {
    const info = Task.create({
      name: "ghost-task",
      prompt: "x",
      schedule: { kind: "interval", expr: "every 5m" },
      model: "ollama/foo",
    })
    const before = Task.get(info.id).next_run_at!
    const run = Task.startRun({ task: info, sessionID: "ses_ghost" })
    expect(Task.activeRun(info.id)?.id).toBe(run.id)

    const recovered = Task.recoverInterrupted("test-restart")
    expect(recovered).toBeGreaterThanOrEqual(1)
    expect(Task.activeRun(info.id)).toBeNull()

    const runs = Task.runs(info.id)
    const same = runs.find((r) => r.id === run.id)
    expect(same?.status).toBe("failed")
    expect(same?.error).toBe("test-restart")
    expect(same?.cancelled_at).toBeGreaterThan(0)

    const after = Task.get(info.id)
    expect(after.last_status).toBe("failed")
    expect(after.next_run_at!).toBeGreaterThanOrEqual(before)

    Task.remove(info.id)
  })
})
