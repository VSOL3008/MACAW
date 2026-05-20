import { Markdown } from "@macaw/ui/markdown"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
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

type GraphData = {
  root: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

type SimNode = GraphNode & {
  x: number
  y: number
  vx: number
  vy: number
  pinned: boolean
}

const CATEGORY_ORDER = ["core", "entities", "projects", "preferences", "facts", "skills", "other"] as const

function authHeaders(server: ServerConnection.HttpBase): Record<string, string> {
  if (!server.password) return {}
  return {
    Authorization: `Basic ${btoa(`${server.username ?? "macaw"}:${server.password}`)}`,
  }
}

async function fetchGraph(server: ServerConnection.HttpBase): Promise<GraphData> {
  const res = await fetch(new URL("/global/memory/graph", server.url).toString(), {
    headers: authHeaders(server),
  })
  if (!res.ok) throw new Error(`graph fetch failed: ${res.status}`)
  return (await res.json()) as GraphData
}

async function fetchPage(server: ServerConnection.HttpBase, path: string): Promise<string> {
  const url = new URL("/global/memory/page", server.url)
  url.searchParams.set("path", path)
  const res = await fetch(url.toString(), { headers: authHeaders(server) })
  if (!res.ok) throw new Error(`page fetch failed: ${res.status}`)
  const data = (await res.json()) as { path: string; content: string }
  return data.content
}

function seed(nodes: GraphNode[]): SimNode[] {
  const sorted = nodes.slice().sort((a, b) => rank(bucket(a.category)) - rank(bucket(b.category)))
  const radius = Math.max(320, nodes.length * 16)
  return sorted.map((node, idx) => {
    const angle = (idx / Math.max(1, sorted.length)) * Math.PI * 2
    return {
      ...node,
      x: Math.cos(angle) * radius + (Math.random() - 0.5) * 90,
      y: Math.sin(angle) * radius + (Math.random() - 0.5) * 90,
      vx: 0,
      vy: 0,
      pinned: false,
    }
  })
}

function bucket(category: string) {
  return (CATEGORY_ORDER as readonly string[]).includes(category) ? category : "other"
}

function rank(category: string) {
  const idx = (CATEGORY_ORDER as readonly string[]).indexOf(category)
  return idx === -1 ? CATEGORY_ORDER.length : idx
}

export function MemoryGraph(props: {
  open: boolean
  onClose: () => void
  server: ServerConnection.HttpBase
}) {
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [data, setStoreData] = createStore<{ root: string; edges: GraphEdge[]; sim: SimNode[] }>({
    root: "",
    edges: [],
    sim: [],
  })
  const [view, setView] = createStore({ tx: 0, ty: 0, scale: 1 })
  const [selected, setSelected] = createSignal<string | null>(null)
  const [preview, setPreview] = createSignal<{ path: string; content: string } | null>(null)
  const [hover, setHover] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal("")
  const [mode, setMode] = createSignal<"reader" | "graph">("graph")

  let svg: SVGSVGElement | undefined
  let raf: number | undefined
  let running = false

  const nodeIndex = createMemo(() => {
    const map = new Map<string, number>()
    for (let i = 0; i < data.sim.length; i++) map.set(data.sim[i].id, i)
    return map
  })

  const categoryCounts = createMemo(() => {
    const map = new Map<string, number>()
    for (const node of data.sim) map.set(bucket(node.category), (map.get(bucket(node.category)) ?? 0) + 1)
    return map
  })

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return data.sim
    return data.sim.filter(
      (node) => node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q),
    )
  })

  const groups = createMemo(() => {
    const map = new Map<string, SimNode[]>()
    for (const node of filtered()) {
      const cat = bucket(node.category)
      const list = map.get(cat) ?? []
      list.push(node)
      map.set(cat, list)
    }
    const out: { category: string; items: SimNode[] }[] = []
    for (const [cat, items] of map) {
      items.sort((a, b) => a.label.localeCompare(b.label))
      out.push({ category: cat, items })
    }
    out.sort((a, b) => rank(a.category) - rank(b.category))
    return out
  })

  const focused = createMemo(() => hover() ?? selected())
  const connected = createMemo(() => {
    const id = focused()
    if (!id) return null
    const set = new Set<string>([id])
    for (const edge of data.edges) {
      if (edge.source === id) set.add(edge.target)
      else if (edge.target === id) set.add(edge.source)
    }
    return set
  })

  async function fetchInto(path: string) {
    setSelected(path)
    try {
      const content = await fetchPage(props.server, path)
      setPreview({ path, content })
    } catch (err) {
      setPreview({ path, content: `Failed to load: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  function openPage(path: string) {
    setMode("reader")
    void fetchInto(path)
  }

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const next = await fetchGraph(props.server)
      setStoreData({
        root: next.root,
        edges: next.edges,
        sim: seed(next.nodes),
      })
      setView({ tx: 0, ty: 0, scale: 1 })
      setSelected(null)
      setPreview(null)
      kick()
      fit()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function step() {
    const nodes = data.sim
    if (nodes.length === 0) return 0

    const KR = 4800
    const KS = 0.045
    const REST = 150
    const CENTER = 0.0009
    const DAMP = 0.84
    const DT = 1

    const fx = new Float64Array(nodes.length)
    const fy = new Float64Array(nodes.length)

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distSq = dx * dx + dy * dy
        if (distSq < 1) {
          dx = Math.random() - 0.5
          dy = Math.random() - 0.5
          distSq = dx * dx + dy * dy + 1
        }
        const dist = Math.sqrt(distSq)
        const force = KR / distSq
        const nx = (dx / dist) * force
        const ny = (dy / dist) * force
        fx[i] += nx
        fy[i] += ny
        fx[j] -= nx
        fy[j] -= ny
      }
    }

    const idx = nodeIndex()
    for (const edge of data.edges) {
      const i = idx.get(edge.source)
      const j = idx.get(edge.target)
      if (i === undefined || j === undefined) continue
      const a = nodes[i]
      const b = nodes[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const force = (dist - REST) * KS
      const nx = (dx / dist) * force
      const ny = (dy / dist) * force
      fx[i] += nx
      fy[i] += ny
      fx[j] -= nx
      fy[j] -= ny
    }

    let maxV = 0
    setStoreData(
      "sim",
      produce((list: SimNode[]) => {
        for (let i = 0; i < list.length; i++) {
          const node = list[i]
          if (node.pinned) {
            node.vx = 0
            node.vy = 0
            continue
          }
          node.vx = (node.vx + (fx[i] - node.x * CENTER)) * DAMP
          node.vy = (node.vy + (fy[i] - node.y * CENTER)) * DAMP
          node.x += node.vx * DT
          node.y += node.vy * DT
          const speed = Math.abs(node.vx) + Math.abs(node.vy)
          if (speed > maxV) maxV = speed
        }
      }),
    )
    return maxV
  }

  function loop() {
    if (!running) return
    const v = step()
    if (v < 0.4) {
      running = false
      raf = undefined
      fit()
      return
    }
    raf = requestAnimationFrame(loop)
  }

  function kick() {
    if (running) return
    running = true
    raf = requestAnimationFrame(loop)
  }

  function fit() {
    const nodes = data.sim
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
    const pad = 90
    const sx = (500 - pad) / halfW
    const sy = (400 - pad) / halfH
    const scale = Math.min(2, Math.max(0.25, Math.min(sx, sy)))
    setView({ scale, tx: -cx * scale, ty: -cy * scale })
  }

  onCleanup(() => {
    running = false
    if (raf !== undefined) cancelAnimationFrame(raf)
  })

  let wasOpen = false
  createEffect(() => {
    const next = props.open
    if (next && !wasOpen) {
      setMode("graph")
      void load()
    }
    wasOpen = next
  })

  let panning = false
  let panStart = { x: 0, y: 0, tx: 0, ty: 0 }
  let dragging: number | null = null
  let dragOffset = { x: 0, y: 0 }

  function screenToWorld(x: number, y: number) {
    if (!svg) return { x, y }
    const box = svg.getBoundingClientRect()
    return {
      x: (x - box.left - box.width / 2 - view.tx) / view.scale,
      y: (y - box.top - box.height / 2 - view.ty) / view.scale,
    }
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault()
    const factor = event.deltaY > 0 ? 0.9 : 1.1
    const next = Math.min(3, Math.max(0.25, view.scale * factor))
    if (!svg) return
    const box = svg.getBoundingClientRect()
    const cx = event.clientX - box.left - box.width / 2
    const cy = event.clientY - box.top - box.height / 2
    const wx = (cx - view.tx) / view.scale
    const wy = (cy - view.ty) / view.scale
    setView({ scale: next, tx: cx - wx * next, ty: cy - wy * next })
  }

  function onCanvasPointerDown(event: PointerEvent) {
    if ((event.target as Element).closest("[data-node]")) return
    panning = true
    panStart = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty }
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  }

  function onCanvasPointerMove(event: PointerEvent) {
    if (dragging !== null) {
      const world = screenToWorld(event.clientX, event.clientY)
      setStoreData("sim", dragging, {
        x: world.x - dragOffset.x,
        y: world.y - dragOffset.y,
        vx: 0,
        vy: 0,
      })
      kick()
      return
    }
    if (!panning) return
    setView({
      tx: panStart.tx + (event.clientX - panStart.x),
      ty: panStart.ty + (event.clientY - panStart.y),
    })
  }

  function onCanvasPointerUp(event: PointerEvent) {
    panning = false
    if (dragging !== null) {
      setStoreData("sim", dragging, "pinned", false)
      dragging = null
    }
    try {
      ;(event.currentTarget as Element).releasePointerCapture(event.pointerId)
    } catch {
      /* noop */
    }
  }

  function onNodePointerDown(event: PointerEvent, index: number) {
    event.stopPropagation()
    const world = screenToWorld(event.clientX, event.clientY)
    const node = data.sim[index]
    dragOffset = { x: world.x - node.x, y: world.y - node.y }
    dragging = index
    setStoreData("sim", index, "pinned", true)
  }

  function onNodeClick(event: MouseEvent, id: string) {
    event.stopPropagation()
    void openPage(id)
  }

  const viewBox = () => "-500 -400 1000 800"

  return (
    <Show when={props.open}>
      <div class="macaw-wiki-overlay" role="dialog" aria-label="MACAW wiki">
        <div class="macaw-wiki-header">
          <span class="macaw-wiki-title">MACAW Wiki</span>
          <span class="macaw-wiki-count">
            {data.sim.length} pages, {data.edges.length} links
          </span>
          <input
            type="search"
            class="macaw-wiki-search"
            placeholder="Search pages..."
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div class="macaw-wiki-modes" role="tablist">
            <button
              type="button"
              class="macaw-wiki-mode"
              classList={{ active: mode() === "reader" }}
              onClick={() => setMode("reader")}
              role="tab"
              aria-selected={mode() === "reader"}
            >
              Reader
            </button>
            <button
              type="button"
              class="macaw-wiki-mode"
              classList={{ active: mode() === "graph" }}
              onClick={() => {
                setSelected(null)
                setHover(null)
                setMode("graph")
                requestAnimationFrame(fit)
              }}
              role="tab"
              aria-selected={mode() === "graph"}
            >
              Graph
            </button>
          </div>
          <Show when={mode() === "graph"}>
            <button type="button" class="macaw-wiki-refresh" onClick={fit} title="Fit graph to view">
              Fit
            </button>
          </Show>
          <button type="button" class="macaw-wiki-refresh" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" class="macaw-wiki-close" onClick={() => props.onClose()} aria-label="Close">
            ×
          </button>
        </div>
        <div class="macaw-wiki-body">
          <aside class="macaw-wiki-side">
            <Show
              when={data.sim.length > 0}
              fallback={
                <Show when={!loading()}>
                  <div class="macaw-wiki-side-empty">No pages yet</div>
                </Show>
              }
            >
              <Show
                when={groups().length > 0}
                fallback={<div class="macaw-wiki-side-empty">No matches</div>}
              >
                <For each={groups()}>
                  {(group) => (
                    <div class="macaw-wiki-group">
                      <div class="macaw-wiki-group-head">
                        <span>{group.category}</span>
                        <span class="macaw-wiki-group-count">{group.items.length}</span>
                      </div>
                      <For each={group.items}>
                        {(node) => (
                          <button
                            type="button"
                            class="macaw-wiki-item"
                            classList={{ active: selected() === node.id }}
                            data-category={bucket(node.category)}
                            onClick={() => void openPage(node.id)}
                            title={node.id}
                          >
                            <span class="macaw-wiki-item-dot" />
                            <span class="macaw-wiki-item-label">{node.label}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </aside>
          <main class="macaw-wiki-main">
            <Show when={loading() && data.sim.length === 0}>
              <div class="macaw-wiki-state">Loading memory wiki...</div>
            </Show>
            <Show when={error()}>
              <div class="macaw-wiki-state error">{error()}</div>
            </Show>
            <Show when={!loading() && !error() && data.sim.length === 0}>
              <div class="macaw-wiki-state">No memory pages yet. Talk to MACAW and it will start filling in.</div>
            </Show>
            <Show when={mode() === "reader" && data.sim.length > 0}>
              <Show
                when={preview()}
                fallback={<div class="macaw-wiki-state">Pick a page from the left to read.</div>}
              >
                {(value) => (
                  <article class="macaw-wiki-reader">
                    <div class="macaw-wiki-crumb">{value().path}</div>
                    <Markdown text={value().content || "(empty)"} class="macaw-markdown" />
                  </article>
                )}
              </Show>
            </Show>
            <Show when={mode() === "graph" && data.sim.length > 0}>
              <div class="macaw-wiki-graph">
                <svg
                  ref={(el) => {
                    svg = el
                  }}
                  class="macaw-graph-svg"
                  viewBox={viewBox()}
                  preserveAspectRatio="xMidYMid meet"
                  onWheel={onWheel}
                  onPointerDown={onCanvasPointerDown}
                  onPointerMove={onCanvasPointerMove}
                  onPointerUp={onCanvasPointerUp}
                  onPointerCancel={onCanvasPointerUp}
                >
                  <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
                    <g class="macaw-graph-edges">
                      <For each={data.edges}>
                        {(edge) => {
                          const idx = nodeIndex()
                          const i = idx.get(edge.source)
                          const j = idx.get(edge.target)
                          if (i === undefined || j === undefined) return null
                          const active = () => {
                            const id = focused()
                            return id !== null && (edge.source === id || edge.target === id)
                          }
                          const dim = () => {
                            const id = focused()
                            return id !== null && edge.source !== id && edge.target !== id
                          }
                          return (
                            <line
                              class="macaw-graph-edge"
                              classList={{ active: active(), dim: dim() }}
                              x1={data.sim[i].x}
                              y1={data.sim[i].y}
                              x2={data.sim[j].x}
                              y2={data.sim[j].y}
                            />
                          )
                        }}
                      </For>
                    </g>
                    <g class="macaw-graph-nodes">
                      <For each={data.sim}>
                        {(node, index) => {
                          const r = () => Math.max(7, Math.min(22, 7 + (node.indegree + node.outdegree) * 1.6))
                          const isSelected = () => selected() === node.id
                          const isHover = () => hover() === node.id
                          const dim = () => {
                            const set = connected()
                            return set !== null && !set.has(node.id)
                          }
                          const linked = () => {
                            const set = connected()
                            return set !== null && set.has(node.id) && !isSelected() && !isHover()
                          }
                          return (
                            <g
                              data-node={node.id}
                              data-category={bucket(node.category)}
                              class="macaw-graph-node"
                              classList={{ selected: isSelected(), hover: isHover(), dim: dim(), linked: linked() }}
                              transform={`translate(${node.x} ${node.y})`}
                              onPointerDown={(event) => onNodePointerDown(event, index())}
                              onPointerEnter={() => setHover(node.id)}
                              onPointerLeave={() => setHover((curr) => (curr === node.id ? null : curr))}
                              onClick={(event) => onNodeClick(event, node.id)}
                            >
                              <circle class="macaw-graph-node-hit" r={Math.max(r() + 6, 14)} />
                              <circle class="macaw-graph-node-fill" r={r()} />
                              <text class="macaw-graph-node-label" y={r() + 12}>
                                {node.label}
                              </text>
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
              </div>
            </Show>
          </main>
        </div>
      </div>
    </Show>
  )
}
