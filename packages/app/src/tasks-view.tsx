import type { Event as SdkEvent, Task as TaskInfo, TaskRun, TaskRunStep } from "@macaw/sdk/v2/client"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ServerConnection } from "@/context/server"
import { createSdkForServer } from "@/utils/server"
import { type Row, TurnRow } from "@/components/turn"

type ScheduleKind = "cron" | "interval" | "iso" | "delay"

type FormState = {
  id: string | null
  name: string
  prompt: string
  kind: ScheduleKind
  expr: string
  model: string
  agent: string
  workdir: string
  timeout_min: number
  max_retries: number
  repeat: string
  error: string
  saving: boolean
}

type Filter = "all" | "active" | "paused" | "failed"

const SCHEDULE_PRESETS: { kind: ScheduleKind; expr: string; label: string }[] = [
  { kind: "interval", expr: "every 1h", label: "every 1h" },
  { kind: "cron", expr: "0 9 * * 1-5", label: "weekday 9am" },
  { kind: "delay", expr: "30m", label: "in 30m" },
  { kind: "iso", expr: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16), label: "at +1h" },
]

const AGENTS = ["build", "file_shell", "zero_trust"]

function describe(s: { kind: ScheduleKind; expr: string }): string {
  if (s.kind === "interval") return s.expr
  if (s.kind === "delay") return `in ${s.expr}`
  if (s.kind === "iso") return `at ${s.expr}`
  return `cron ${s.expr}`
}

function fmt(time: number | null): string {
  if (!time) return "—"
  return new Date(time).toLocaleString()
}

function fmtTime(time: number | null): string {
  if (!time) return ""
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function relative(time: number | null): string {
  if (!time) return ""
  const diff = time - Date.now()
  const abs = Math.abs(diff)
  const future = diff > 0
  const m = Math.round(abs / 60000)
  if (m < 1) return future ? "in <1m" : "just now"
  if (m < 60) return future ? `in ${m}m` : `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return future ? `in ${h}h` : `${h}h ago`
  const d = Math.round(h / 24)
  return future ? `in ${d}d` : `${d}d ago`
}

function duration(run: TaskRun): string {
  if (!run.finished_at) return "running"
  const ms = run.finished_at - run.started_at
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

function emptyForm(): FormState {
  return {
    id: null,
    name: "",
    prompt: "",
    kind: "interval",
    expr: "every 1h",
    model: "",
    agent: "build",
    workdir: "",
    timeout_min: 30,
    max_retries: 1,
    repeat: "",
    error: "",
    saving: false,
  }
}

function formFromTask(task: TaskInfo): FormState {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    kind: task.schedule.kind,
    expr: task.schedule.expr,
    model: task.model ?? "",
    agent: task.agent,
    workdir: task.workdir ?? "",
    timeout_min: Math.max(1, Math.round(task.timeout_ms / 60_000)),
    max_retries: task.max_retries,
    repeat: task.repeat_remaining === null ? "" : String(task.repeat_remaining),
    error: "",
    saving: false,
  }
}

function validateExpr(kind: ScheduleKind, expr: string): string | null {
  if (!expr.trim()) return "expression is required"
  if (kind === "interval") {
    const m = /^\s*every\s+(\d+)\s*(ms|s|m|h|d|w)?\s*$/i.exec(expr)
    if (!m) return "use 'every 5m' / 'every 2h' / 'every 1d'"
    const n = Number(m[1])
    const u = (m[2] ?? "m").toLowerCase()
    const ms = u === "ms" ? n : u === "s" ? n * 1000 : u === "m" ? n * 60_000 : u === "h" ? n * 3_600_000 : u === "d" ? n * 86_400_000 : n * 604_800_000
    if (ms < 60_000) return "minimum interval is 1 minute"
  }
  if (kind === "delay") {
    const m = /^\s*(\d+)\s*(ms|s|m|h|d|w)?\s*$/i.exec(expr)
    if (!m) return "use '30m' / '2h' / '1d'"
    const n = Number(m[1])
    const u = (m[2] ?? "m").toLowerCase()
    const ms = u === "ms" ? n : u === "s" ? n * 1000 : u === "m" ? n * 60_000 : u === "h" ? n * 3_600_000 : u === "d" ? n * 86_400_000 : n * 604_800_000
    if (ms < 60_000) return "minimum delay is 1 minute"
  }
  if (kind === "cron") {
    if (expr.trim().split(/\s+/).length !== 5) return "cron must have 5 fields, e.g. '0 9 * * 1-5'"
  }
  if (kind === "iso") {
    const t = Date.parse(expr)
    if (!Number.isFinite(t)) return "use ISO timestamp, e.g. 2026-05-07T18:00"
  }
  return null
}

export function TasksView(props: {
  open: boolean
  onClose: () => void
  server: ServerConnection.HttpBase
  onOpenSession?: (sessionID: string) => void
  onEvent?: (handler: (event: SdkEvent) => void) => () => void
}) {
  const sdk = createMemo(() => createSdkForServer({ server: props.server }))

  const [state, setState] = createStore<{
    loading: boolean
    error: string | null
    tasks: TaskInfo[]
    selected: string | null
    runs: Record<string, TaskRun[]>
    progress: Record<string, { kind: string; step: string; at: number }>
    models: string[]
    expandedRun: string | null
    runSteps: Record<string, TaskRunStep[]>
    runMessages: Record<string, Row[]>
    runMessagesLoading: Record<string, boolean>
    search: string
    filter: Filter
  }>({
    loading: false,
    error: null,
    tasks: [],
    selected: null,
    runs: {},
    progress: {},
    models: [],
    expandedRun: null,
    runSteps: {},
    runMessages: {},
    runMessagesLoading: {},
    search: "",
    filter: "all",
  })

  const [tick, setTick] = createSignal(Date.now())
  const [form, setForm] = createSignal<FormState | null>(null)

  const selected = createMemo(() => state.tasks.find((t) => t.id === state.selected) ?? null)
  const selectedRuns = createMemo(() => (state.selected ? state.runs[state.selected] ?? [] : []))

  const counts = createMemo(() => {
    const out = { all: state.tasks.length, active: 0, paused: 0, failed: 0 }
    for (const task of state.tasks) {
      if (task.status === "active") out.active++
      if (task.status === "paused") out.paused++
      if (task.last_status === "failed") out.failed++
    }
    return out
  })

  const filtered = createMemo(() => {
    const q = state.search.trim().toLowerCase()
    const f = state.filter
    return state.tasks.filter((task) => {
      if (f === "active" && task.status !== "active") return false
      if (f === "paused" && task.status !== "paused") return false
      if (f === "failed" && task.last_status !== "failed") return false
      if (!q) return true
      return (
        task.name.toLowerCase().includes(q) ||
        task.prompt.toLowerCase().includes(q) ||
        task.id.toLowerCase().includes(q)
      )
    })
  })

  function liveStepFor(taskID: string): { kind: string; step: string } | null {
    const list = state.runs[taskID] ?? []
    const running = list.find((r) => r.status === "running")
    if (!running) return null
    const p = state.progress[running.id]
    return p ? { kind: p.kind, step: p.step } : { kind: "info", step: "starting" }
  }

  function upsertRun(run: TaskRun) {
    setState("runs", run.task_id, (list = []) => {
      const idx = list.findIndex((item) => item.id === run.id)
      if (idx === -1) return [run, ...list].slice(0, 50)
      const next = list.slice()
      next[idx] = run
      return next
    })
  }

  async function loadList() {
    setState("loading", true)
    setState("error", null)
    const res = await sdk()
      .global.task.list()
      .catch((err) => {
        setState("error", err instanceof Error ? err.message : String(err))
        return undefined
      })
    setState("loading", false)
    if (!res?.data) return
    setState("tasks", res.data)
    if (state.selected && !res.data.some((t) => t.id === state.selected)) {
      setState("selected", res.data[0]?.id ?? null)
    } else if (!state.selected && res.data.length > 0) {
      setState("selected", res.data[0].id)
    }
  }

  async function loadModels() {
    const res = await sdk()
      .global.config.get()
      .catch(() => undefined)
    const cfg = res?.data as { provider?: Record<string, { models?: Record<string, unknown> }> } | undefined
    if (!cfg) {
      setState("models", [])
      return
    }
    const out: string[] = []
    for (const [pid, prov] of Object.entries(cfg.provider ?? {})) {
      for (const mid of Object.keys(prov.models ?? {})) {
        out.push(`${pid}/${mid}`)
      }
    }
    setState("models", out.sort())
  }

  async function loadRuns(id: string) {
    const res = await sdk()
      .global.task.runs({ id, limit: 50 })
      .catch(() => undefined)
    setState("runs", id, res?.data ?? [])
  }

  async function loadSteps(taskID: string, runID: string) {
    const res = await sdk()
      .global.task.steps({ id: taskID, runID, limit: 1000 })
      .catch(() => undefined)
    setState("runSteps", runID, res?.data ?? [])
  }

  async function loadRunMessages(runID: string, sessionID: string) {
    if (state.runMessages[runID] || state.runMessagesLoading[runID]) return
    setState("runMessagesLoading", runID, true)
    const res = await sdk()
      .session.messages({ sessionID, limit: 500 })
      .catch(() => undefined)
    setState("runMessages", runID, (res?.data as Row[]) ?? [])
    setState("runMessagesLoading", runID, false)
  }

  async function pause(id: string) {
    await sdk().global.task.pause({ id }).catch((err) => setState("error", String(err)))
    void loadList()
  }

  async function resume(id: string) {
    await sdk().global.task.resume({ id }).catch((err) => setState("error", String(err)))
    void loadList()
  }

  async function runNow(id: string) {
    await sdk().global.task.run({ id }).catch((err) => setState("error", String(err)))
    void loadList()
  }

  async function cancel(id: string) {
    await sdk().global.task.cancel({ id }).catch((err) => setState("error", String(err)))
    if (state.selected) void loadRuns(state.selected)
  }

  async function remove(id: string) {
    if (!confirm("Delete this task?")) return
    await sdk().global.task.remove({ id }).catch((err) => setState("error", String(err)))
    void loadList()
  }

  function openCreate() {
    setForm(emptyForm())
  }

  function openEdit(task: TaskInfo) {
    setForm(formFromTask(task))
  }

  async function saveForm() {
    const f = form()
    if (!f) return
    if (!f.prompt.trim()) {
      setForm({ ...f, error: "prompt is required" })
      return
    }
    const exprErr = validateExpr(f.kind, f.expr)
    if (exprErr) {
      setForm({ ...f, error: exprErr })
      return
    }
    setForm({ ...f, error: "", saving: true })
    const body = {
      name: f.name.trim() || undefined,
      prompt: f.prompt,
      schedule: { kind: f.kind, expr: f.expr.trim() },
      model: f.model.trim() || undefined,
      agent: f.agent || undefined,
      workdir: f.workdir.trim() || undefined,
      timeout_ms: Math.max(1, f.timeout_min) * 60_000,
      max_retries: Math.max(0, f.max_retries),
      repeat: f.repeat.trim() ? Number(f.repeat) : undefined,
    }
    const res = f.id
      ? await sdk()
          .global.task.update({ id: f.id, ...body })
          .catch((err) => ({ error: err }))
      : await sdk()
          .global.task.create(body)
          .catch((err) => ({ error: err }))
    if ("error" in res && res.error) {
      const msg = res.error instanceof Error ? res.error.message : String(res.error)
      setForm({ ...f, saving: false, error: msg })
      return
    }
    setForm(null)
    void loadList()
  }

  let wasOpen = false
  createEffect(() => {
    const open = props.open
    if (open && !wasOpen) {
      void loadList()
      void loadModels()
    }
    wasOpen = open
  })

  createEffect(() => {
    const id = state.selected
    if (!id) return
    void loadRuns(id)
  })

  createEffect(() => {
    if (!props.open) return
    const handle = setInterval(() => setTick(Date.now()), 30_000)
    onCleanup(() => clearInterval(handle))
  })

  createEffect(() => {
    if (!props.open) return
    if (!props.onEvent) return
    const unsub = props.onEvent((payload) => {
      if (payload.type === "task.run.progress") {
        const p = payload.properties as { run_id: string; kind: string; step: string; at: number }
        const done = Object.values(state.runs)
          .flat()
          .some((run) => run.id === p.run_id && run.status !== "running")
        if (done) return
        setState("progress", p.run_id, { kind: p.kind, step: p.step, at: p.at })
        setState(
          "runSteps",
          p.run_id,
          produce((list) => {
            if (!list) return
            list.push({
              id: `live_${p.at}_${list.length}`,
              run_id: p.run_id,
              at: p.at,
              kind: p.kind as TaskRunStep["kind"],
              message: p.step,
            })
          }),
        )
        return
      }
      if (payload.type === "task.run.started") {
        const props2 = payload.properties as { run: TaskRun }
        upsertRun(props2.run)
      }
      if (payload.type === "task.run.completed") {
        const props2 = payload.properties as { run: TaskRun }
        upsertRun(props2.run)
        setState(
          "progress",
          produce((map) => {
            delete map[props2.run.id]
          }),
        )
      }
      if (
        payload.type === "task.created" ||
        payload.type === "task.updated" ||
        payload.type === "task.removed" ||
        payload.type === "task.run.started" ||
        payload.type === "task.run.completed"
      ) {
        void loadList()
        if (state.selected) void loadRuns(state.selected)
      }
    })
    onCleanup(() => {
      unsub()
    })
  })

  function toggleRun(run: TaskRun) {
    const next = state.expandedRun === run.id ? null : run.id
    setState("expandedRun", next)
    if (next && state.selected) {
      void loadSteps(state.selected, run.id)
      if (run.session_id) void loadRunMessages(run.id, run.session_id)
    }
  }

  function openInChat(sessionID: string) {
    if (!props.onOpenSession) return
    props.onOpenSession(sessionID)
    props.onClose()
  }

  return (
    <Show when={props.open}>
      <div class="macaw-tasks-overlay" role="dialog" aria-label="Tasks">
        <div class="macaw-tasks-card">
          <div class="macaw-tasks-header">
            <div class="macaw-tasks-copy">
              <span class="macaw-tasks-title">Tasks</span>
              <span class="macaw-tasks-count">
                {counts().all} task{counts().all === 1 ? "" : "s"} · {counts().active} active · {counts().paused} paused
                <Show when={counts().failed > 0}> · {counts().failed} failed</Show>
              </span>
            </div>
            <div class="macaw-tasks-head-actions">
              <button type="button" class="macaw-tasks-refresh" onClick={() => void loadList()}>
                Refresh
              </button>
              <button type="button" class="macaw-tasks-new" onClick={openCreate}>
                + New task
              </button>
              <button type="button" class="macaw-tasks-close" onClick={() => props.onClose()} aria-label="Close">
                ×
              </button>
            </div>
          </div>

          <div class="macaw-tasks-body">
          <aside class="macaw-tasks-list">
            <input
              type="search"
              class="macaw-tasks-search"
              placeholder="Search by name, id, prompt..."
              value={state.search}
              onInput={(event) => setState("search", event.currentTarget.value)}
            />
            <div class="macaw-tasks-filters">
              <For each={[
                ["all", `All ${counts().all}`],
                ["active", `Active ${counts().active}`],
                ["paused", `Paused ${counts().paused}`],
                ["failed", `Failed ${counts().failed}`],
              ] as [Filter, string][]}>
                {([key, label]) => (
                  <button
                    type="button"
                    class="macaw-tasks-filter"
                    classList={{ active: state.filter === key }}
                    onClick={() => setState("filter", key)}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
            <Show when={state.loading && filtered().length === 0}>
              <div class="macaw-tasks-empty">Loading…</div>
            </Show>
            <Show when={!state.loading && filtered().length === 0 && state.tasks.length === 0}>
              <div class="macaw-tasks-banner">
                Click <strong>+ New task</strong> or ask MACAW in chat (e.g. <em>"every weekday at 9am, summarize my inbox"</em>).
              </div>
            </Show>
            <Show when={!state.loading && filtered().length === 0 && state.tasks.length > 0}>
              <div class="macaw-tasks-empty">No tasks match the current filter.</div>
            </Show>
            <For each={filtered()}>
              {(task) => {
                void tick
                const step = () => liveStepFor(task.id)
                return (
                  <button
                    type="button"
                    class={`macaw-tasks-item${task.id === state.selected ? " active" : ""}`}
                    onClick={() => setState("selected", task.id)}
                  >
                    <div class="macaw-tasks-item-row">
                      <span class={`macaw-tasks-pill ${task.status}`}>{task.status}</span>
                      <span class="macaw-tasks-item-name">{task.name}</span>
                    </div>
                    <div class="macaw-tasks-item-row sub">
                      <span class="macaw-tasks-item-sched">{describe(task.schedule)}</span>
                      <span class="macaw-tasks-item-next">{relative(task.next_run_at)}</span>
                    </div>
                    <Show when={step()}>
                      {(s) => (
                        <div class="macaw-tasks-item-step">
                          <span class="macaw-tasks-spinner" />
                          <span>{s().step || "starting"}</span>
                        </div>
                      )}
                    </Show>
                  </button>
                )
              }}
            </For>
          </aside>

          <section class="macaw-tasks-detail">
            <Show when={state.error}>
              <div class="macaw-tasks-error">{state.error}</div>
            </Show>
            <Show when={selected()} fallback={<div class="macaw-tasks-empty">Select a task to view details.</div>}>
              {(t) => (
                <>
                  <div class="macaw-tasks-detail-head">
                    <h2>{t().name}</h2>
                    <span class={`macaw-tasks-pill ${t().status}`}>{t().status}</span>
                    <Show when={t().last_status}>
                      <span class={`macaw-tasks-pill ${t().last_status}`}>last: {t().last_status}</span>
                    </Show>
                  </div>
                  <dl class="macaw-tasks-meta">
                    <dt>Schedule</dt>
                    <dd>
                      {describe(t().schedule)} <small>({t().schedule.kind})</small>
                    </dd>
                    <dt>Next run</dt>
                    <dd>
                      {fmt(t().next_run_at)} <small>{relative(t().next_run_at)}</small>
                    </dd>
                    <dt>Last run</dt>
                    <dd>
                      {fmt(t().last_run_at)} <small>{t().last_status ?? "—"}</small>
                    </dd>
                    <dt>Model</dt>
                    <dd>{t().model ?? "(default)"}</dd>
                    <dt>Agent</dt>
                    <dd>{t().agent}</dd>
                    <Show when={t().workdir}>
                      <dt>Workdir</dt>
                      <dd>{t().workdir}</dd>
                    </Show>
                    <dt>Timeout</dt>
                    <dd>{Math.round(t().timeout_ms / 1000)}s</dd>
                    <dt>Retries</dt>
                    <dd>{t().max_retries}</dd>
                    <Show when={t().repeat_remaining !== null}>
                      <dt>Repeat left</dt>
                      <dd>{t().repeat_remaining}</dd>
                    </Show>
                  </dl>

                  <div class="macaw-tasks-actions">
                    <Show
                      when={t().status === "active"}
                      fallback={
                        <button type="button" onClick={() => void resume(t().id)}>
                          Resume
                        </button>
                      }
                    >
                      <button type="button" onClick={() => void pause(t().id)}>
                        Pause
                      </button>
                    </Show>
                    <button type="button" onClick={() => void runNow(t().id)}>
                      Run now
                    </button>
                    <button type="button" onClick={() => openEdit(t())}>
                      Edit
                    </button>
                    <Show when={liveStepFor(t().id)}>
                      <button type="button" class="danger" onClick={() => void cancel(t().id)}>
                        Cancel running
                      </button>
                    </Show>
                    <button type="button" class="danger" onClick={() => void remove(t().id)}>
                      Delete
                    </button>
                  </div>

                  <h3>Prompt</h3>
                  <pre class="macaw-tasks-prompt">{t().prompt}</pre>

                  <h3>Recent runs</h3>
                  <Show when={selectedRuns().length === 0}>
                    <div class="macaw-tasks-empty">No runs yet.</div>
                  </Show>
                  <ul class="macaw-tasks-runs">
                    <For each={selectedRuns()}>
                      {(run) => {
                        const expanded = () => state.expandedRun === run.id
                        const steps = () => state.runSteps[run.id] ?? []
                        const messages = () => state.runMessages[run.id] ?? []
                        const liveStep = () => state.progress[run.id]
                        return (
                          <li class={`macaw-tasks-run ${run.status}`}>
                            <button
                              type="button"
                              class="macaw-tasks-run-row"
                              onClick={() => toggleRun(run)}
                              aria-expanded={expanded()}
                            >
                              <span class="macaw-reasoning-chevron" classList={{ open: expanded() }}>
                                ▸
                              </span>
                              <span class={`macaw-tasks-pill ${run.status}`}>{run.status}</span>
                              <span class="macaw-tasks-run-time">{fmt(run.started_at)}</span>
                              <Show when={run.attempts > 1}>
                                <span class="macaw-tasks-run-attempts">{run.attempts} attempts</span>
                              </Show>
                              <span class="macaw-tasks-run-dur">{duration(run)}</span>
                            </button>
                            <Show when={run.status === "running"}>
                              <div class="macaw-tasks-run-progress">
                                <span class="macaw-tasks-spinner" />
                                <span>{liveStep()?.step || "starting"}</span>
                                <button
                                  type="button"
                                  class="macaw-tasks-run-cancel"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void cancel(run.task_id)
                                  }}
                                  title="Cancel"
                                >
                                  ■
                                </button>
                              </div>
                            </Show>
                            <Show when={run.summary}>
                              <div class="macaw-tasks-run-summary">{run.summary}</div>
                            </Show>
                            <Show when={run.error}>
                              <div class="macaw-tasks-run-error">{run.error}</div>
                            </Show>
                            <Show when={expanded()}>
                              <div class="macaw-tasks-run-detail">
                                <div class="macaw-tasks-run-detail-head">
                                  <span>Step timeline</span>
                                  <Show when={run.session_id && props.onOpenSession}>
                                    <button
                                      type="button"
                                      class="macaw-tasks-run-open"
                                      onClick={() => run.session_id && openInChat(run.session_id)}
                                    >
                                      Open as session
                                    </button>
                                  </Show>
                                </div>
                                <Show when={steps().length === 0}>
                                  <div class="macaw-tasks-empty">No steps recorded.</div>
                                </Show>
                                <ul class="macaw-tasks-steps">
                                  <For each={steps()}>
                                    {(s) => (
                                      <li class={`macaw-tasks-step kind-${s.kind}`}>
                                        <span class="macaw-tasks-step-time">{fmtTime(s.at)}</span>
                                        <span class={`macaw-tasks-step-kind kind-${s.kind}`}>{s.kind}</span>
                                        <span class="macaw-tasks-step-msg">{s.message}</span>
                                      </li>
                                    )}
                                  </For>
                                </ul>
                                <Show when={run.session_id}>
                                  <div class="macaw-tasks-run-detail-head">
                                    <span>Session replay</span>
                                  </div>
                                  <Show when={state.runMessagesLoading[run.id]}>
                                    <div class="macaw-tasks-empty">Loading session…</div>
                                  </Show>
                                  <Show when={!state.runMessagesLoading[run.id] && messages().length === 0}>
                                    <div class="macaw-tasks-empty">No messages.</div>
                                  </Show>
                                  <div class="macaw-tasks-replay">
                                    <For each={messages()}>{(row) => <TurnRow row={row} />}</For>
                                  </div>
                                </Show>
                              </div>
                            </Show>
                          </li>
                        )
                      }}
                    </For>
                  </ul>
                </>
              )}
            </Show>
          </section>
          </div>

          <Show when={form()} keyed>
          {(f) => (
            <div class="macaw-tasks-modal" role="dialog" aria-label="Task editor">
              <div class="macaw-tasks-modal-card">
                <div class="macaw-tasks-modal-head">
                  <h3>{f.id ? "Edit task" : "New task"}</h3>
                  <button
                    type="button"
                    class="macaw-tasks-close"
                    onClick={() => setForm(null)}
                    aria-label="Close"
                  >
                    ×
                  </button>
                </div>
                <div class="macaw-tasks-form">
                  <label>
                    <span>Name</span>
                    <input
                      type="text"
                      placeholder="(auto from prompt)"
                      value={f.name}
                      onInput={(event) => setForm({ ...f, name: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>Prompt</span>
                    <textarea
                      rows={5}
                      placeholder="Self-contained instruction the agent will run in a fresh session..."
                      value={f.prompt}
                      onInput={(event) => setForm({ ...f, prompt: event.currentTarget.value })}
                    />
                  </label>
                  <div class="macaw-tasks-form-row">
                    <label>
                      <span>Schedule</span>
                      <select
                        value={f.kind}
                        onChange={(event) => setForm({ ...f, kind: event.currentTarget.value as ScheduleKind })}
                      >
                        <option value="interval">Interval (every Xm/h)</option>
                        <option value="cron">Cron (5 fields)</option>
                        <option value="delay">One-shot delay</option>
                        <option value="iso">One-shot ISO time</option>
                      </select>
                    </label>
                    <label class="grow">
                      <span>Expression</span>
                      <input
                        type="text"
                        value={f.expr}
                        onInput={(event) => setForm({ ...f, expr: event.currentTarget.value })}
                        placeholder={
                          f.kind === "interval"
                            ? "every 1h"
                            : f.kind === "cron"
                              ? "0 9 * * 1-5"
                              : f.kind === "delay"
                                ? "30m"
                                : "2026-05-07T18:00"
                        }
                      />
                    </label>
                  </div>
                  <div class="macaw-tasks-form-presets">
                    <span>Examples:</span>
                    <For each={SCHEDULE_PRESETS}>
                      {(p) => (
                        <button
                          type="button"
                          onClick={() => setForm({ ...f, kind: p.kind, expr: p.expr })}
                        >
                          {p.label}
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="macaw-tasks-form-row">
                    <label class="grow">
                      <span>Model</span>
                      <select
                        value={f.model}
                        onChange={(event) => setForm({ ...f, model: event.currentTarget.value })}
                      >
                        <option value="">(default)</option>
                        <Show when={f.model && !state.models.includes(f.model)}>
                          <option value={f.model}>{f.model}</option>
                        </Show>
                        <For each={state.models}>{(m) => <option value={m}>{m}</option>}</For>
                      </select>
                    </label>
                    <label>
                      <span>Agent</span>
                      <select
                        value={f.agent}
                        onChange={(event) => setForm({ ...f, agent: event.currentTarget.value })}
                      >
                        <For each={AGENTS}>{(a) => <option value={a}>{a}</option>}</For>
                      </select>
                    </label>
                  </div>
                  <label>
                    <span>Working directory</span>
                    <input
                      type="text"
                      placeholder="(server default)"
                      value={f.workdir}
                      onInput={(event) => setForm({ ...f, workdir: event.currentTarget.value })}
                    />
                  </label>
                  <div class="macaw-tasks-form-row">
                    <label>
                      <span>Timeout (minutes)</span>
                      <input
                        type="number"
                        min="1"
                        value={f.timeout_min}
                        onInput={(event) =>
                          setForm({ ...f, timeout_min: Math.max(1, Number(event.currentTarget.value) || 1) })
                        }
                      />
                    </label>
                    <label>
                      <span>Max retries</span>
                      <input
                        type="number"
                        min="0"
                        value={f.max_retries}
                        onInput={(event) =>
                          setForm({ ...f, max_retries: Math.max(0, Number(event.currentTarget.value) || 0) })
                        }
                      />
                    </label>
                    <label>
                      <span>Repeat (blank = forever)</span>
                      <input
                        type="number"
                        min="1"
                        value={f.repeat}
                        onInput={(event) => setForm({ ...f, repeat: event.currentTarget.value })}
                      />
                    </label>
                  </div>
                  <Show when={f.error}>
                    <div class="macaw-tasks-error">{f.error}</div>
                  </Show>
                </div>
                <div class="macaw-tasks-modal-foot">
                  <button type="button" onClick={() => setForm(null)} disabled={f.saving}>
                    Cancel
                  </button>
                  <button type="button" class="primary" onClick={() => void saveForm()} disabled={f.saving}>
                    {f.saving ? "Saving…" : f.id ? "Save" : "Create"}
                  </button>
                </div>
              </div>
            </div>
          )}
          </Show>
        </div>
      </div>
    </Show>
  )
}
