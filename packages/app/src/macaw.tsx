import type {
  Config,
  Event,
  Message,
  Part,
  PermissionRequest,
  Provider,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  ToolListItem,
  ToolPart,
} from "@macaw/sdk/v2/client"
import { Markdown } from "@macaw/ui/markdown"
import { Mark } from "@macaw/ui/logo"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useCommand } from "@/context/command"
import { usePlatform } from "@/context/platform"
import type { ServerConnection } from "@/context/server"
import { createSdkForServer } from "@/utils/server"
import { MemoryGraph } from "@/memory-graph"
import { TasksView } from "@/tasks-view"
import { createFallback, FALLBACK_TIMEOUT_MS } from "@/utils/fallback"
import {
  type Row,
  Reasoning,
  ShellToolCard,
  TodoPlan,
  formatTime,
  latestTodo,
  rowFiles,
  rowImages,
  rowOtherTools,
  rowReasoningParts,
  rowShellTools,
  rowTaskTools,
  rowTodoTools,
  rowText,
  rowTools,
  toolTodos,
} from "@/components/turn"

type Pair = {
  provider: string
  model: string
}

type Attachment = {
  id: string
  mime: string
  filename: string
  url: string
}

type Notify = {
  idle: boolean
  question: boolean
  permission: boolean
}

type Settings = {
  kind: "ollama" | "azure"
  url: string
  key: string
  model: string
  name: string
  notify: Notify
  fallback: boolean
}

const AZURE = "azure-foundry"
const AZURE_NAME = "Azure AI Foundry"
const AZURE_MODEL = "gpt-4o"

function read(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

function size(key: string, fallback: number) {
  const raw = Number(read(key) ?? "")
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function split(value: string): Pair {
  const [provider, ...rest] = value.split("/")
  return {
    provider,
    model: rest.join("/"),
  }
}

function pack(input: Pair) {
  return `${input.provider}/${input.model}`
}

function azure(value: string) {
  const url = value.trim().replace(/\/+$/, "")
  if (!url || !URL.canParse(url)) return url
  const next = new URL(url)
  const host = next.hostname.toLowerCase()
  if (!host.endsWith(".openai.azure.com") && !host.endsWith(".services.ai.azure.com")) return url
  const path = next.pathname.replace(/\/+$/, "")
  if (
    path &&
    path !== "/openai" &&
    path !== "/openai/v1" &&
    path !== "/openai/responses" &&
    !path.endsWith("/chat/completions") &&
    !path.endsWith("/responses")
  )
    return url
  next.pathname = "/openai/v1"
  next.search = ""
  return next.toString().replace(/\/+$/, "")
}

function fault(err?: { name?: string; data?: { message?: string } }) {
  return err?.data?.message || err?.name || "An error occurred."
}

function seed(cfg?: Config, host = "", note = alerts(), fallback = loadAutoFallback()): Settings {
  const item = cfg?.provider?.[AZURE]
  const pick = split(host)
  const url = typeof item?.options?.baseURL === "string" ? item.options.baseURL : read("macaw.azure.url") ?? ""
  return {
    kind: pick.provider === AZURE ? "azure" : "ollama",
    url: azure(url),
    key: typeof item?.options?.apiKey === "string" ? item.options.apiKey : "",
    model:
      (pick.provider === AZURE ? pick.model : Object.keys(item?.models ?? {})[0]) || read("macaw.azure.model") || AZURE_MODEL,
    name: item?.name ?? read("macaw.azure.name") ?? AZURE_NAME,
    notify: { ...note },
    fallback,
  }
}

function sessionSort(left: Session, right: Session) {
  return (right.time.updated ?? right.time.created) - (left.time.updated ?? left.time.created)
}

function upsertSession(list: Session[], info: Session) {
  if (info.parentID) return list.filter((item) => item.id !== info.id).sort(sessionSort)
  return [...list.filter((item) => item.id !== info.id), info].sort(sessionSort)
}

function upsertRow(list: Row[], info: Message) {
  const idx = list.findIndex((item) => item.info.id === info.id)
  if (idx === -1) return [...list, { info, parts: [] }].sort((a, b) => a.info.time.created - b.info.time.created)
  const next = list.slice()
  next[idx] = { ...next[idx], info }
  return next.sort((a, b) => a.info.time.created - b.info.time.created)
}

function upsertPart(list: Row[], part: Part) {
  const idx = list.findIndex((item) => item.info.id === part.messageID)
  if (idx === -1) return list
  const next = list.slice()
  const row = next[idx]
  const pos = row.parts.findIndex((item) => item.id === part.id)
  const parts = pos === -1 ? [...row.parts, part] : row.parts.map((item) => (item.id === part.id ? part : item))
  next[idx] = { ...row, parts }
  return next
}

function removePart(list: Row[], messageID: string, partID: string) {
  return list.map((row) => {
    if (row.info.id !== messageID) return row
    return {
      ...row,
      parts: row.parts.filter((part) => part.id !== partID),
    }
  })
}

function stamp(part: ToolPart) {
  switch (part.state.status) {
    case "pending":
      return 0
    case "running":
      return part.state.time.start
    case "completed":
      return part.state.time.start
    case "error":
      return part.state.time.start
  }
  return 0
}

function preview(part: ToolPart) {
  if (part.state.status === "completed") return part.state.output
  if (part.state.status === "error") return part.state.error
  if (part.state.status === "running") return part.state.title ?? "Running..."
  return part.state.raw
}

function pretty(status?: SessionStatus) {
  if (!status || status.type === "idle") return "Idle"
  if (status.type === "busy") return "Running"
  return `Retry ${status.attempt}`
}

function shape(providers: Provider[]) {
  return providers.flatMap((provider) =>
    Object.values(provider.models).map((model) => ({
      provider: provider.id,
      model: model.id,
      label: `${provider.name} / ${model.name}`,
      image: model.capabilities.input.image,
    })),
  )
}

function pickHost(providers: Provider[]) {
  const saved = read("macaw.host")
  if (saved) {
    const found = shape(providers).find((item) => pack(item) === saved)
    if (found) return saved
  }
  const first = shape(providers)[0]
  return first ? pack(first) : ""
}

function loadFavorites(): string[] {
  const raw = read("macaw.favorites")
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function saveFavorites(list: string[]) {
  write("macaw.favorites", JSON.stringify(list))
}

function loadAutoFallback(): boolean {
  return read("macaw.autoFallback") === "on"
}

function loadNotify(name: string) {
  return read(`macaw.notify.${name}`) !== "off"
}

function alerts(): Notify {
  return {
    idle: loadNotify("idle"),
    question: loadNotify("question"),
    permission: loadNotify("permission"),
  }
}

type Toast = {
  id: string
  kind: "idle" | "question" | "permission"
  title: string
  body: string
  sessionID?: string
}

function providerCacheKey(server: ServerConnection.Any) {
  return `macaw.providers:${server.http.url}`
}

function loadCachedProviders(server: ServerConnection.Any): Provider[] {
  const raw = read(providerCacheKey(server))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Provider[]) : []
  } catch {
    return []
  }
}

function saveCachedProviders(server: ServerConnection.Any, providers: Provider[]) {
  try {
    write(providerCacheKey(server), JSON.stringify(providers))
  } catch {
    return
  }
}

function sessionCacheKey(server: ServerConnection.Any) {
  return `macaw.sessions:${server.http.url}`
}

function loadCachedSessions(server: ServerConnection.Any): Session[] {
  const raw = read(sessionCacheKey(server))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as Session[]).filter((item) => !item.parentID).sort(sessionSort)
  } catch {
    return []
  }
}

function saveCachedSessions(server: ServerConnection.Any, sessions: Session[]) {
  try {
    write(sessionCacheKey(server), JSON.stringify(sessions.slice(0, 100)))
  } catch {
    return
  }
}

function title(session: Session) {
  return session.title || "Untitled session"
}

function createStick() {
  let view: HTMLDivElement | undefined
  let body: HTMLDivElement | undefined
  let obs: ResizeObserver | undefined
  let frame: number | undefined
  let stuck = true
  let force = false

  const clear = () => {
    obs?.disconnect()
    obs = undefined
    view = undefined
    body = undefined
    force = false
    stuck = true
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  const bottom = (el: HTMLDivElement) => el.scrollHeight - el.clientHeight - el.scrollTop <= 24

  const run = () => {
    frame = undefined
    const el = view
    const next = force
    force = false
    if (!el) return
    if (!next && !stuck) return
    el.scrollTop = el.scrollHeight
  }

  const queue = (next = false) => {
    force = force || next
    if (frame !== undefined) return
    frame = requestAnimationFrame(run)
  }

  const bind = () => {
    obs?.disconnect()
    if (!view || !body) {
      obs = undefined
      return
    }
    obs = new ResizeObserver(() => queue())
    obs.observe(view)
    obs.observe(body)
  }

  onCleanup(clear)

  return {
    body: (el: HTMLDivElement | undefined) => {
      body = el
      bind()
      if (el) queue(true)
    },
    clear,
    follow: () => {
      stuck = true
      queue(true)
    },
    scroll: (event: globalThis.Event & { currentTarget: HTMLDivElement }) => {
      stuck = bottom(event.currentTarget)
    },
    view: (el: HTMLDivElement | undefined) => {
      view = el
      bind()
      if (el) queue(true)
    },
  }
}

export function MacawApp(props: { server: ServerConnection.Any }) {
  const cmd = useCommand()
  const platform = usePlatform()
  let picker: HTMLInputElement | undefined
  let input: HTMLTextAreaElement | undefined
  const [state, setState] = createStore({
    ready: false,
    connected: false,
    loading: false,
    busy: false,
    dir: "",
    error: "",
    prompt: "",
    tab: "steps" as "steps" | "tools",
    mode: (read("macaw.mode") ?? "build") as "build" | "file_shell" | "zero_trust" | "corporate_search",
    current: "",
    host: "",
    sessions: [] as Session[],
    filter: "",
    attachments: [] as Attachment[],
    messages: [] as Row[],
    childMessages: {} as Record<string, Row[]>,
    expanded: {} as Record<string, boolean>,
    todos: [] as Todo[],
    tools: [] as ToolListItem[],
    providers: [] as Provider[],
    status: {} as Record<string, SessionStatus>,
    left: clamp(size("macaw.left", 248), 220, 300),
    right: clamp(size("macaw.right", 320), 280, 360),
    panel: "" as "" | "side" | "pane",
    showGraph: false,
    showTasks: false,
    favorites: loadFavorites(),
    autoFallback: loadAutoFallback(),
    notify: alerts(),
    toasts: [] as Toast[],
    hostOpen: false,
    settingsOpen: false,
    settingsBusy: false,
    settingsError: "",
    settings: seed(undefined, read("macaw.host") ?? ""),
    questions: {} as Record<string, QuestionRequest[]>,
    permissions: {} as Record<string, PermissionRequest[]>,
    draft: {} as Record<
      string,
      {
        tab: number
        answers: string[][]
        custom: string[]
        customOn: boolean[]
      }
    >,
  })

  const root = createMemo(() => createSdkForServer({ server: props.server.http }))
  const client = (dir = state.dir) => createSdkForServer({ server: props.server.http, directory: dir })

  const models = createMemo(() => shape(state.providers))
  const favoriteSet = createMemo(() => new Set(state.favorites))
  const orderedModels = createMemo(() => {
    const all = models()
    const favs = favoriteSet()
    const fav = all.filter((item) => favs.has(pack(item)))
    const rest = all.filter((item) => !favs.has(pack(item)))
    return { fav, rest }
  })
  const filtered = createMemo(() => {
    const q = state.filter.trim().toLowerCase()
    if (!q) return state.sessions
    return state.sessions.filter((item) => title(item).toLowerCase().includes(q))
  })
  const currentLabel = createMemo(() => models().find((item) => pack(item) === state.host)?.label ?? "")
  const heading = createMemo(() => {
    const session = state.sessions.find((item) => item.id === state.current)
    return session ? title(session) : ""
  })
  const currentStatus = createMemo(() => state.status[state.current])
  const pending = createMemo(() =>
    state.messages.findLast(
      (row) => row.info.role === "assistant" && typeof row.info.time.completed !== "number",
    ),
  )
  const pendingQuestion = createMemo(() => {
    const id = state.current
    if (!id) return undefined
    return state.questions[id]?.[0]
  })
  const pendingPermission = createMemo(() => {
    const id = state.current
    if (!id) return undefined
    return state.permissions[id]?.[0]
  })
  const working = createMemo(() => {
    const s = currentStatus()
    return s?.type === "busy" || s?.type === "retry" || !!pending()
  })
  const thinking = createMemo(() => {
    if (!working()) return false
    const p = pending()
    return !p || !rowText(p)
  })
  const steps = createMemo(() =>
    state.messages
      .flatMap((row) => rowTools(row))
      .sort((a, b) => stamp(a) - stamp(b)),
  )
  const todo = createMemo(() => latestTodo(state.messages))
  const live = createMemo(() => (state.todos.length > 0 ? todo() : undefined))
  const last = createMemo(() => state.messages.at(-1)?.info.id)
  const usage = createMemo(() => {
    const map = new Map<string, number>()
    for (const step of steps()) {
      map.set(step.tool, (map.get(step.tool) ?? 0) + 1)
    }
    return map
  })
  const running = createMemo(() => new Set(steps().filter((step) => step.state.status === "running").map((step) => step.tool)))
  const url = createMemo(() => {
    const pick = split(state.host)
    return state.providers.find((provider) => provider.id === pick.provider)?.options.baseURL?.toString() ?? ""
  })
  const stick = createStick()

  async function loadTools(value = state.host, dir = state.dir) {
    if (!dir || !value) return
    const pick = split(value)
    const res = await client(dir).tool.list({
      provider: pick.provider,
      model: pick.model,
    })
    setState("tools", res.data ?? [])
  }

  function apply(all: Provider[], dir = state.dir, want?: string) {
    const list = shape(all)
    const host = want && list.some((item) => pack(item) === want) ? want : pickHost(all)
    setState({ providers: all, host })
    if (host) write("macaw.host", host)
    saveCachedProviders(props.server, all)
    void loadTools(host, dir)
    return host
  }

  function toggleFavorite(id: string) {
    const next = state.favorites.includes(id)
      ? state.favorites.filter((item) => item !== id)
      : [...state.favorites, id]
    setState("favorites", next)
    saveFavorites(next)
  }

  function fallbackQueue(start: string) {
    const valid = new Set(models().map((item) => pack(item)))
    const seen = new Set<string>()
    const out: string[] = []
    const add = (id: string) => {
      if (!valid.has(id) || seen.has(id)) return
      seen.add(id)
      out.push(id)
    }
    add(start)
    for (const fav of state.favorites) add(fav)
    return out
  }

  async function loadSession(id: string, dir = state.dir) {
    if (!dir) return
    const [msgs, todos] = await Promise.all([
      client(dir).session.messages({
        sessionID: id,
        limit: 200,
      }),
      client(dir).session.todo({
        sessionID: id,
      }),
    ])
    setState("current", id)
    setState("messages", msgs.data ?? [])
    setState("todos", todos.data ?? [])
    setState("attachments", [])
    if (state.panel) panel(state.panel)
    write("macaw.session", id)
  }

  async function createSession(dir = state.dir) {
    if (!dir) return
    const res = await client(dir).session.create({})
    if (!res.data) return
    setState("sessions", (list) => upsertSession(list, res.data!))
    await loadSession(res.data.id, dir)
  }

  async function remove(item: Session) {
    if (!state.dir) return
    if (!confirm(`Delete "${title(item)}"?`)) return
    const ok = await client()
      .session.delete({ sessionID: item.id })
      .then((x) => x.data)
      .catch((err) => {
        console.error("failed to delete session", err)
        alert(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`)
        return false
      })
    if (!ok) return
    setState("sessions", (list) => list.filter((s) => s.id !== item.id))
    if (state.current === item.id) {
      setState({ current: "", messages: [], todos: [], attachments: [] })
      write("macaw.session", "")
    }
  }

  async function stop(sessionID?: string) {
    const id = sessionID ?? state.current
    if (!id || !state.dir) return
    if (fallbackRuntime.sessionID === id) clearFallback()
    await client()
      .session.abort({ sessionID: id })
      .catch((err) => {
        console.error("failed to abort session", err)
      })
  }

  async function loadChild(sessionID: string) {
    if (!state.dir || state.childMessages[sessionID]) return
    const res = await client()
      .session.messages({ sessionID, limit: 500 })
      .catch((err) => {
        console.error("failed to load child session", err)
        return undefined
      })
    setState("childMessages", sessionID, res?.data ?? [])
  }

  function toggleChild(sessionID: string) {
    const next = !state.expanded[sessionID]
    setState("expanded", sessionID, next)
    if (next) void loadChild(sessionID)
  }

  async function connect(alive: () => boolean) {
    let attempt = 0
    while (alive()) {
      try {
        const path = await root().path.get()
        const dir = read("macaw.dir") || path.data?.home || path.data?.directory || ""
        if (!dir) throw new Error("server returned no directory")
        write("macaw.dir", dir)
        const sdk = createSdkForServer({ server: props.server.http, directory: dir })
        setState({ ready: true, connected: true, dir, error: "" })
        return { dir, sdk }
      } catch (err) {
        setState("connected", false)
        setState("error", err instanceof Error ? err.message : String(err))
        attempt += 1
        const backoff = Math.min(5_000, 500 * 2 ** Math.min(attempt, 4))
        await new Promise((done) => setTimeout(done, backoff))
      }
    }
    return
  }

  async function boot(alive: () => boolean) {
    setState("loading", true)

    const providers = loadCachedProviders(props.server)
    if (providers.length > 0) {
      const host = pickHost(providers)
      setState({ providers, host })
    }

    const cachedSessions = loadCachedSessions(props.server)
    if (cachedSessions.length > 0) setState("sessions", cachedSessions)

    const result = await connect(alive)
    if (!result || !alive()) {
      setState("loading", false)
      return
    }
    const { dir, sdk } = result

    const saved = read("macaw.session")

    void sdk.provider
      .list()
      .then((res) => {
        if (!alive()) return
        const all = res.data?.all ?? []
        apply(all, dir)
      })
      .catch((err) => {
        if (alive()) setState("error", err instanceof Error ? err.message : String(err))
      })

    void sdk.session
      .status()
      .then((res) => {
        if (alive()) setState("status", res.data ?? {})
      })
      .catch(() => undefined)

    void sdk.question
      .list()
      .then((res) => {
        if (!alive()) return
        const grouped: Record<string, QuestionRequest[]> = {}
        for (const q of res.data ?? []) {
          if (!q.sessionID) continue
          grouped[q.sessionID] = grouped[q.sessionID] ?? []
          grouped[q.sessionID].push(q)
        }
        setState("questions", grouped)
      })
      .catch(() => undefined)

    void sdk.permission
      .list()
      .then((res) => {
        if (!alive()) return
        const grouped: Record<string, PermissionRequest[]> = {}
        for (const p of res.data ?? []) {
          grouped[p.sessionID] = grouped[p.sessionID] ?? []
          grouped[p.sessionID].push(p)
        }
        setState("permissions", grouped)
      })
      .catch(() => undefined)

    void sdk.session
      .list()
      .then(async (res) => {
        if (!alive()) return
        const list = [...(res.data ?? [])].filter((s) => !s.parentID).sort(sessionSort)
        setState("sessions", list)
        saveCachedSessions(props.server, list)

        const hit = saved ? list.find((item) => item.id === saved) : undefined
        if (saved && hit) {
          const [msgs, todos] = await Promise.all([
            sdk.session.messages({ sessionID: saved, limit: 200 }).catch(() => undefined),
            sdk.session.todo({ sessionID: saved }).catch(() => undefined),
          ])
          if (!alive()) return
          setState({ current: saved, messages: msgs?.data ?? [], todos: todos?.data ?? [] })
          return
        }
        if (list[0]) await loadSession(list[0].id, dir)
      })
      .catch((err) => {
        if (alive()) setState("error", err instanceof Error ? err.message : String(err))
      })

    setState("loading", false)
  }

  const fallbackRuntime: {
    watcher?: ReturnType<typeof createFallback>
    sessionID?: string
    queue: string[]
    text: string
    agent: string
    attachments: Attachment[]
  } = {
    queue: [],
    text: "",
    agent: "",
    attachments: [],
  }

  function clearFallback() {
    fallbackRuntime.watcher?.stop()
    fallbackRuntime.watcher = undefined
    fallbackRuntime.sessionID = undefined
    fallbackRuntime.queue = []
    fallbackRuntime.text = ""
    fallbackRuntime.agent = ""
    fallbackRuntime.attachments = []
  }

  function pushToast(toast: Toast) {
    setState("toasts", (list) => [...list.slice(-2), toast])
    setTimeout(() => setState("toasts", (list) => list.filter((item) => item.id !== toast.id)), 5000)
  }

  function dismissToast(id: string) {
    setState("toasts", (list) => list.filter((item) => item.id !== id))
  }

  function fire(kind: Toast["kind"], title: string, body: string, sessionID?: string) {
    if (!state.notify[kind]) return
    pushToast({ id: crypto.randomUUID(), kind, title, body, sessionID })
    void platform.notify(title, body)
  }

  async function sendPrompt(sessionID: string, agent: string, host: string, text: string, attachments: Attachment[]) {
    const pick = split(host)
    await client().session.promptAsync({
      sessionID,
      agent,
      model: {
        providerID: pick.provider,
        modelID: pick.model,
      },
      parts: [
        ...attachments.map((item) => ({
          type: "file" as const,
          mime: item.mime,
          url: item.url,
          filename: item.filename,
        })),
        ...(text ? [{ type: "text" as const, text }] : []),
      ],
    })
  }

  function armFallback(sessionID: string) {
    fallbackRuntime.watcher?.stop()
    if (!state.autoFallback) return
    if (fallbackRuntime.queue.length === 0) return
    fallbackRuntime.watcher = createFallback({
      timeoutMs: FALLBACK_TIMEOUT_MS,
      onStall: () => void onStall(sessionID),
    })
  }

  function data(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ""))
      reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`))
      reader.readAsDataURL(file)
    })
  }

  const textExt = new Set([
    "txt", "md", "markdown", "rst", "log",
    "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "ini", "cfg", "env",
    "js", "jsx", "ts", "tsx", "py", "rb", "rs", "go", "java", "kt", "swift",
    "c", "h", "cpp", "hpp", "cc", "cs", "php", "sh", "bash", "zsh", "ps1",
    "sql", "html", "htm", "css", "scss", "less", "vue", "svelte",
  ])

  const mimeByExt = new Map<string, string>([
    ["pdf", "application/pdf"],
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["svg", "image/svg+xml"],
    ["json", "application/json"],
    ["xml", "application/xml"],
  ])

  function mimeFromName(name: string) {
    const dot = name.lastIndexOf(".")
    const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
    const direct = mimeByExt.get(ext)
    if (direct) return direct
    if (textExt.has(ext)) return "text/plain"
    return "application/octet-stream"
  }

  function mimeFor(file: File) {
    if (file.type) return file.type
    return mimeFromName(file.name)
  }

  function basename(filepath: string) {
    const idx = filepath.search(/[/\\][^/\\]*$/)
    return idx === -1 ? filepath : filepath.slice(idx + 1)
  }

  function fileUrl(filepath: string) {
    const normalized = filepath.replace(/\\/g, "/")
    const head = normalized.startsWith("/") ? "file://" : "file:///"
    return head + encodeURI(normalized).replace(/#/g, "%23").replace(/\?/g, "%3F")
  }

  async function addFiles(list: FileList | null) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    const next = await Promise.all(
      files.map((file) =>
        data(file)
          .then((url): Attachment => ({
            id: crypto.randomUUID(),
            mime: mimeFor(file),
            filename: file.name || "attachment",
            url,
          }))
          .catch((err) => {
            setState("error", `Failed to attach ${file.name}: ${err instanceof Error ? err.message : String(err)}`)
            return undefined
          }),
      ),
    )
    const good = next.filter((item): item is Attachment => item !== undefined)
    if (good.length > 0) setState("attachments", (items) => [...items, ...good])
  }

  function addPaths(paths: string[]) {
    if (paths.length === 0) return
    const next = paths.map((filepath) => {
      const name = basename(filepath) || "attachment"
      const mime = mimeFromName(name)
      const url = fileUrl(filepath)
      return {
        id: crypto.randomUUID(),
        mime,
        filename: name,
        url,
      } satisfies Attachment
    })
    setState("attachments", (items) => [...items, ...next])
  }

  function removeAttachment(id: string) {
    setState("attachments", (items) => items.filter((item) => item.id !== id))
  }

  function clearAttachments() {
    setState("attachments", [])
  }

  async function pickFiles() {
    const dialog = platform.openFilePickerDialog
    if (dialog) {
      const result = await dialog({ multiple: true, title: "Attach files" }).catch((err) => {
        setState("error", err instanceof Error ? err.message : String(err))
        return null
      })
      if (!result) return
      const paths = Array.isArray(result) ? result : [result]
      addPaths(paths.filter((item): item is string => typeof item === "string"))
      return
    }
    picker?.click()
  }

  async function onStall(sessionID: string) {
    if (fallbackRuntime.sessionID !== sessionID) return
    const next = fallbackRuntime.queue.shift()
    if (!next) {
      setState("error", "All favourite models stalled; giving up.")
      clearFallback()
      return
    }
    await client()
      .session.abort({ sessionID })
      .catch(() => undefined)
    const label = models().find((item) => pack(item) === next)?.label ?? next
    setState("error", `No response from previous model; retrying with ${label}...`)
    try {
      await sendPrompt(sessionID, fallbackRuntime.agent, next, fallbackRuntime.text, fallbackRuntime.attachments)
      armFallback(sessionID)
    } catch (err) {
      setState("error", err instanceof Error ? err.message : String(err))
      clearFallback()
    }
  }

  async function submit() {
    const text = state.prompt.trim()
    const files = state.attachments.slice()
    if ((!text && files.length === 0) || state.busy || !state.dir || !state.host) return
    setState("busy", true)
    try {
      let session = state.current
      if (!session) {
        await createSession()
        session = read("macaw.session") ?? state.current
      }
      clearFallback()
      const queue = fallbackQueue(state.host)
      queue.shift()
      fallbackRuntime.sessionID = session
      fallbackRuntime.queue = queue
      fallbackRuntime.text = text
      fallbackRuntime.agent = state.mode
      fallbackRuntime.attachments = files
      await sendPrompt(session, state.mode, state.host, text, files)
      armFallback(session)
      setState("prompt", "")
      requestAnimationFrame(() => grow())
      clearAttachments()
      if (session) await loadSession(session)
    } catch (err) {
      clearFallback()
      if (files.length > 0) setState("attachments", files)
      setState("error", err instanceof Error ? err.message : String(err))
    } finally {
      setState("busy", false)
    }
  }

  function key(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    event.preventDefault()
    void submit()
  }

  function grow(el = input) {
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }

  function drag(side: "left" | "right", down: PointerEvent) {
    if (down.button !== 0) return
    down.preventDefault()
    const grip = down.currentTarget as HTMLDivElement | null
    const root = grip?.parentElement
    if (!root) return
    const box = root.getBoundingClientRect()
    const pick = (x: number) =>
      side === "left" ? clamp(x - box.left, 220, 300) : clamp(box.right - x, 280, 360)
    let px = pick(down.clientX)
    setState(side, px)
    const cursor = document.body.style.cursor
    const select = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    const move = (event: PointerEvent) => {
      px = pick(event.clientX)
      setState(side, px)
    }
    const up = () => {
      document.body.style.cursor = cursor
      document.body.style.userSelect = select
      write(`macaw.${side}`, String(px))
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  function panel(next?: "side" | "pane") {
    const open = next && state.panel !== next ? next : ""
    setState("panel", open)
    requestAnimationFrame(() => {
      const id = open ? `macaw-${open}` : next === "side" ? "macaw-nav" : "macaw-info"
      const root = document.getElementById(id)
      const target = open ? root?.querySelector<HTMLElement>("button, input, select, textarea") : root
      target?.focus()
    })
  }

  function touchFallback(sessionID: string | undefined) {
    if (!sessionID) return
    if (fallbackRuntime.sessionID === sessionID) fallbackRuntime.watcher?.touch()
  }

  function closeSettings() {
    setState({
      settingsOpen: false,
      settingsBusy: false,
      settingsError: "",
    })
  }

  async function openSettings() {
    setState({
      settingsOpen: true,
      settingsBusy: false,
      settingsError: "",
      settings: seed(undefined, state.host, state.notify, state.autoFallback),
    })
    const res = await root()
      .global.config.get()
      .catch((err) => {
        setState("settingsError", err instanceof Error ? err.message : String(err))
        return undefined
      })
    if (res?.data) setState("settings", seed(res.data, state.host, state.settings.notify, state.settings.fallback))
  }

  async function saveSettings() {
    const form = state.settings
    const nextURL = form.kind === "azure" ? azure(form.url) : form.url.trim()
    const nextModel = form.model.trim()
    const nextName = form.name.trim() || AZURE_NAME
    if (form.kind === "azure" && !nextURL) {
      setState("settingsError", "Proxy URL is required.")
      return
    }
    if (form.kind === "azure" && !nextModel) {
      setState("settingsError", "Model is required.")
      return
    }
    setState({
      settingsBusy: true,
      settingsError: "",
    })

    if (form.kind === "azure") {
      const res = await root()
        .global.config.get()
        .catch((err) => {
          setState("settingsError", err instanceof Error ? err.message : String(err))
          return undefined
        })
      const cfg = res?.data
      if (!cfg) {
        setState("settingsBusy", false)
        return
      }
      const prev = cfg.provider?.[AZURE]
      const nextKey = form.key.trim() || (typeof prev?.options?.apiKey === "string" ? prev.options.apiKey : "")
      const next: Config = {
        provider: {
          [AZURE]: {
            name: nextName,
            npm: "@ai-sdk/openai-compatible",
            env: prev?.env ?? [],
            options: {
              ...(prev?.options ?? {}),
              baseURL: nextURL,
              ...(nextKey ? { apiKey: nextKey } : {}),
            },
            models: {
              ...(prev?.models ?? {}),
              [nextModel]: {
                ...(prev?.models?.[nextModel] ?? {}),
                name: prev?.models?.[nextModel]?.name ?? nextModel,
                tool_call: prev?.models?.[nextModel]?.tool_call ?? true,
                limit: prev?.models?.[nextModel]?.limit ?? {
                  context: 128000,
                  output: 8192,
                },
              },
            },
          },
        },
      }
      const saved = await root()
        .global.config.update({ config: next })
        .catch((err) => {
          setState("settingsError", err instanceof Error ? err.message : String(err))
          return undefined
        })
      if (!saved) {
        setState("settingsBusy", false)
        return
      }
      await root()
        .global.dispose()
        .catch(() => undefined)
      write("macaw.azure.url", nextURL)
      write("macaw.azure.model", nextModel)
      write("macaw.azure.name", nextName)
    }

    const res = await client(state.dir)
      .provider.list()
      .catch((err) => {
        setState("settingsError", err instanceof Error ? err.message : String(err))
        return undefined
      })
    if (!res) {
      setState("settingsBusy", false)
      return
    }
    const all = res.data?.all ?? []
    const hit = shape(all).find((item) => item.provider === "ollama")
    apply(
      all,
      state.dir,
      form.kind === "azure"
        ? pack({ provider: AZURE, model: nextModel })
        : hit
          ? pack(hit)
          : undefined,
    )
    setState("notify", { ...form.notify })
    setState("autoFallback", form.fallback)
    closeSettings()
  }

  const tasks = new Set<(event: Event) => void>()
  const listenTasks = (handler: (event: Event) => void) => {
    tasks.add(handler)
    return () => tasks.delete(handler)
  }

  function handle(event: Event, dir: string) {
    if (event.type.startsWith("task.")) {
      for (const fn of tasks) fn(event)
    }
    if (!state.dir || dir !== state.dir) return
    switch (event.type) {
      case "session.created":
      case "session.updated":
        setState("sessions", (list) => upsertSession(list, event.properties.info))
        touchFallback(event.properties.info.id)
        return
      case "session.deleted":
        setState("sessions", (list) => list.filter((item) => item.id !== event.properties.info.id))
        if (state.current === event.properties.info.id) {
          setState("current", "")
          setState("messages", [])
          setState("todos", [])
          setState("attachments", [])
        }
        if (fallbackRuntime.sessionID === event.properties.info.id) clearFallback()
        return
      case "session.status": {
        const sid = event.properties.sessionID
        const prev = state.status[sid]?.type
        setState("status", sid, event.properties.status)
        const status = event.properties.status
        if (sid === state.current && status?.type === "busy") setState("error", "")
        if (fallbackRuntime.sessionID === sid) {
          if (status?.type === "idle") clearFallback()
          else fallbackRuntime.watcher?.touch()
        }
        if (status?.type === "idle" && (prev === "busy" || prev === "retry")) {
          const session = state.sessions.find((item) => item.id === sid)
          const label = session ? title(session) : "Agent reply complete"
          fire("idle", "MACAW", `Done: ${label}`, sid)
        }
        return
      }
      case "message.updated": {
        const sid = event.properties.info.sessionID
        const err = event.properties.info.role === "assistant" ? event.properties.info.error : undefined
        if (sid === state.current) {
          setState("error", fault(err))
          setState("messages", (list) => upsertRow(list, event.properties.info))
        } else if (state.childMessages[sid]) {
          setState("childMessages", sid, (list) => upsertRow(list, event.properties.info))
        }
        touchFallback(sid)
        return
      }
      case "message.removed": {
        const sid = event.properties.sessionID
        const mid = event.properties.messageID
        if (sid === state.current) {
          setState("messages", (list) => list.filter((item) => item.info.id !== mid))
        } else if (state.childMessages[sid]) {
          setState("childMessages", sid, (list) => list.filter((item) => item.info.id !== mid))
        }
        return
      }
      case "message.part.updated": {
        const part = event.properties.part
        const sid = part.sessionID
        if (sid === state.current) {
          setState("error", "")
          setState("messages", (list) => upsertPart(list, part))
          const todos = part.type === "tool" && part.tool === "todowrite" ? toolTodos(part) : undefined
          if (todos) {
            setState("todos", todos)
            stick.follow()
          }
        } else if (state.childMessages[sid]) {
          setState("childMessages", sid, (list) => upsertPart(list, part))
        }
        touchFallback(sid)
        return
      }
      case "session.error": {
        const sid = event.properties.sessionID
        if (sid && sid !== state.current && !state.childMessages[sid]) return
        setState("error", fault(event.properties.error))
        touchFallback(sid)
        return
      }
      case "message.part.delta": {
        const props = event.properties as {
          messageID: string
          partID: string
          field: string
          delta: string
        }
        const applyDelta = (list: Row[]) => {
          const row = list.find((item) => item.info.id === props.messageID)
          if (!row) return
          const part = row.parts.find((item) => item.id === props.partID) as Record<string, unknown> | undefined
          if (!part) return
          const existing = typeof part[props.field] === "string" ? (part[props.field] as string) : ""
          part[props.field] = existing + props.delta
        }
        if (state.messages.some((row) => row.info.id === props.messageID)) {
          setState("messages", produce(applyDelta))
          touchFallback(state.current)
          return
        }
        for (const sid of Object.keys(state.childMessages)) {
          if (state.childMessages[sid].some((row) => row.info.id === props.messageID)) {
            setState("childMessages", sid, produce(applyDelta))
            touchFallback(sid)
            return
          }
        }
        return
      }
      case "message.part.removed": {
        const sid = event.properties.sessionID
        const mid = event.properties.messageID
        const pid = event.properties.partID
        if (sid === state.current) {
          setState("messages", (list) => removePart(list, mid, pid))
        } else if (state.childMessages[sid]) {
          setState("childMessages", sid, (list) => removePart(list, mid, pid))
        }
        return
      }
      case "todo.updated":
        if (event.properties.sessionID !== state.current) return
        setState("todos", event.properties.todos)
        stick.follow()
        return
      case "question.asked": {
        const req = event.properties
        setState("questions", req.sessionID, (list = []) => {
          const idx = list.findIndex((item) => item.id === req.id)
          if (idx === -1) return [...list, req]
          const next = list.slice()
          next[idx] = req
          return next
        })
        touchFallback(req.sessionID)
        const ask = req.questions[0]?.question ?? "Agent has a question"
        fire("question", "MACAW question", ask, req.sessionID)
        return
      }
      case "question.replied":
      case "question.rejected": {
        const sid = event.properties.sessionID
        const rid = event.properties.requestID
        setState("questions", sid, (list = []) => list.filter((item) => item.id !== rid))
        setState(
          "draft",
          produce((d) => {
            delete d[rid]
          }),
        )
        return
      }
      case "permission.asked": {
        const req = event.properties
        setState("permissions", req.sessionID, (list = []) => {
          const idx = list.findIndex((item) => item.id === req.id)
          if (idx === -1) return [...list, req]
          const next = list.slice()
          next[idx] = req
          return next
        })
        touchFallback(req.sessionID)
        fire("permission", "Permission required", permissionLabel(req.permission), req.sessionID)
        return
      }
      case "permission.replied": {
        const sid = event.properties.sessionID
        const rid = event.properties.requestID
        setState("permissions", sid, (list = []) => list.filter((item) => item.id !== rid))
        return
      }
    }
  }

  onMount(() => {
    document.documentElement.style.colorScheme = "light"
    document.documentElement.dataset.colorScheme = "light"
    const media = matchMedia("(min-width: 1180px)")
    const resize = () => {
      if (media.matches) setState("panel", "")
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state.panel) panel(state.panel)
    }
    media.addEventListener("change", resize)
    document.addEventListener("keydown", keydown)
    onCleanup(() => {
      media.removeEventListener("change", resize)
      document.removeEventListener("keydown", keydown)
    })
  })

  onMount(() => {
    const ids = ["session.new", "new-session"]
    const off = ids.map((id) => cmd.register(id, () => void createSession()))
    onCleanup(() => off.forEach((item) => item()))
  })

  onMount(() => {
    const off = (event: MouseEvent) => {
      if (!state.hostOpen) return
      const target = event.target as HTMLElement | null
      if (!target?.closest(".macaw-host")) setState("hostOpen", false)
    }
    document.addEventListener("click", off)
    onCleanup(() => document.removeEventListener("click", off))
  })

  onMount(() => {
    let live = true
    const alive = () => live
    const ctl = new AbortController()
    const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
    void boot(alive)
    const loop = async () => {
      while (live) {
        try {
          const events = await root().global.event({
            signal: ctl.signal,
            onSseError: () => undefined,
          })
          setState("connected", true)
          for await (const item of events.stream) {
            if (!live) return
            handle(item.payload, item.directory)
          }
        } catch {
          if (!live) return
          setState("connected", false)
        }
        if (!live) return
        await wait(500)
      }
    }
    void loop()
    onCleanup(() => {
      live = false
      ctl.abort()
    })
  })

  createEffect(() => {
    const host = state.host
    if (!host || !state.ready) return
    write("macaw.host", host)
    void loadTools(host)
  })

  createEffect(() => {
    write("macaw.mode", state.mode)
  })

  createEffect(() => {
    write("macaw.autoFallback", state.autoFallback ? "on" : "off")
    if (!state.autoFallback) fallbackRuntime.watcher?.stop()
  })

  createEffect(() => {
    write("macaw.notify.idle", state.notify.idle ? "on" : "off")
  })

  createEffect(() => {
    write("macaw.notify.question", state.notify.question ? "on" : "off")
  })

  createEffect(() => {
    write("macaw.notify.permission", state.notify.permission ? "on" : "off")
  })

  createEffect(() => {
    if (!state.ready) return
    saveCachedSessions(props.server, state.sessions)
  })

  createEffect(() => {
    if (!state.current) return
    stick.follow()
  })

  createEffect(() => {
    if (state.current && state.messages.length > 0) return
    stick.clear()
  })

  const examples = [
    "Macaw initiation",
    "Open Notepad and write a summary of clipboard contents",
    "Find all .xlsx files modified this week",
    "Create a PowerPoint presentation from this outline",
  ]

  function ensureDraft(req: QuestionRequest) {
    if (state.draft[req.id]) return
    setState("draft", req.id, {
      tab: 0,
      answers: req.questions.map(() => [] as string[]),
      custom: req.questions.map(() => ""),
      customOn: req.questions.map(() => false),
    })
  }

  function pick(req: QuestionRequest, idx: number, label: string) {
    ensureDraft(req)
    const multi = req.questions[idx]?.multiple === true
    if (multi) {
      setState("draft", req.id, "answers", idx, (cur = []) => {
        if (cur.includes(label)) return cur.filter((item) => item !== label)
        return [...cur, label]
      })
      return
    }
    setState("draft", req.id, "answers", idx, [label])
    setState("draft", req.id, "customOn", idx, false)
  }

  function customSet(req: QuestionRequest, idx: number, value: string) {
    ensureDraft(req)
    const multi = req.questions[idx]?.multiple === true
    const prev = (state.draft[req.id]?.custom[idx] ?? "").trim()
    const next = value.trim()
    setState("draft", req.id, "custom", idx, value)
    if (!state.draft[req.id]?.customOn[idx]) return
    if (multi) {
      setState("draft", req.id, "answers", idx, (cur = []) => {
        const removed = prev ? cur.filter((item) => item !== prev) : cur
        if (!next) return removed
        if (removed.includes(next)) return removed
        return [...removed, next]
      })
      return
    }
    setState("draft", req.id, "answers", idx, next ? [next] : [])
  }

  function customToggle(req: QuestionRequest, idx: number) {
    ensureDraft(req)
    const multi = req.questions[idx]?.multiple === true
    const on = state.draft[req.id]?.customOn[idx] === true
    const text = (state.draft[req.id]?.custom[idx] ?? "").trim()
    setState("draft", req.id, "customOn", idx, !on)
    if (!on) {
      if (!multi) setState("draft", req.id, "answers", idx, text ? [text] : [])
      if (multi && text) {
        setState("draft", req.id, "answers", idx, (cur = []) => (cur.includes(text) ? cur : [...cur, text]))
      }
      return
    }
    if (!multi) {
      setState("draft", req.id, "answers", idx, [])
      return
    }
    if (text) {
      setState("draft", req.id, "answers", idx, (cur = []) => cur.filter((item) => item !== text))
    }
  }

  async function reply(req: QuestionRequest) {
    ensureDraft(req)
    const data = state.draft[req.id]
    const answers = req.questions.map((_, i) => data?.answers[i] ?? [])
    await client()
      .question.reply({ requestID: req.id, answers })
      .catch((err) => {
        setState("error", `Failed to send answer: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  async function dismiss(req: QuestionRequest) {
    await client()
      .question.reject({ requestID: req.id })
      .catch((err) => {
        setState("error", `Failed to dismiss question: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  function SubagentCard(props: { part: ToolPart }) {
    const input = () => (props.part.state.input ?? {}) as { subagent_type?: string; description?: string; prompt?: string }
    const childID = () => {
      const s = props.part.state as unknown as { metadata?: { sessionId?: string } }
      return s.metadata?.sessionId
    }
    const name = () => input().subagent_type ?? "subagent"
    const rows = () => {
      const id = childID()
      return id ? state.childMessages[id] ?? [] : []
    }
    const open = () => {
      const id = childID()
      return id ? !!state.expanded[id] : false
    }
    const clickable = () => !!childID()

    return (
      <div class={`macaw-subagent ${props.part.state.status}`}>
        <button
          type="button"
          class="macaw-subagent-head"
          disabled={!clickable()}
          onClick={() => {
            const id = childID()
            if (id) toggleChild(id)
          }}
        >
          <span class="macaw-subagent-chevron" classList={{ open: open() }}>
            ▸
          </span>
          <span class="macaw-subagent-label">Subagent</span>
          <span class="macaw-subagent-name">{name()}</span>
          <Show when={input().description}>
            <span class="macaw-subagent-desc">{input().description}</span>
          </Show>
          <span class="macaw-subagent-status">{props.part.state.status}</span>
        </button>
        <Show when={open() && childID()}>
          <div class="macaw-subagent-body">
            <Show when={rows().length === 0}>
              <div class="macaw-subagent-empty">Loading...</div>
            </Show>
            <For each={rows()}>
              {(row) => (
                <div class={`macaw-mini-turn ${row.info.role}`}>
                  <div class="macaw-mini-head">
                    <span>{row.info.role === "user" ? name().toUpperCase() : "MACAW"}</span>
                    <span>{formatTime(row.info.time.created)}</span>
                  </div>
                  <Show when={row.info.role === "assistant" && rowReasoningParts(row).length > 0}>
                    <Reasoning row={row} />
                  </Show>
                  <Show when={rowImages(row).length > 0 || rowFiles(row).length > 0}>
                    <div class="macaw-attached">
                      <For each={rowImages(row)}>
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
                      <For each={rowFiles(row)}>
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
                  <Show when={rowText(row)}>
                    <Show
                      when={row.info.role === "assistant"}
                      fallback={<pre class="macaw-text macaw-mini-text">{rowText(row)}</pre>}
                    >
                      <Markdown text={rowText(row)} class="macaw-markdown" />
                    </Show>
                  </Show>
                  <For each={rowTodoTools(row)}>
                    {(part) => (
                      <Show when={part.id !== live()?.id}>
                        <TodoPlan part={part} mini />
                      </Show>
                    )}
                  </For>
                  <Show when={rowOtherTools(row).length > 0}>
                    <div class="macaw-inline-tools">
                      <For each={rowOtherTools(row)}>
                        {(tool) => (
                          <div class={`macaw-inline-tool ${tool.state.status}`}>
                            <span>{tool.tool}</span>
                            <span>{tool.state.status}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <For each={rowShellTools(row)}>{(shell) => <ShellToolCard part={shell} />}</For>
                  <For each={rowTaskTools(row)}>{(inner) => <SubagentCard part={inner} />}</For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    )
  }

  async function permissionReply(req: PermissionRequest, reply: "once" | "always" | "reject") {
    await client()
      .permission.reply({ requestID: req.id, reply })
      .catch((err) => {
        setState("error", `Failed to reply to permission: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  function permissionLabel(perm: string) {
    if (perm === "external_directory") return "External directory access"
    if (perm === "doom_loop") return "Repeated identical tool call"
    return `Run ${perm}`
  }

  function PermissionDock(props: { request: PermissionRequest }) {
    const req = () => props.request
    const tool = () => req().metadata?.["tool"] as string | undefined
    const desc = () => (req().metadata?.["description"] as string | undefined) ?? ""
    return (
      <div class="macaw-permission">
        <div class="macaw-permission-head">
          <span class="macaw-permission-label">Permission required</span>
          <span class="macaw-permission-tool">{permissionLabel(req().permission)}</span>
        </div>
        <Show when={desc()}>
          <p class="macaw-permission-desc">{desc()}</p>
        </Show>
        <Show when={req().patterns.length > 0}>
          <div class="macaw-permission-patterns">
            <For each={req().patterns}>{(pattern) => <pre class="macaw-permission-pattern">{pattern}</pre>}</For>
          </div>
        </Show>
        <Show when={tool()}>
          <div class="macaw-permission-meta">
            <span>tool:</span>
            <code>{tool()}</code>
          </div>
        </Show>
        <div class="macaw-permission-actions">
          <button type="button" class="macaw-permission-reject" onClick={() => void permissionReply(req(), "reject")}>
            Reject
          </button>
          <button type="button" class="macaw-permission-once" onClick={() => void permissionReply(req(), "once")}>
            Allow once
          </button>
          <button type="button" class="macaw-permission-always" onClick={() => void permissionReply(req(), "always")}>
            Allow always
          </button>
        </div>
      </div>
    )
  }

  function QuestionDock(props: { request: QuestionRequest }) {
    const req = () => props.request
    ensureDraft(req())

    const total = () => req().questions.length
    const data = () => state.draft[req().id]
    const tab = () => Math.min(Math.max(0, data()?.tab ?? 0), Math.max(0, total() - 1))
    const setTab = (next: number) => setState("draft", req().id, "tab", clamp(next, 0, total() - 1))
    const q = () => req().questions[tab()]
    const last = () => tab() >= total() - 1

    const picked = (label: string) => data()?.answers[tab()]?.includes(label) ?? false
    const customOn = () => data()?.customOn[tab()] === true
    const customText = () => data()?.custom[tab()] ?? ""
    const allowCustom = () => q()?.custom !== false
    const answered = (i: number) => (data()?.answers[i]?.length ?? 0) > 0
    const ready = () => req().questions.every((_, i) => answered(i))

    function next() {
      if (last()) {
        if (!ready()) return
        void reply(req())
        return
      }
      setTab(tab() + 1)
    }

    return (
      <div class="macaw-question">
        <div class="macaw-question-head">
          <span class="macaw-question-label">
            <Show when={total() > 1}>{`${tab() + 1}/${total()} `}</Show>
            {q()?.header || "Question"}
          </span>
          <Show when={total() > 1}>
            <div class="macaw-question-tabs">
              <For each={req().questions}>
                {(_, i) => (
                  <button
                    type="button"
                    class="macaw-question-tab"
                    classList={{ active: i() === tab(), answered: answered(i()) }}
                    onClick={() => setTab(i())}
                    aria-label={`Question ${i() + 1}`}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
        <p class="macaw-question-text">{q()?.question}</p>
        <Show when={q()?.multiple}>
          <div class="macaw-question-hint">Select all that apply</div>
        </Show>
        <div class="macaw-question-options">
          <For each={q()?.options ?? []}>
            {(opt) => (
              <button
                type="button"
                class="macaw-question-option"
                classList={{ picked: picked(opt.label) }}
                onClick={() => pick(req(), tab(), opt.label)}
              >
                <span
                  class="macaw-question-mark"
                  data-on={picked(opt.label)}
                  data-multi={q()?.multiple ? "true" : "false"}
                >
                  {picked(opt.label) ? "✓" : ""}
                </span>
                <span class="macaw-question-option-main">
                  <span class="macaw-question-option-label">{opt.label}</span>
                  <Show when={opt.description}>
                    <span class="macaw-question-option-desc">{opt.description}</span>
                  </Show>
                </span>
              </button>
            )}
          </For>
          <Show when={allowCustom()}>
            <div class="macaw-question-option custom" classList={{ picked: customOn() }}>
              <button
                type="button"
                class="macaw-question-mark"
                data-on={customOn()}
                data-multi={q()?.multiple ? "true" : "false"}
                onClick={() => customToggle(req(), tab())}
                aria-pressed={customOn()}
              >
                {customOn() ? "✓" : "+"}
              </button>
              <textarea
                class="macaw-question-custom"
                placeholder="Type your own answer..."
                value={customText()}
                rows={1}
                onFocus={() => {
                  if (!customOn()) customToggle(req(), tab())
                }}
                onInput={(event) => customSet(req(), tab(), event.currentTarget.value)}
              />
            </div>
          </Show>
        </div>
        <div class="macaw-question-actions">
          <button type="button" class="macaw-question-dismiss" onClick={() => void dismiss(req())}>
            Dismiss
          </button>
          <Show when={tab() > 0}>
            <button type="button" class="macaw-question-back" onClick={() => setTab(tab() - 1)}>
              Back
            </button>
          </Show>
          <button
            type="button"
            class="macaw-question-next"
            disabled={!answered(tab()) || (last() && !ready())}
            onClick={next}
          >
            {last() ? "Submit" : "Next"}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      class="macaw-shell"
      classList={{ "side-open": state.panel === "side", "pane-open": state.panel === "pane" }}
      style={{ "--macaw-left": `${state.left}px`, "--macaw-right": `${state.right}px` }}
    >
      <Show when={state.settingsOpen}>
        <div
          class="macaw-settings-overlay"
          onClick={(event) => {
            if (event.currentTarget === event.target) closeSettings()
          }}
        >
          <form
            class="macaw-settings-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="macaw-settings-title"
            onSubmit={(event) => {
              event.preventDefault()
              void saveSettings()
            }}
          >
            <div class="macaw-settings-head">
              <div class="macaw-settings-copy">
                <div id="macaw-settings-title" class="macaw-settings-title">
                  Settings
                </div>
                <div class="macaw-settings-subtitle">Workspace preferences</div>
              </div>
              <button type="button" class="macaw-settings-close" aria-label="Close settings" onClick={closeSettings}>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </button>
            </div>
            <div class="macaw-settings-body">
              <section class="macaw-settings-section" aria-labelledby="macaw-settings-provider">
                <div class="macaw-settings-section-head">
                  <div id="macaw-settings-provider" class="macaw-settings-section-title">
                    Provider
                  </div>
                  <div class="macaw-settings-section-note">Choose where Macaw sends your prompts.</div>
                </div>
                <div class="macaw-settings-kind">
                  <button
                    type="button"
                    class="macaw-settings-pick"
                    classList={{ active: state.settings.kind === "ollama" }}
                    onClick={() => {
                      setState("settings", "kind", "ollama")
                      setState("settingsError", "")
                    }}
                  >
                    Local Ollama
                  </button>
                  <button
                    type="button"
                    class="macaw-settings-pick"
                    classList={{ active: state.settings.kind === "azure" }}
                    onClick={() => {
                      setState("settings", "kind", "azure")
                      setState("settingsError", "")
                    }}
                  >
                    Azure AI Foundry
                  </button>
                </div>
                <Show when={state.settings.kind === "azure"}>
                  <div class="macaw-settings-fields">
                    <label class="macaw-settings-field">
                      <span>Proxy URL</span>
                      <input
                        value={state.settings.url}
                        placeholder="http://127.0.0.1:PORT/v1"
                        onInput={(event) => setState("settings", "url", event.currentTarget.value)}
                      />
                    </label>
                    <label class="macaw-settings-field">
                      <span>API Key</span>
                      <input
                        type="password"
                        value={state.settings.key}
                        placeholder="Optional"
                        onInput={(event) => setState("settings", "key", event.currentTarget.value)}
                      />
                    </label>
                    <label class="macaw-settings-field">
                      <span>Model</span>
                      <input
                        value={state.settings.model}
                        placeholder={AZURE_MODEL}
                        onInput={(event) => setState("settings", "model", event.currentTarget.value)}
                      />
                    </label>
                    <label class="macaw-settings-field">
                      <span>Name</span>
                      <input
                        value={state.settings.name}
                        placeholder={AZURE_NAME}
                        onInput={(event) => setState("settings", "name", event.currentTarget.value)}
                      />
                    </label>
                  </div>
                </Show>
              </section>

              <section class="macaw-settings-section" aria-labelledby="macaw-settings-notifications">
                <div class="macaw-settings-section-head">
                  <div id="macaw-settings-notifications" class="macaw-settings-section-title">
                    Notifications
                  </div>
                  <div class="macaw-settings-section-note">Choose when Macaw should get your attention.</div>
                </div>
                <div class="macaw-settings-toggles">
                  <label class="macaw-settings-toggle">
                    <span class="macaw-settings-toggle-copy">
                      <span>Reply finished</span>
                      <small>When the agent completes a response.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={state.settings.notify.idle}
                      onChange={(event) => setState("settings", "notify", "idle", event.currentTarget.checked)}
                    />
                    <span class="macaw-settings-switch" aria-hidden="true" />
                  </label>
                  <label class="macaw-settings-toggle">
                    <span class="macaw-settings-toggle-copy">
                      <span>Agent questions</span>
                      <small>When the agent needs more information.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={state.settings.notify.question}
                      onChange={(event) => setState("settings", "notify", "question", event.currentTarget.checked)}
                    />
                    <span class="macaw-settings-switch" aria-hidden="true" />
                  </label>
                  <label class="macaw-settings-toggle">
                    <span class="macaw-settings-toggle-copy">
                      <span>Permission requests</span>
                      <small>When an action is waiting for approval.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={state.settings.notify.permission}
                      onChange={(event) => setState("settings", "notify", "permission", event.currentTarget.checked)}
                    />
                    <span class="macaw-settings-switch" aria-hidden="true" />
                  </label>
                </div>
              </section>

              <section class="macaw-settings-section" aria-labelledby="macaw-settings-behavior">
                <div class="macaw-settings-section-head">
                  <div id="macaw-settings-behavior" class="macaw-settings-section-title">
                    Behavior
                  </div>
                  <div class="macaw-settings-section-note">Control how Macaw handles stalled responses.</div>
                </div>
                <div class="macaw-settings-toggles">
                  <label class="macaw-settings-toggle">
                    <span class="macaw-settings-toggle-copy">
                      <span>Auto-fallback on stall</span>
                      <small>Switch to a favourite model after 90 seconds of silence.</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={state.settings.fallback}
                      onChange={(event) => setState("settings", "fallback", event.currentTarget.checked)}
                    />
                    <span class="macaw-settings-switch" aria-hidden="true" />
                  </label>
                </div>
              </section>

              <Show when={state.settingsError}>
                <div class="macaw-settings-error">{state.settingsError}</div>
              </Show>
            </div>
            <div class="macaw-settings-actions">
              <button type="button" class="macaw-settings-cancel" onClick={closeSettings}>
                Cancel
              </button>
              <button type="submit" class="macaw-settings-save" disabled={state.settingsBusy}>
                {state.settingsBusy ? "Saving..." : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      </Show>

      <div class="macaw-scrim" aria-hidden="true" onClick={() => panel(state.panel || undefined)} />

      <aside id="macaw-side" class="macaw-side" aria-label="Sessions">
        <div class="macaw-brand">
          <div class="macaw-mark">
            <Mark class="macaw-mark-logo" />
            <span class="macaw-mark-word">MACAW</span>
          </div>
          <button type="button" class="macaw-panel-close" aria-label="Close sessions" onClick={() => panel("side")}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
        <div class="macaw-block macaw-actions">
          <button class="macaw-new" type="button" onClick={() => void createSession()}>
            New Session
          </button>
          <button class="macaw-new" type="button" onClick={() => setState("showGraph", true)}>
            MACAW wiki
          </button>
          <button class="macaw-new" type="button" onClick={() => setState("showTasks", true)}>
            MACAW tasks
          </button>
        </div>
        <div class="macaw-block grow">
          <div class="macaw-label">History</div>
          <Show when={state.sessions.length > 0}>
            <div class="macaw-search">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5" />
                <path d="m12.2 12.2 4.1 4.1" />
              </svg>
              <input
                type="search"
                class="macaw-search-input"
                aria-label="Search history"
                placeholder="Search history"
                value={state.filter}
                onInput={(event) => setState("filter", event.currentTarget.value)}
              />
            </div>
          </Show>
          <Show
            when={state.sessions.length > 0}
            fallback={<div class="macaw-empty">No sessions yet</div>}
          >
            <Show
              when={filtered().length > 0}
              fallback={<div class="macaw-empty">No matches</div>}
            >
              <div class="macaw-list">
                <For each={filtered()}>
                  {(item) => (
                  <button
                    type="button"
                    class={`macaw-item${item.id === state.current ? " active" : ""}`}
                    onClick={() => void loadSession(item.id)}
                  >
                    <span class="macaw-item-title">{title(item)}</span>
                    <Show
                      when={
                        state.status[item.id]?.type === "busy" ||
                        state.status[item.id]?.type === "retry"
                      }
                    >
                      <span
                        class="macaw-item-running"
                        role="button"
                        tabIndex={0}
                        aria-label="Stop session"
                        title="Stop"
                        onClick={(event) => {
                          event.stopPropagation()
                          void stop(item.id)
                        }}
                      />
                    </Show>
                    <span class="macaw-item-time">{formatTime(item.time.updated)}</span>
                    <span
                      class="macaw-item-delete"
                      role="button"
                      tabIndex={0}
                      aria-label="Delete session"
                      onClick={(event) => {
                        event.stopPropagation()
                        void remove(item)
                      }}
                    >
                      ×
                    </span>
                  </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
        <div class="macaw-status">
          <div class="macaw-conn">
            <span class={`macaw-dot${state.connected ? " on" : ""}`} />
            <span>{state.connected ? "Connected" : "Disconnected"}</span>
          </div>
          <button type="button" class="macaw-settings-btn" onClick={() => void openSettings()}>
            Settings
          </button>
        </div>
      </aside>

      <div class="macaw-grip" aria-hidden="true" onPointerDown={(event) => drag("left", event)} />

      <main class="macaw-main">
        <header class="macaw-toolbar">
          <button
            id="macaw-nav"
            type="button"
            class="macaw-panel-toggle"
            aria-label="Open sessions"
            aria-controls="macaw-side"
            aria-expanded={state.panel === "side"}
            onClick={() => panel("side")}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 4.5h13v11h-13zM7 4.5v11" />
            </svg>
          </button>
          <div class="macaw-toolbar-copy">
            <strong>{heading() || "New session"}</strong>
            <span>{pretty(currentStatus())}</span>
          </div>
          <button
            id="macaw-info"
            type="button"
            class="macaw-panel-toggle"
            aria-label="Open inspector"
            aria-controls="macaw-pane"
            aria-expanded={state.panel === "pane"}
            onClick={() => panel("pane")}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="6.5" />
              <path d="M10 9v4M10 6.7v.1" />
            </svg>
          </button>
        </header>
        <Show when={state.toasts.length > 0}>
          <div class="macaw-toasts">
            <For each={state.toasts}>
              {(toast) => (
                <button
                  type="button"
                  class={`macaw-toast macaw-toast-${toast.kind}`}
                  onClick={() => {
                    if (toast.sessionID) void loadSession(toast.sessionID)
                    dismissToast(toast.id)
                  }}
                >
                  <span class="macaw-toast-title">{toast.title}</span>
                  <span class="macaw-toast-body">{toast.body}</span>
                  <span
                    class="macaw-toast-close"
                    role="button"
                    aria-label="Dismiss"
                    onClick={(event) => {
                      event.stopPropagation()
                      dismissToast(toast.id)
                    }}
                  >
                    ×
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="macaw-chat">
          <Show
            when={state.current && state.messages.length > 0}
            fallback={
              <div class="macaw-welcome">
                <p class="macaw-guide-copy">
                  Describe a desktop automation task to get started. Type <code>/help</code> for available commands.
                </p>
                <div class="macaw-examples">
                  <For each={examples}>
                    {(item) => (
                      <button type="button" class="macaw-example" onClick={() => setState("prompt", item)}>
                        <span>- {item}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            }
          >
            <div class="macaw-thread" ref={stick.view} onScroll={stick.scroll}>
              <div class="macaw-thread-body" ref={stick.body}>
                <For each={state.messages}>
                  {(row) => (
                    <>
                      <Show when={!thinking() && row.info.id === last() && live()} keyed>
                        {(part) => (
                          <div class="macaw-turn assistant macaw-todo-follow">
                            <div class="macaw-bubble">
                              <TodoPlan part={part} todos={state.todos} live />
                            </div>
                          </div>
                        )}
                      </Show>
                      <div class={`macaw-turn ${row.info.role}`}>
                        <div class="macaw-bubble">
                        <div class="macaw-turn-head">
                          <span>{row.info.role === "user" ? "You" : "MACAW"}</span>
                          <span>{formatTime(row.info.time.created)}</span>
                        </div>
                        <Show when={row.info.role === "assistant" && rowReasoningParts(row).length > 0}>
                          <Reasoning row={row} />
                        </Show>
                        <Show when={rowImages(row).length > 0 || rowFiles(row).length > 0}>
                          <div class="macaw-attached">
                            <For each={rowImages(row)}>
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
                            <For each={rowFiles(row)}>
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
                        <Show when={rowText(row)}>
                          <Show
                            when={row.info.role === "assistant"}
                            fallback={<pre class="macaw-text">{rowText(row)}</pre>}
                          >
                            <Markdown text={rowText(row)} class="macaw-markdown" />
                          </Show>
                        </Show>
                        <For each={rowTodoTools(row)}>
                          {(part) => (
                            <Show when={part.id !== live()?.id}>
                              <TodoPlan part={part} />
                            </Show>
                          )}
                        </For>
                        <Show when={rowOtherTools(row).length > 0}>
                          <div class="macaw-inline-tools">
                            <For each={rowOtherTools(row)}>
                              {(item) => (
                                <div class={`macaw-inline-tool ${item.state.status}`}>
                                  <span>{item.tool}</span>
                                  <span>{item.state.status}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                        <For each={rowShellTools(row)}>{(part) => <ShellToolCard part={part} />}</For>
                        <For each={rowTaskTools(row)}>{(part) => <SubagentCard part={part} />}</For>
                        </div>
                      </div>
                    </>
                  )}
                </For>
                <Show when={thinking()}>
                  <>
                    <Show when={live()} keyed>
                      {(part) => (
                        <div class="macaw-turn assistant macaw-todo-follow">
                          <div class="macaw-bubble">
                            <TodoPlan part={part} todos={state.todos} live />
                          </div>
                        </div>
                      )}
                    </Show>
                    <div class="macaw-turn assistant">
                      <div class="macaw-bubble macaw-thinking">
                      <div class="macaw-turn-head">
                        <span>MACAW</span>
                        <span>{pretty(currentStatus())}</span>
                      </div>
                      <div class="macaw-thinking-indicator" aria-label="Thinking">
                        <span class="macaw-reasoning-label macaw-reasoning-live">Thinking</span>
                        <div class="macaw-dots">
                          <span />
                          <span />
                          <span />
                        </div>
                      </div>
                    </div>
                    </div>
                  </>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        <Show when={pendingPermission()} keyed>
          {(req) => <PermissionDock request={req} />}
        </Show>

        <Show when={pendingQuestion()} keyed>
          {(req) => <QuestionDock request={req} />}
        </Show>

        <div
          class="macaw-compose"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            void addFiles(event.dataTransfer?.files ?? null)
          }}
        >
          <input
            ref={picker}
            class="macaw-file-input"
            type="file"
            multiple
            accept="image/*,.pdf,.txt,.md,.csv,.doc,.docx,.rtf,.json,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*"
            onChange={(event) => {
              void addFiles(event.currentTarget.files)
              event.currentTarget.value = ""
            }}
          />
          <Show when={state.attachments.length > 0}>
            <div class="macaw-attachments">
              <For each={state.attachments}>
                {(item) => (
                  <div class="macaw-attach-chip">
                    <Show
                      when={item.mime.startsWith("image/")}
                      fallback={<span class="macaw-attach-file">FILE</span>}
                    >
                      <img src={item.url} alt={item.filename} />
                    </Show>
                    <span class="macaw-attach-info">
                      <span class="macaw-attach-name">{item.filename}</span>
                      <span class="macaw-attach-mime">{item.mime}</span>
                    </span>
                    <button
                      type="button"
                      class="macaw-attach-remove"
                      aria-label={`Remove ${item.filename}`}
                      onClick={() => removeAttachment(item.id)}
                    >
                      x
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <select
            class="macaw-mode"
            value={state.mode}
            onChange={(event) =>
              setState("mode", event.currentTarget.value as "build" | "file_shell" | "zero_trust" | "corporate_search")
            }
          >
            <option value="build">Normal</option>
            <option value="file_shell">File &amp; Shell</option>
            <option value="zero_trust">Zero Trust</option>
            <option value="corporate_search">TEF Search</option>
          </select>
          <button type="button" class="macaw-attach" onClick={pickFiles} aria-label="Attach files" title="Attach files">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M9 3h2v6h6v2h-6v6H9v-6H3V9h6z" />
            </svg>
          </button>
          <textarea
            ref={input}
            class="macaw-input"
            rows={1}
            value={state.prompt}
            onInput={(event) => {
              setState("prompt", event.currentTarget.value)
              grow(event.currentTarget)
            }}
            onKeyDown={key}
            placeholder="Describe a task..."
          />
          <Show
            when={working() && state.current}
            fallback={
              <button
                class="macaw-send"
                type="button"
                disabled={state.busy || (!state.prompt.trim() && state.attachments.length === 0)}
                onClick={() => void submit()}
              aria-label="Send"
            >
                {state.busy ? (
                  "..."
                ) : (
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M4 10h12m-5-5 5 5-5 5" />
                  </svg>
                )}
              </button>
            }
          >
            <button
              class="macaw-send macaw-stop"
              type="button"
              onClick={() => void stop()}
              aria-label="Stop agent"
              title="Stop"
            >
              ■
            </button>
          </Show>
        </div>

        <div class="macaw-foot">
          <div class="macaw-note">Agent actions are executed locally. Review sensitive operations.</div>
        </div>
      </main>

      <div class="macaw-grip" aria-hidden="true" onPointerDown={(event) => drag("right", event)} />

      <aside id="macaw-pane" class="macaw-pane" aria-label="Inspector">
        <div class="macaw-pane-head">
          <div class="macaw-pane-title">Inspector</div>
          <button type="button" class="macaw-panel-close" aria-label="Close inspector" onClick={() => panel("pane")}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>

        <div class="macaw-selects">
          <div class="macaw-select macaw-host">
            <span>Main Agent</span>
            <button
              type="button"
              class="macaw-host-trigger"
              title={currentLabel() || "Select model"}
              onClick={() => setState("hostOpen", !state.hostOpen)}
              aria-haspopup="listbox"
              aria-expanded={state.hostOpen}
            >
              <span class="macaw-host-label">{currentLabel() || "Select model"}</span>
              <span class="macaw-host-chevron" classList={{ open: state.hostOpen }}>
                ▾
              </span>
            </button>
            <Show when={state.hostOpen}>
              <div class="macaw-host-menu" role="listbox">
                <Show when={orderedModels().fav.length > 0}>
                  <div class="macaw-host-group">Favourites</div>
                  <For each={orderedModels().fav}>
                    {(item) => {
                      const id = pack(item)
                      const active = () => state.host === id
                      return (
                        <div class="macaw-host-row" classList={{ active: active() }}>
                          <button
                            type="button"
                            class="macaw-host-star on"
                            aria-label="Unfavourite"
                            title="Unfavourite"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleFavorite(id)
                            }}
                          >
                            ★
                          </button>
                          <button
                            type="button"
                            class="macaw-host-pick"
                            onClick={() => {
                              setState("host", id)
                              setState("hostOpen", false)
                            }}
                          >
                            {item.label}
                          </button>
                        </div>
                      )
                    }}
                  </For>
                </Show>
                <Show when={orderedModels().rest.length > 0}>
                  <Show when={orderedModels().fav.length > 0}>
                    <div class="macaw-host-group">All</div>
                  </Show>
                  <For each={orderedModels().rest}>
                    {(item) => {
                      const id = pack(item)
                      const active = () => state.host === id
                      return (
                        <div class="macaw-host-row" classList={{ active: active() }}>
                          <button
                            type="button"
                            class="macaw-host-star"
                            aria-label="Favourite"
                            title="Favourite"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleFavorite(id)
                            }}
                          >
                            ☆
                          </button>
                          <button
                            type="button"
                            class="macaw-host-pick"
                            onClick={() => {
                              setState("host", id)
                              setState("hostOpen", false)
                            }}
                          >
                            {item.label}
                          </button>
                        </div>
                      )
                    }}
                  </For>
                </Show>
              </div>
            </Show>
          </div>
          <div class="macaw-url">{url()}</div>
        </div>

        <div class="macaw-tabs">
          <button
            type="button"
            class={state.tab === "steps" ? "active" : ""}
            onClick={() => setState("tab", "steps")}
          >
            Steps
          </button>
          <button
            type="button"
            class={state.tab === "tools" ? "active" : ""}
            onClick={() => setState("tab", "tools")}
          >
            Tools
          </button>
        </div>

        <Show
          when={state.tab === "steps"}
          fallback={
            <div class="macaw-pane-list">
              <For each={state.tools}>
                {(item) => {
                  const key = () => `tool:${item.id}`
                  const open = () => !!state.expanded[key()]
                  const toggle = () => setState("expanded", key(), !open())
                  return (
                    <div class={`macaw-tool${running().has(item.id) ? " active" : ""}`}>
                      <button
                        type="button"
                        class="macaw-tool-head"
                        onClick={toggle}
                        aria-expanded={open()}
                      >
                        <span class="macaw-pane-head-main">
                          <span class="macaw-reasoning-chevron" classList={{ open: open() }}>
                            ▸
                          </span>
                          <span>{item.id}</span>
                        </span>
                        <span>{usage().get(item.id) ?? 0}</span>
                      </button>
                      <Show when={open()}>
                        <p>{item.description}</p>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          }
        >
          <div class="macaw-pane-list">
            <Show
              when={steps().length > 0}
              fallback={<div class="macaw-empty">No steps yet</div>}
            >
              <For each={steps()}>
                {(item) => {
                  const key = () => `step:${item.id}`
                  const open = () => !!state.expanded[key()]
                  const toggle = () => setState("expanded", key(), !open())
                  return (
                    <div class={`macaw-step ${item.state.status}`}>
                      <button
                        type="button"
                        class="macaw-step-head"
                        onClick={toggle}
                        aria-expanded={open()}
                      >
                        <span class="macaw-pane-head-main">
                          <span class="macaw-reasoning-chevron" classList={{ open: open() }}>
                            ▸
                          </span>
                          <span>{item.tool}</span>
                        </span>
                        <span>{item.state.status}</span>
                      </button>
                      <Show when={open()}>
                        <p>{preview(item)}</p>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>
        </Show>

        <Show when={state.error}>
          <div class="macaw-error">{state.error}</div>
        </Show>
      </aside>
      <MemoryGraph
        open={state.showGraph}
        onClose={() => setState("showGraph", false)}
        server={props.server.http}
      />
      <TasksView
        open={state.showTasks}
        onClose={() => setState("showTasks", false)}
        server={props.server.http}
        onOpenSession={(id) => void loadSession(id)}
        onEvent={listenTasks}
      />
    </div>
  )
}
