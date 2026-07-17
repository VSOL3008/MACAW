import type { FilePart, Message, Part, Todo, ToolPart } from "@macaw/sdk/v2/client"
import { Markdown } from "@macaw/ui/markdown"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"

export type Row = {
  info: Message
  parts: Part[]
}

type ReasoningPart = Extract<Part, { type: "reasoning" }>

function fault(row: Row) {
  if (row.info.role !== "assistant" || !row.info.error) return ""
  const data = row.info.error.data
  if (typeof data === "object" && data && "message" in data && typeof data.message === "string") return data.message
  return row.info.error.name
}

export function rowText(row: Row): string {
  const text = row.parts
    .filter((part): part is Extract<Part, { type: "text" }> => {
      if (part.type !== "text") return false
      if (row.info.role === "user" && part.synthetic) return false
      return true
    })
    .map((part) => part.text)
    .join("\n\n")
  if (text) return text
  return fault(row)
}

export function rowReasoningParts(row: Row): ReasoningPart[] {
  return row.parts.filter((part): part is ReasoningPart => part.type === "reasoning")
}

export function reasoningText(parts: ReasoningPart[]): string {
  return parts
    .map((part) => part.text)
    .join("\n\n")
    .trim()
}

export function reasoningOngoing(row: Row, parts: ReasoningPart[]): boolean {
  if (parts.length === 0) return false
  if ("completed" in row.info.time && typeof row.info.time.completed === "number") return false
  return parts.some((part) => typeof part.time.end !== "number")
}

export function reasoningDuration(parts: ReasoningPart[], now: number): number {
  if (parts.length === 0) return 0
  const start = Math.min(...parts.map((part) => part.time.start))
  const end = parts.every((part) => typeof part.time.end === "number")
    ? Math.max(...parts.map((part) => part.time.end as number))
    : now
  return Math.max(0, end - start)
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`
  const mins = Math.floor(secs / 60)
  const rem = Math.round(secs % 60)
  return `${mins}m ${rem}s`
}

export function rowImages(row: Row): FilePart[] {
  return row.parts.filter((part): part is FilePart => part.type === "file" && part.mime.startsWith("image/"))
}

export function rowFiles(row: Row): FilePart[] {
  return row.parts.filter((part): part is FilePart => part.type === "file" && !part.mime.startsWith("image/"))
}

export function rowTools(row: Row): ToolPart[] {
  return row.parts.filter((part): part is ToolPart => part.type === "tool")
}

export function rowTaskTools(row: Row): ToolPart[] {
  return row.parts.filter((part): part is ToolPart => part.type === "tool" && part.tool === "task")
}

const SHELL_TOOLS = new Set(["bash", "powershell"])
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

function presentation(part: ToolPart) {
  const state = part.state as unknown as {
    metadata?: { kind?: unknown }
    attachments?: Array<{ mime?: unknown }>
  }
  if (state.metadata?.kind === "presentation") return true
  if (state.attachments?.some((file) => file.mime === PPTX)) return true
  return part.tool === "presentation_preview"
}

export function rowShellTools(row: Row): ToolPart[] {
  return row.parts.filter((part): part is ToolPart => part.type === "tool" && SHELL_TOOLS.has(part.tool))
}

export function rowTodoTools(row: Row): ToolPart[] {
  return row.parts.filter((part): part is ToolPart => part.type === "tool" && part.tool === "todowrite")
}

export function rowPresentationTools(row: Row): ToolPart[] {
  return row.parts.filter((part): part is ToolPart => part.type === "tool" && presentation(part))
}

export function latestTodo(rows: Row[]): ToolPart | undefined {
  return rows.flatMap((row) => rowTodoTools(row)).at(-1)
}

export function rowOtherTools(row: Row): ToolPart[] {
  return row.parts.filter((part): part is ToolPart => {
    if (part.type !== "tool") return false
    if (part.tool === "task") return false
    if (part.tool === "todowrite") return false
    if (SHELL_TOOLS.has(part.tool)) return false
    if (presentation(part)) return false
    if (part.tool === "question" && (part.state.status === "pending" || part.state.status === "running")) return false
    return true
  })
}

export function toolTodos(part: ToolPart): Todo[] | undefined {
  const state = part.state as unknown as {
    input?: { todos?: unknown }
    metadata?: { todos?: unknown }
  }
  const value = Array.isArray(state.metadata?.todos) ? state.metadata.todos : state.input?.todos
  if (!Array.isArray(value)) return
  return value.filter((todo): todo is Todo => {
    if (!todo || typeof todo !== "object") return false
    const item = todo as Partial<Todo>
    return typeof item.content === "string" && typeof item.status === "string" && typeof item.priority === "string"
  })
}

export function shellScript(part: ToolPart): string {
  const input = ((part.state as unknown as { input?: Record<string, unknown> }).input ?? {}) as {
    command?: string
    script?: string
  }
  return input.command ?? input.script ?? ""
}

export function shellOutput(part: ToolPart): string {
  const s = part.state as unknown as { output?: string; error?: string; metadata?: { output?: string } }
  if (part.state.status === "completed") return s.output ?? ""
  if (part.state.status === "error") return s.error ?? ""
  return s.metadata?.output ?? ""
}

export function formatTime(time?: number): string {
  if (!time) return ""
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export function Reasoning(props: { row: Row }) {
  const parts = () => rowReasoningParts(props.row)
  const text = () => reasoningText(parts())
  const ongoing = () => reasoningOngoing(props.row, parts())
  const [touched, setTouched] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const visible = () => (touched() ? open() : ongoing())
  const toggle = () => {
    setTouched(true)
    setOpen(!visible())
  }
  const [tick, setTick] = createSignal(Date.now())
  createEffect(() => {
    if (!ongoing()) return
    const id = setInterval(() => setTick(Date.now()), 250)
    onCleanup(() => clearInterval(id))
  })
  const label = () =>
    ongoing() ? "Thinking" : `Thought for ${formatDuration(reasoningDuration(parts(), tick()))}`
  return (
    <div class="macaw-reasoning" classList={{ "macaw-reasoning-active": ongoing() }}>
      <button type="button" class="macaw-reasoning-head" onClick={toggle} aria-expanded={visible()}>
        <span class="macaw-reasoning-chevron" classList={{ open: visible() }}>
          ▸
        </span>
        <span class="macaw-reasoning-label" classList={{ "macaw-reasoning-live": ongoing() }}>
          {label()}
        </span>
      </button>
      <Show when={visible() && text()}>
        <Markdown text={text()} class="macaw-reasoning-text" />
      </Show>
    </div>
  )
}

export function TodoPlan(props: { part: ToolPart; mini?: boolean; todos?: Todo[]; live?: boolean }) {
  const items = createMemo(() => props.todos ?? toolTodos(props.part) ?? [])
  const done = createMemo(() => items().filter((item) => item.status === "completed").length)
  const active = () => props.live || props.part.state.status === "pending" || props.part.state.status === "running"
  const label = () => `To-dos ${done()}/${items().length}`

  return (
    <Show when={items().length > 0}>
      <section
        class="macaw-todo-plan"
        classList={{ mini: props.mini, live: props.live }}
        data-active={active() ? "" : undefined}
        data-live={props.live ? "" : undefined}
        aria-label={label()}
        aria-live={props.live ? "polite" : undefined}
      >
        <div class="macaw-todo-head">
          <span class="macaw-todo-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span class="macaw-todo-title">To-dos</span>
          <span class="macaw-todo-count">
            {done()}/{items().length}
          </span>
        </div>
        <ol class="macaw-todo-list">
          <For each={items()}>
            {(todo) => (
              <li class={`macaw-todo-item ${todo.status}`}>
                <span class={`macaw-todo-marker ${todo.status}`} aria-hidden="true">
                  <span />
                </span>
                <span class="sr-only">{todo.status.replace("_", " ")}</span>
                <span class="macaw-todo-content">{todo.content}</span>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  )
}

export function ShellToolCard(props: { part: ToolPart }) {
  const [open, setOpen] = createSignal(false)
  const language = () => (props.part.tool === "powershell" ? "powershell" : "bash")
  const script = () => shellScript(props.part)
  const output = () => shellOutput(props.part)
  const status = () => props.part.state.status
  return (
    <div class={`macaw-shell-tool ${status()}`}>
      <div class="macaw-shell-tool-head">
        <span class="macaw-shell-tool-name">{props.part.tool}</span>
        <span class="macaw-shell-tool-status">{status()}</span>
      </div>
      <pre class="macaw-shell-tool-cmd" data-lang={language()}>
        <code>{script() || "(empty)"}</code>
      </pre>
      <Show when={output()}>
        <button
          type="button"
          class="macaw-shell-tool-toggle"
          onClick={() => setOpen(!open())}
          aria-expanded={open()}
        >
          <span class="macaw-shell-tool-chevron" classList={{ open: open() }}>
            ▸
          </span>
          <span>{open() ? "Hide output" : "Show output"}</span>
        </button>
        <Show when={open()}>
          <pre class="macaw-shell-tool-output">{output()}</pre>
        </Show>
      </Show>
    </div>
  )
}

export function TurnRow(props: { row: Row; mini?: boolean }) {
  const role = () => props.row.info.role
  const headLabel = () => (role() === "user" ? "You" : "MACAW")
  const turnClass = () => (props.mini ? `macaw-mini-turn ${role()}` : `macaw-turn ${role()}`)
  return (
    <div class={turnClass()}>
      <div class={props.mini ? "macaw-mini-head" : "macaw-turn-head"}>
        <span>{headLabel()}</span>
        <span>{formatTime(props.row.info.time.created)}</span>
      </div>
      <Show when={role() === "assistant" && rowReasoningParts(props.row).length > 0}>
        <Reasoning row={props.row} />
      </Show>
      <Show when={rowImages(props.row).length > 0 || rowFiles(props.row).length > 0}>
        <div class="macaw-attached">
          <For each={rowImages(props.row)}>
            {(item) => (
              <a
                class="macaw-attached-image"
                href={item.url}
                target="_blank"
                rel="noreferrer"
                title={item.filename ?? "image"}
              >
                <img src={item.url} alt={item.filename ?? "attachment"} />
              </a>
            )}
          </For>
          <For each={rowFiles(props.row)}>
            {(item) => (
              <a
                class="macaw-attached-file"
                href={item.url}
                target="_blank"
                rel="noreferrer"
                download={item.filename ?? "file"}
                title={item.filename ?? item.mime}
              >
                <span class="macaw-attached-icon" aria-hidden="true">FILE</span>
                <span class="macaw-attached-meta">
                  <span class="macaw-attached-name">{item.filename ?? "file"}</span>
                  <span class="macaw-attached-mime">{item.mime}</span>
                </span>
              </a>
            )}
          </For>
        </div>
      </Show>
      <Show when={rowText(props.row)}>
        <Show
          when={role() === "assistant"}
          fallback={<pre class={props.mini ? "macaw-text macaw-mini-text" : "macaw-text"}>{rowText(props.row)}</pre>}
        >
          <Markdown text={rowText(props.row)} class="macaw-markdown" />
        </Show>
      </Show>
      <For each={rowTodoTools(props.row)}>{(part) => <TodoPlan part={part} mini={props.mini} />}</For>
      <Show when={rowOtherTools(props.row).length > 0}>
        <div class="macaw-inline-tools">
          <For each={rowOtherTools(props.row)}>
            {(tool) => (
              <div class={`macaw-inline-tool ${tool.state.status}`}>
                <span>{tool.tool}</span>
                <span>{tool.state.status}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <For each={rowShellTools(props.row)}>{(part) => <ShellToolCard part={part} />}</For>
    </div>
  )
}
