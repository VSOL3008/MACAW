import { Markdown } from "@macaw/ui/markdown"
import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerConnection } from "@/context/server"

type GraphNode = {
  id: string
  label: string
  category: string
  size: number
  indegree: number
  outdegree: number
}

type GraphEdge = {
  source: string
  target: string
}

type GraphStats = {
  total_nodes: number
  total_edges: number
  visible_nodes: number
  visible_edges: number
  query_nodes: number
  sampled: boolean
  indexing: boolean
  indexed_nodes: number
  index_total: number
  cache_age: number
  last_error?: string
}

type GraphData = {
  root: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
}

type PageItem = GraphNode & {
  modified: number
}

type StatusData = {
  root: string
  indexing: boolean
  indexed: number
  total: number
  pages: number
  links: number
  cache: boolean
  cache_age: number
  last_error?: string
}

type PagesData = {
  root: string
  items: PageItem[]
  next_cursor?: string
  stats: StatusData & {
    total_matches: number
  }
}

type PlotNode = GraphNode & {
  x: number
  y: number
  lx: number
  ly: number
  anchor: "start" | "middle" | "end"
}

type GraphLine = GraphEdge & {
  x1: number
  y1: number
  x2: number
  y2: number
}

type Hub = {
  category: string
  x: number
  y: number
  count: number
  radius: number
}

type WikiState = {
  paging: boolean
  graphing: boolean
  error: string | null
  raw: string
  query: string
  mode: "reader" | "graph"
  pages: PageItem[]
  next: string | undefined
  matches: number
  status: StatusData
  data: GraphData
  selected: string | null
  preview: { path: string; content: string } | null
  gq: string
}

const CATEGORY_ORDER = ["core", "entities", "projects", "preferences", "facts", "skills", "other"] as const
const GOLDEN = Math.PI * (3 - Math.sqrt(5))
const LIMIT = 1200
const WIDTH = 1200
const HEIGHT = 840
const EMPTY_STATUS: StatusData = {
  root: "",
  indexing: false,
  indexed: 0,
  total: 0,
  pages: 0,
  links: 0,
  cache: false,
  cache_age: 0,
}
const EMPTY_GRAPH: GraphData = {
  root: "",
  nodes: [],
  edges: [],
  stats: {
    total_nodes: 0,
    total_edges: 0,
    visible_nodes: 0,
    visible_edges: 0,
    query_nodes: 0,
    sampled: false,
    indexing: false,
    indexed_nodes: 0,
    index_total: 0,
    cache_age: 0,
  },
}

function authHeaders(server: ServerConnection.HttpBase): Record<string, string> {
  if (!server.password) return {}
  return {
    Authorization: `Basic ${btoa(`${server.username ?? "macaw"}:${server.password}`)}`,
  }
}

async function fetchStatus(server: ServerConnection.HttpBase): Promise<StatusData> {
  const res = await fetch(new URL("/global/memory/status", server.url).toString(), {
    headers: authHeaders(server),
  })
  return json<StatusData>(res, "status")
}

async function fetchPages(server: ServerConnection.HttpBase, query: string, cursor?: string): Promise<PagesData> {
  const url = new URL("/global/memory/pages", server.url)
  url.searchParams.set("limit", "140")
  if (query) url.searchParams.set("query", query)
  if (cursor) url.searchParams.set("cursor", cursor)
  const res = await fetch(url.toString(), {
    headers: authHeaders(server),
  })
  return json<PagesData>(res, "pages")
}

async function fetchGraph(server: ServerConnection.HttpBase, query: string): Promise<GraphData> {
  const url = new URL("/global/memory/graph", server.url)
  url.searchParams.set("limit", String(LIMIT))
  if (query) url.searchParams.set("query", query)
  const res = await fetch(url.toString(), {
    headers: authHeaders(server),
  })
  return json<GraphData>(res, "graph")
}

async function fetchPage(server: ServerConnection.HttpBase, path: string): Promise<string> {
  const url = new URL("/global/memory/page", server.url)
  url.searchParams.set("path", path)
  const res = await fetch(url.toString(), { headers: authHeaders(server) })
  const data = await json<{ path: string; content: string }>(res, "page")
  return data.content
}

function bucket(category: string) {
  return (CATEGORY_ORDER as readonly string[]).includes(category) ? category : "other"
}

function rank(category: string) {
  const idx = (CATEGORY_ORDER as readonly string[]).indexOf(bucket(category))
  return idx === -1 ? CATEGORY_ORDER.length : idx
}

function score(node: GraphNode) {
  return node.indegree * 2 + node.outdegree + Math.log2(node.size + 8)
}

function format(value: number) {
  return value.toLocaleString()
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function shorten(value: string) {
  return value.length > 34 ? `${value.slice(0, 33).trimEnd()}\u2026` : value
}

async function json<T>(res: Response, label: string): Promise<T> {
  const text = await res.text()
  if (!res.ok) throw new Error(`${label} fetch failed: ${res.status}`)
  if (/^\s*</.test(text)) {
    throw new Error(`${label} returned the app HTML. Reload the backend so the memory API routes are available.`)
  }
  return JSON.parse(text) as T
}

function layout(nodes: GraphNode[]): PlotNode[] {
  if (nodes.length === 0) return []
  const groups = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const cat = bucket(node.category)
    const list = groups.get(cat) ?? []
    list.push(node)
    groups.set(cat, list)
  }
  const cats = [...groups.keys()].sort((a, b) => rank(a) - rank(b))
  const gap = nodes.length <= 32 ? 46 : nodes.length <= 120 ? 38 : nodes.length <= 400 ? 30 : 24
  const sets = cats.map((cat) => ({
    cat,
    items: (groups.get(cat) ?? []).slice().sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)),
  }))
  const reach = Math.max(...sets.map((set) => Math.sqrt(Math.max(0, set.items.length - 1)) * gap + 48))
  const ring = sets.length === 1 ? 0 : Math.max(230, reach / (Math.sin(Math.PI / sets.length) * 0.86) + 28)

  return sets.flatMap((set, idx) => {
    const angle = (idx / Math.max(1, sets.length)) * Math.PI * 2 - Math.PI / 2
    const cx = Math.cos(angle) * ring
    const cy = Math.sin(angle) * ring * 0.86
    return set.items.map((node, i) => {
      const turn = Math.max(0, i - 1) * GOLDEN + idx * 0.55
      const spread = Math.sqrt(i) * gap
      const dx = Math.cos(turn) * spread
      const dy = Math.sin(turn) * spread * 0.84
      const r = radius(node)
      const side = i > 0 && Math.abs(dx) > Math.abs(dy) * 0.8
      const sign = dx < 0 ? -1 : 1
      return {
        ...node,
        x: cx + dx,
        y: cy + dy,
        lx: side ? sign * (r + 8) : 0,
        ly: side ? 4 : dy < 0 ? -r - 8 : r + 14,
        anchor: side ? (sign < 0 ? "end" : "start") : "middle",
      }
    })
  })
}

function radius(node: GraphNode) {
  return Math.max(5.5, Math.min(15, 5.5 + Math.log2(node.indegree + node.outdegree + 2) * 2.15))
}

function known(node: PlotNode | undefined): node is PlotNode {
  return node !== undefined
}

function hubs(nodes: PlotNode[]): Hub[] {
  const map = new Map<string, Omit<Hub, "radius">>()
  for (const node of nodes) {
    const cat = bucket(node.category)
    const item = map.get(cat) ?? { category: cat, x: 0, y: 0, count: 0 }
    item.x += node.x
    item.y += node.y
    item.count++
    map.set(cat, item)
  }
  return [...map.values()]
    .map((hub) => {
      const x = hub.x / hub.count
      const y = hub.y / hub.count
      const r = Math.max(
        54,
        ...nodes
          .filter((node) => bucket(node.category) === hub.category)
          .map((node) => Math.hypot(node.x - x, node.y - y) + radius(node) + 26),
      )
      return { ...hub, x, y, radius: r }
    })
    .sort((a, b) => rank(a.category) - rank(b.category))
}

export function MemoryGraph(props: { open: boolean; onClose: () => void; server: ServerConnection.HttpBase }) {
  const [state, setState] = createStore<WikiState>({
    paging: false,
    graphing: false,
    error: null,
    raw: "",
    query: "",
    mode: "reader",
    pages: [],
    next: undefined,
    matches: 0,
    status: EMPTY_STATUS,
    data: EMPTY_GRAPH,
    selected: null,
    preview: null,
    gq: "",
  })
  const [view, setView] = createStore({ tx: 0, ty: 0, scale: 1 })

  let svg: SVGSVGElement | undefined
  let canvas: HTMLCanvasElement | undefined
  let ro: ResizeObserver | undefined
  let frame: number | undefined
  let prun = 0
  let grun = 0

  const sim = createMemo(() => layout(state.data.nodes))
  const byId = createMemo(() => new Map(sim().map((node) => [node.id, node] as const)))
  const lines = createMemo<GraphLine[]>(() =>
    state.data.edges.flatMap((edge) => {
      const a = byId().get(edge.source)
      const b = byId().get(edge.target)
      if (!a || !b) return []
      return [
        {
          ...edge,
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
        },
      ]
    }),
  )
  const hub = createMemo(() => hubs(sim()))

  const categoryCounts = createMemo(() => {
    const map = new Map<string, number>()
    for (const node of sim()) map.set(bucket(node.category), (map.get(bucket(node.category)) ?? 0) + 1)
    return map
  })

  const groups = createMemo(() => {
    const map = new Map<string, PageItem[]>()
    for (const item of state.pages) {
      const cat = bucket(item.category)
      const list = map.get(cat) ?? []
      list.push(item)
      map.set(cat, list)
    }
    const out: { category: string; items: PageItem[] }[] = []
    for (const [category, items] of map) {
      items.sort((a, b) => a.label.localeCompare(b.label))
      out.push({ category, items })
    }
    out.sort((a, b) => rank(a.category) - rank(b.category))
    return out
  })

  const selected = createMemo(() => (state.selected ? byId().get(state.selected) : undefined))
  const connected = createMemo(() => {
    const id = state.selected
    if (!id) return null
    const set = new Set<string>([id])
    for (const edge of state.data.edges) {
      if (edge.source === id) set.add(edge.target)
      else if (edge.target === id) set.add(edge.source)
    }
    return set
  })
  const outs = createMemo(() => {
    const id = state.selected
    if (!id) return []
    return state.data.edges
      .filter((edge) => edge.source === id)
      .map((edge) => byId().get(edge.target))
      .filter(known)
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
  })
  const ins = createMemo(() => {
    const id = state.selected
    if (!id) return []
    return state.data.edges
      .filter((edge) => edge.target === id)
      .map((edge) => byId().get(edge.source))
      .filter(known)
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
  })
  const rel = createMemo(() => {
    const map = new Map<string, PlotNode>()
    for (const node of [...outs(), ...ins()]) map.set(node.id, node)
    return [...map.values()].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)).slice(0, 36)
  })
  const top = createMemo(() => {
    const size = Math.min(36, Math.max(12, Math.round(Math.sqrt(sim().length) || 0)))
    return new Set(
      sim()
        .slice()
        .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
        .slice(0, size)
        .map((node) => node.id),
    )
  })
  const labels = createMemo(() => {
    const primary = (sim().length <= 48 ? sim() : sim().filter((node) => top().has(node.id)))
      .slice()
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
    const pool = state.selected ? [selected(), ...rel().slice(0, 16), ...primary].filter(known) : primary
    const set = new Set<string>()
    const boxes: { x: number; y: number; w: number; h: number }[] = []
    const limit = Math.min(28, Math.max(10, Math.round(Math.sqrt(sim().length) * 3)))

    for (const node of pool) {
      if (set.has(node.id) || set.size >= limit) continue
      const w = Math.min(190, Math.max(44, shorten(node.label).length * 6.2))
      const x = node.x + node.lx - (node.anchor === "middle" ? w / 2 : node.anchor === "end" ? w : 0)
      const box = { x, y: node.y + node.ly - 12, w, h: 17 }
      const hit = boxes.some(
        (item) =>
          box.x < item.x + item.w + 7 &&
          box.x + box.w + 7 > item.x &&
          box.y < item.y + item.h + 5 &&
          box.y + box.h + 5 > item.y,
      )
      const cover = sim().some((item) => {
        if (item.id === node.id) return false
        const r = radius(item) + 5
        return box.x < item.x + r && box.x + box.w > item.x - r && box.y < item.y + r && box.y + box.h > item.y - r
      })
      if ((hit || cover) && node.id !== state.selected) continue
      boxes.push(box)
      set.add(node.id)
    }
    return set
  })
  const note = createMemo(() => {
    if (state.status.last_error) return `Index warning: ${state.status.last_error}`
    if (state.status.indexing) {
      const total = state.status.total > 0 ? format(state.status.total) : "..."
      return `Indexing memory: ${format(state.status.indexed)} / ${total} pages.`
    }
    if (state.mode === "graph" && state.data.stats.sampled) {
      if (state.query) {
        return `Showing ${format(state.data.stats.visible_nodes)} graph pages for ${format(state.data.stats.query_nodes)} matches.`
      }
      return `Showing ${format(state.data.stats.visible_nodes)} of ${format(state.data.stats.total_nodes)} graph pages.`
    }
    if (state.matches > state.pages.length)
      return `Showing ${format(state.pages.length)} of ${format(state.matches)} pages.`
    return ""
  })

  async function loadStatus() {
    const data = await fetchStatus(props.server).catch((err) => {
      setState("error", message(err))
      return undefined
    })
    if (!data) return
    setState("status", data)
  }

  async function loadPages(term: string, cursor?: string) {
    const id = ++prun
    setState("paging", true)
    setState("error", null)
    if (!cursor) {
      setState("pages", [])
      setState("next", undefined)
      setState("matches", 0)
    }
    const data = await fetchPages(props.server, term, cursor).catch((err) => {
      setState("error", message(err))
      return undefined
    })
    if (id !== prun) return
    if (data) {
      setState("pages", (items) => (cursor ? [...items, ...data.items] : data.items))
      setState("next", data.next_cursor)
      setState("matches", data.stats.total_matches)
      setState("status", data.stats)
    }
    setState("paging", false)
  }

  async function loadGraph(term: string) {
    const id = ++grun
    setState("graphing", true)
    setState("error", null)
    const data = await fetchGraph(props.server, term).catch((err) => {
      setState("error", message(err))
      return undefined
    })
    if (id !== grun) return
    if (data) {
      setState("data", data)
      setState("status", {
        root: data.root,
        indexing: data.stats.indexing,
        indexed: data.stats.indexed_nodes,
        total: data.stats.index_total,
        pages: data.stats.total_nodes,
        links: data.stats.total_edges,
        cache: data.stats.cache_age > 0,
        cache_age: data.stats.cache_age,
        last_error: data.stats.last_error,
      })
      setState("gq", term)
      requestAnimationFrame(fit)
    }
    setState("graphing", false)
  }

  async function fetchInto(path: string) {
    setState("selected", path)
    const content = await fetchPage(props.server, path).catch((err) => `Failed to load: ${message(err)}`)
    setState("preview", { path, content })
  }

  function openPage(path: string) {
    setState("mode", "reader")
    void fetchInto(path)
  }

  function refresh() {
    void loadStatus()
    void loadPages(state.query)
    if (state.mode === "graph") void loadGraph(state.query)
  }

  function reset() {
    setView({ tx: 0, ty: 0, scale: 1 })
  }

  function color(style: CSSStyleDeclaration, key: string, fallback: string) {
    return style.getPropertyValue(key).trim() || fallback
  }

  function trace(ctx: CanvasRenderingContext2D, row: GraphLine, fit: number, ox: number, oy: number) {
    const x1 = (row.x1 * view.scale + view.tx + WIDTH / 2) * fit + ox
    const y1 = (row.y1 * view.scale + view.ty + HEIGHT / 2) * fit + oy
    const x2 = (row.x2 * view.scale + view.tx + WIDTH / 2) * fit + ox
    const y2 = (row.y2 * view.scale + view.ty + HEIGHT / 2) * fit + oy
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.max(1, Math.hypot(dx, dy))
    const hash = row.source.length + row.target.length + row.source.charCodeAt(0) + row.target.charCodeAt(0)
    const bend = Math.min(22, len * 0.055) * (hash % 2 === 0 ? 1 : -1)
    ctx.moveTo(x1, y1)
    ctx.quadraticCurveTo((x1 + x2) / 2 - (dy / len) * bend, (y1 + y2) / 2 + (dx / len) * bend, x2, y2)
  }

  function paint() {
    const el = canvas
    const ctx = el?.getContext("2d")
    if (!el || !ctx) return
    const rect = el.getBoundingClientRect()
    const w = Math.max(1, Math.floor(rect.width))
    const h = Math.max(1, Math.floor(rect.height))
    const ratio = window.devicePixelRatio || 1
    const width = Math.floor(w * ratio)
    const height = Math.floor(h * ratio)
    if (el.width !== width) el.width = width
    if (el.height !== height) el.height = height

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const fit = Math.min(w / WIDTH, h / HEIGHT)
    const ox = (w - WIDTH * fit) / 2
    const oy = (h - HEIGHT * fit) / 2
    const style = getComputedStyle(el)
    const id = state.selected
    const rows = lines()

    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.beginPath()
    for (const row of rows) {
      if (id && (row.source === id || row.target === id)) continue
      trace(ctx, row, fit, ox, oy)
    }
    ctx.strokeStyle = id
      ? color(style, "--mg-edge-dim", "rgba(15, 23, 42, 0.08)")
      : color(style, "--mg-edge", "rgba(15, 23, 42, 0.16)")
    ctx.lineWidth = id ? 0.8 : 1
    ctx.stroke()

    if (!id) return
    ctx.beginPath()
    for (const row of rows) {
      if (row.source !== id && row.target !== id) continue
      trace(ctx, row, fit, ox, oy)
    }
    ctx.strokeStyle = color(style, "--mg-edge-active", "#2563eb")
    ctx.lineWidth = 2
    ctx.shadowColor = color(style, "--mg-edge-glow", "rgba(37, 99, 235, 0.3)")
    ctx.shadowBlur = 7
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  function queue() {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      paint()
    })
  }

  function watch(el: HTMLCanvasElement) {
    canvas = el
    ro?.disconnect()
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(queue)
      ro.observe(el)
    }
    queue()
  }

  function fit() {
    const nodes = sim()
    if (nodes.length === 0) {
      setView({ tx: 0, ty: 0, scale: 1 })
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of nodes) {
      if (node.x < minX) minX = node.x
      if (node.x > maxX) maxX = node.x
      if (node.y < minY) minY = node.y
      if (node.y > maxY) maxY = node.y
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const halfW = Math.max(40, (maxX - minX) / 2)
    const halfH = Math.max(40, (maxY - minY) / 2)
    const pad = 92
    const sx = (WIDTH / 2 - pad) / halfW
    const sy = (HEIGHT / 2 - pad) / halfH
    const scale = Math.min(1.85, Math.max(0.2, Math.min(sx, sy)))
    setView({ scale, tx: -cx * scale, ty: -cy * scale })
  }

  createEffect(() => {
    const value = state.raw.trim()
    const timer = setTimeout(() => setState("query", value), 160)
    onCleanup(() => clearTimeout(timer))
  })

  let wasOpen = false
  let loaded = ""
  createEffect(() => {
    if (!props.open) {
      wasOpen = false
      return
    }
    if (!wasOpen) {
      setState("mode", "reader")
      setState("error", null)
      loaded = state.query
      void loadStatus()
      void loadPages(state.query)
    }
    wasOpen = true
  })

  createEffect(() => {
    const term = state.query
    if (!props.open || !wasOpen || loaded === term) return
    loaded = term
    void loadPages(term)
    if (state.mode === "graph") void loadGraph(term)
  })

  createEffect(() => {
    if (!props.open || state.mode !== "graph") return
    if (state.gq === state.query && state.data.nodes.length > 0) {
      requestAnimationFrame(fit)
      return
    }
    void loadGraph(state.query)
  })

  createEffect(() => {
    if (!props.open || state.mode !== "graph") return
    lines()
    view.scale
    view.tx
    view.ty
    state.selected
    queue()
  })

  createEffect(() => {
    if (!props.open || !state.status.indexing) return
    const timer = setInterval(() => void loadStatus(), 1500)
    onCleanup(() => clearInterval(timer))
  })

  onCleanup(() => {
    ro?.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  let panning = false
  let pan = { x: 0, y: 0, tx: 0, ty: 0 }

  function point(x: number, y: number) {
    if (!svg) return
    const box = svg.getBoundingClientRect()
    const fit = Math.min(box.width / WIDTH, box.height / HEIGHT)
    return {
      x: (x - box.left - (box.width - WIDTH * fit) / 2) / fit - WIDTH / 2,
      y: (y - box.top - (box.height - HEIGHT * fit) / 2) / fit - HEIGHT / 2,
    }
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault()
    const factor = event.deltaY > 0 ? 0.9 : 1.1
    const next = Math.min(3, Math.max(0.2, view.scale * factor))
    const cursor = point(event.clientX, event.clientY)
    if (!cursor) return
    const x = (cursor.x - view.tx) / view.scale
    const y = (cursor.y - view.ty) / view.scale
    setView({ scale: next, tx: cursor.x - x * next, ty: cursor.y - y * next })
  }

  function onCanvasPointerDown(event: PointerEvent) {
    if ((event.target as Element).closest("[data-node]")) return
    const cursor = point(event.clientX, event.clientY)
    if (!cursor) return
    panning = true
    pan = { ...cursor, tx: view.tx, ty: view.ty }
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  }

  function onCanvasPointerMove(event: PointerEvent) {
    if (!panning) return
    const cursor = point(event.clientX, event.clientY)
    if (!cursor) return
    setView({
      tx: pan.tx + cursor.x - pan.x,
      ty: pan.ty + cursor.y - pan.y,
    })
  }

  function onCanvasPointerUp(event: PointerEvent) {
    panning = false
    const el = event.currentTarget as Element
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
  }

  function onDouble(event: MouseEvent) {
    if ((event.target as Element).closest("[data-node]")) return
    fit()
  }

  function onNodeClick(event: MouseEvent, id: string) {
    event.stopPropagation()
    setState("selected", id)
  }

  function onNodeKey(event: KeyboardEvent, id: string) {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    setState("selected", id)
  }

  const viewBox = () => `${-WIDTH / 2} ${-HEIGHT / 2} ${WIDTH} ${HEIGHT}`

  return (
    <Show when={props.open}>
      <div class="macaw-wiki-overlay" role="dialog" aria-label="MACAW wiki">
        <div class="macaw-wiki-card">
          <div class="macaw-wiki-header">
            <div class="macaw-wiki-copy">
              <span class="macaw-wiki-title">MACAW Wiki</span>
              <span class="macaw-wiki-count">
                {format(state.status.pages)} pages, {format(state.status.links)} links
              </span>
            </div>
            <button type="button" class="macaw-wiki-close" onClick={() => props.onClose()} aria-label="Close">
              ×
            </button>
          </div>
          <div class="macaw-wiki-toolbar">
            <input
              type="search"
              class="macaw-wiki-search"
              placeholder="Search pages..."
              value={state.raw}
              onInput={(event) => setState("raw", event.currentTarget.value)}
            />
            <div class="macaw-wiki-modes" role="tablist">
              <button
                type="button"
                class="macaw-wiki-mode"
                classList={{ active: state.mode === "reader" }}
                onClick={() => setState("mode", "reader")}
                role="tab"
                aria-selected={state.mode === "reader"}
              >
                Reader
              </button>
              <button
                type="button"
                class="macaw-wiki-mode"
                classList={{ active: state.mode === "graph" }}
                onClick={() => {
                  setState("mode", "graph")
                }}
                role="tab"
                aria-selected={state.mode === "graph"}
              >
                Graph
              </button>
            </div>
            <div class="macaw-wiki-actions">
              <Show when={state.mode === "graph"}>
                <button type="button" class="macaw-wiki-refresh" onClick={fit} title="Fit graph to view">
                  Fit
                </button>
                <button type="button" class="macaw-wiki-refresh" onClick={reset} title="Reset graph view">
                  Reset
                </button>
              </Show>
              <button type="button" class="macaw-wiki-refresh" onClick={refresh}>
                Refresh
              </button>
            </div>
          </div>
          <div class="macaw-wiki-body">
          <aside class="macaw-wiki-side">
            <Show when={note()}>{(text) => <div class="macaw-wiki-side-note">{text()}</div>}</Show>
            <Show when={state.paging && state.pages.length === 0}>
              <div class="macaw-wiki-side-empty">Loading pages...</div>
            </Show>
            <Show
              when={state.pages.length > 0}
              fallback={
                <Show when={!state.paging}>
                  <div class="macaw-wiki-side-empty">{state.query ? "No matches" : "No pages yet"}</div>
                </Show>
              }
            >
              <For each={groups()}>
                {(group) => (
                  <div class="macaw-wiki-group">
                    <div class="macaw-wiki-group-head">
                      <span>{group.category}</span>
                      <span class="macaw-wiki-group-count">{group.items.length}</span>
                    </div>
                    <For each={group.items}>
                      {(item) => (
                        <button
                          type="button"
                          class="macaw-wiki-item"
                          classList={{ active: state.selected === item.id }}
                          data-category={bucket(item.category)}
                          onClick={() => void openPage(item.id)}
                          title={item.id}
                        >
                          <span class="macaw-wiki-item-dot" />
                          <span class="macaw-wiki-item-label">{item.label}</span>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
            <Show when={state.next}>
              {(cursor) => (
                <button
                  type="button"
                  class="macaw-wiki-more"
                  disabled={state.paging}
                  onClick={() => void loadPages(state.query, cursor())}
                >
                  {state.paging ? "Loading..." : "Load more"}
                </button>
              )}
            </Show>
          </aside>
          <main class="macaw-wiki-main" classList={{ graph: state.mode === "graph" }}>
            <Show when={state.error}>
              <div class="macaw-wiki-state error">{state.error}</div>
            </Show>
            <Show when={!state.error && state.mode === "reader"}>
              <Show
                when={state.preview}
                fallback={
                  <div class="macaw-wiki-state">
                    {state.paging && state.pages.length === 0
                      ? "Loading memory wiki..."
                      : "Pick a page from the left to read."}
                  </div>
                }
              >
                {(value) => (
                  <article class="macaw-wiki-reader">
                    <div class="macaw-wiki-crumb">{value().path}</div>
                    <Markdown text={value().content || "(empty)"} class="macaw-markdown" />
                  </article>
                )}
              </Show>
            </Show>
            <Show when={!state.error && state.mode === "graph"}>
              <div class="macaw-wiki-graph" data-component="macaw-wiki-graph">
                <Show when={state.graphing && sim().length === 0}>
                  <div class="macaw-wiki-state">Loading graph...</div>
                </Show>
                <Show when={!state.graphing && sim().length === 0}>
                  <div class="macaw-wiki-state">No graph pages yet.</div>
                </Show>
                <Show when={sim().length > 0}>
                  <div class="macaw-graph-map">
                    <canvas
                      ref={watch}
                      class="macaw-graph-canvas"
                      data-component="macaw-wiki-graph-canvas"
                      aria-hidden="true"
                    />
                    <svg
                      ref={(el) => {
                        svg = el
                      }}
                      class="macaw-graph-svg"
                      data-component="macaw-wiki-graph-nodes"
                      viewBox={viewBox()}
                      preserveAspectRatio="xMidYMid meet"
                      aria-label="Memory graph. Scroll to zoom, drag empty space to pan, and select a node for details."
                      onWheel={onWheel}
                      onDblClick={onDouble}
                      onPointerDown={onCanvasPointerDown}
                      onPointerMove={onCanvasPointerMove}
                      onPointerUp={onCanvasPointerUp}
                      onPointerCancel={onCanvasPointerUp}
                    >
                      <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
                        <g class="macaw-graph-clusters" aria-hidden="true">
                          <For each={hub()}>
                            {(item) => (
                              <g
                                class="macaw-graph-cluster"
                                data-category={item.category}
                                transform={`translate(${item.x} ${item.y})`}
                              >
                                <circle class="macaw-graph-cluster-ring" r={item.radius} />
                                <text class="macaw-graph-cluster-name" y={-item.radius - 13}>
                                  {item.category} · {item.count}
                                </text>
                              </g>
                            )}
                          </For>
                        </g>
                        <g class="macaw-graph-nodes">
                          <For each={sim()}>
                            {(node) => {
                              const r = () => radius(node)
                              const isSelected = () => state.selected === node.id
                              const linked = () => {
                                const set = connected()
                                return set !== null && set.has(node.id) && !isSelected()
                              }
                              const dim = () => {
                                const set = connected()
                                return set !== null && !set.has(node.id)
                              }
                              return (
                                <g
                                  role="button"
                                  tabIndex={0}
                                  aria-label={node.label}
                                  data-component="macaw-wiki-graph-node"
                                  data-node={node.id}
                                  data-category={bucket(node.category)}
                                  class="macaw-graph-node"
                                  classList={{ selected: isSelected(), linked: linked(), dim: dim() }}
                                  transform={`translate(${node.x} ${node.y})`}
                                  onClick={(event) => onNodeClick(event, node.id)}
                                  onKeyDown={(event) => onNodeKey(event, node.id)}
                                >
                                  <circle class="macaw-graph-node-hit" r={Math.max(r() + 7, 14)} />
                                  <circle class="macaw-graph-node-halo" r={r() + 5} />
                                  <circle class="macaw-graph-node-fill" r={r()} />
                                  <text
                                    class="macaw-graph-node-label"
                                    classList={{ visible: labels().has(node.id) }}
                                    x={node.lx}
                                    y={node.ly}
                                    text-anchor={node.anchor}
                                  >
                                    {shorten(node.label)}
                                  </text>
                                  <title>{node.label}</title>
                                </g>
                              )
                            }}
                          </For>
                        </g>
                      </g>
                    </svg>
                    <div class="macaw-graph-legend">
                      <For each={CATEGORY_ORDER}>
                        {(category) => (
                          <Show when={(categoryCounts().get(category) ?? 0) > 0}>
                            <div class="macaw-graph-legend-item" data-category={category}>
                              <span class="macaw-graph-legend-dot" />
                              <span>{category}</span>
                              <span class="macaw-graph-legend-count">{categoryCounts().get(category)}</span>
                            </div>
                          </Show>
                        )}
                      </For>
                    </div>
                    <div class="macaw-graph-hint" aria-hidden="true">
                      Scroll to zoom · drag to pan · double-click to fit
                    </div>
                  </div>
                </Show>
              </div>
              <aside class="macaw-graph-inspector" data-component="macaw-wiki-graph-inspector">
                <Show
                  when={selected()}
                  fallback={
                    <div class="macaw-graph-inspector-empty">
                      <div class="macaw-graph-inspector-title">No node selected</div>
                      <div class="macaw-graph-inspector-sub">Selection details will appear here.</div>
                    </div>
                  }
                >
                  {(node) => (
                    <>
                      <div class="macaw-graph-inspector-head" data-category={bucket(node().category)}>
                        <span class="macaw-graph-inspector-dot" />
                        <div class="macaw-graph-inspector-copy">
                          <div class="macaw-graph-inspector-title">{node().label}</div>
                          <div class="macaw-graph-inspector-path" title={node().id}>
                            {node().id}
                          </div>
                        </div>
                      </div>
                      <div class="macaw-graph-inspector-stats">
                        <div>
                          <span>{format(node().outdegree)}</span>
                          <small>out</small>
                        </div>
                        <div>
                          <span>{format(node().indegree)}</span>
                          <small>in</small>
                        </div>
                        <div>
                          <span>{bucket(node().category)}</span>
                          <small>group</small>
                        </div>
                      </div>
                      <button
                        type="button"
                        class="macaw-graph-inspector-open"
                        data-component="macaw-wiki-graph-open"
                        onClick={() => openPage(node().id)}
                      >
                        Open page
                      </button>
                      <div class="macaw-graph-related">
                        <div class="macaw-graph-related-head">Related pages</div>
                        <Show
                          when={rel().length > 0}
                          fallback={<div class="macaw-graph-related-empty">No visible links</div>}
                        >
                          <For each={rel()}>
                            {(item) => (
                              <button
                                type="button"
                                class="macaw-graph-related-item"
                                data-category={bucket(item.category)}
                                onClick={() => setState("selected", item.id)}
                                title={item.id}
                              >
                                <span class="macaw-graph-related-dot" />
                                <span>{item.label}</span>
                              </button>
                            )}
                          </For>
                        </Show>
                      </div>
                    </>
                  )}
                </Show>
              </aside>
            </Show>
          </main>
          </div>
        </div>
      </div>
    </Show>
  )
}
