export type Node = {
  id: string
  label: string
  category: string
  size: number
  indegree: number
  outdegree: number
}

export type Edge = {
  source: string
  target: string
}

export type Plot = Node & {
  x: number
  y: number
  lx: number
  ly: number
  anchor: "start" | "middle" | "end"
  radius: number
  importance: number
  component: number
}

export type Link = {
  source: string
  target: string
  x1: number
  y1: number
  x2: number
  y2: number
  forward: number
  reverse: number
  count: number
}

export const CATEGORIES = ["core", "entities", "projects", "preferences", "facts", "skills", "other"] as const

const GOLDEN = Math.PI * (3 - Math.sqrt(5))
const TAU = Math.PI * 2

export function bucket(category: string) {
  return (CATEGORIES as readonly string[]).includes(category) ? category : "other"
}

export function rank(category: string) {
  const idx = (CATEGORIES as readonly string[]).indexOf(bucket(category))
  return idx === -1 ? CATEGORIES.length : idx
}

export function score(node: Node) {
  return node.indegree * 2 + node.outdegree + Math.log2(node.size + 8)
}

export function radius(node: Node) {
  return Math.max(5.5, Math.min(16, 5.5 + Math.log2(node.indegree + node.outdegree + 2) * 2.25))
}

function hash(value: string) {
  let out = 2166136261
  for (let i = 0; i < value.length; i++) {
    out ^= value.charCodeAt(i)
    out = Math.imul(out, 16777619)
  }
  return out >>> 0
}

function turn(value: string) {
  return (hash(value) / 4294967295) * TAU
}

type Point = Plot & {
  vx: number
  vy: number
  ax: number
  ay: number
  hub: boolean
}

function components(nodes: Node[], edges: Edge[]) {
  const map = new Map(nodes.map((node, idx) => [node.id, idx] as const))
  const adj = nodes.map(() => new Set<number>())
  for (const edge of edges) {
    const a = map.get(edge.source)
    const b = map.get(edge.target)
    if (a === undefined || b === undefined || a === b) continue
    adj[a].add(b)
    adj[b].add(a)
  }
  const seen = new Set<number>()
  const out: number[][] = []
  for (let i = 0; i < nodes.length; i++) {
    if (seen.has(i)) continue
    const part: number[] = []
    const queue = [i]
    seen.add(i)
    for (let at = 0; at < queue.length; at++) {
      const idx = queue[at]
      part.push(idx)
      for (const next of adj[idx]) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    out.push(part)
  }
  out.sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length
    const sa = Math.max(...a.map((idx) => score(nodes[idx])))
    const sb = Math.max(...b.map((idx) => score(nodes[idx])))
    return sb - sa || nodes[a[0]].id.localeCompare(nodes[b[0]].id)
  })
  return { adj, out }
}

function collide(points: Point[], force: number) {
  const size = 82
  const grid = new Map<string, number[]>()
  for (let i = 0; i < points.length; i++) {
    const node = points[i]
    const x = Math.floor(node.x / size)
    const y = Math.floor(node.y / size)
    const key = `${x}:${y}`
    const cell = grid.get(key) ?? []
    cell.push(i)
    grid.set(key, cell)
  }
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const gx = Math.floor(a.x / size)
    const gy = Math.floor(a.y / size)
    for (let x = gx - 1; x <= gx + 1; x++) {
      for (let y = gy - 1; y <= gy + 1; y++) {
        for (const idx of grid.get(`${x}:${y}`) ?? []) {
          if (idx <= i) continue
          const b = points[idx]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const raw = Math.hypot(dx, dy)
          const gap = a.radius + b.radius + 30
          if (raw >= gap) continue
          const angle = raw > 0.01 ? Math.atan2(dy, dx) : turn(`${a.id}:${b.id}`)
          const push = (gap - raw) * force
          const px = Math.cos(angle) * push
          const py = Math.sin(angle) * push
          a.vx -= px
          a.vy -= py
          b.vx += px
          b.vy += py
        }
      }
    }
  }
}

export function layout(input: Node[], edges: Edge[]) {
  if (input.length === 0) return []
  const nodes = input.slice().sort((a, b) => a.id.localeCompare(b.id))
  const graph = components(nodes, edges)
  const points: Point[] = []
  const refs = new Map<string, Point>()
  let total = 0

  graph.out.forEach((part, component) => {
    const sorted = part.slice().sort((a, b) => score(nodes[b]) - score(nodes[a]) || nodes[a].id.localeCompare(nodes[b].id))
    const root = sorted[0]
    const depth = new Map<number, number>([[root, 0]])
    const queue = [root]
    for (let at = 0; at < queue.length; at++) {
      const idx = queue[at]
      for (const next of graph.adj[idx]) {
        if (depth.has(next)) continue
        depth.set(next, (depth.get(idx) ?? 0) + 1)
        queue.push(next)
      }
    }
    const angle = component * GOLDEN - Math.PI / 2
    const orbit = component === 0 ? 0 : 270 + Math.sqrt(total + part.length) * 54
    const cx = Math.cos(angle) * orbit
    const cy = Math.sin(angle) * orbit * 0.72
    total += part.length
    const levels = new Map<number, number[]>()
    for (const idx of sorted) {
      const level = depth.get(idx) ?? 1
      const list = levels.get(level) ?? []
      list.push(idx)
      levels.set(level, list)
    }
    for (const idx of sorted) {
      const node = nodes[idx]
      const level = depth.get(idx) ?? 1
      const levelNodes = levels.get(level) ?? [idx]
      const pos = levelNodes.indexOf(idx)
      const spread = Math.max(level * 124, (levelNodes.length * 56) / TAU + level * 56)
      const seed = turn(`${component}:${level}:${node.id}`) * 0.12
      const theta = level === 0 ? 0 : (pos / levelNodes.length) * TAU + angle * 0.25 + seed
      const cat = rank(node.category)
      const pull = level === 0 ? 0 : 30
      const ax = cx + Math.cos((cat / CATEGORIES.length) * TAU - Math.PI / 2) * pull
      const ay = cy + Math.sin((cat / CATEGORIES.length) * TAU - Math.PI / 2) * pull * 0.78
      const r = radius(node)
      const point: Point = {
        ...node,
        x: cx + Math.cos(theta) * spread,
        y: cy + Math.sin(theta) * spread * 0.82,
        lx: 0,
        ly: 0,
        anchor: "middle",
        radius: r,
        importance: score(node),
        component,
        vx: 0,
        vy: 0,
        ax,
        ay,
        hub: idx === root,
      }
      points.push(point)
      refs.set(node.id, point)
    }
  })

  const pairs = new Map<string, [Point, Point]>()
  for (const edge of edges) {
    const a = refs.get(edge.source)
    const b = refs.get(edge.target)
    if (!a || !b || a === b) continue
    const key = a.id < b.id ? `${a.id}\u0000${b.id}` : `${b.id}\u0000${a.id}`
    if (!pairs.has(key)) pairs.set(key, [a, b])
  }
  const rounds = points.length <= 80 ? 180 : points.length <= 300 ? 120 : 72
  for (let step = 0; step < rounds; step++) {
    const heat = 1 - step / rounds
    for (const [a, b] of pairs.values()) {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.max(1, Math.hypot(dx, dy))
      const ideal = a.radius + b.radius + 110 + (a.hub || b.hub ? 14 : 0)
      const pull = (len - ideal) * 0.011 * (0.45 + heat * 0.55)
      const px = (dx / len) * pull
      const py = (dy / len) * pull
      a.vx += px
      a.vy += py
      b.vx -= px
      b.vy -= py
    }
    for (const node of points) {
      const pull = node.hub ? 0.072 : 0.0012
      node.vx += (node.ax - node.x) * pull
      node.vy += (node.ay - node.y) * pull
    }
    collide(points, 0.16 + heat * 0.08)
    for (const node of points) {
      const speed = Math.max(1, Math.hypot(node.vx, node.vy) / 9)
      node.x += node.vx / speed
      node.y += node.vy / speed
      node.vx *= 0.68
      node.vy *= 0.68
    }
  }

  for (let step = 0; step < 12; step++) {
    collide(points, 0.32)
    for (const node of points) {
      node.x += node.vx
      node.y += node.vy
      node.vx = 0
      node.vy = 0
    }
  }

  return points.map(({ vx: _vx, vy: _vy, ax: _ax, ay: _ay, hub: _hub, ...node }) => {
    const side = Math.abs(node.x) > Math.abs(node.y) * 0.55
    const sign = node.x < 0 ? -1 : 1
    return {
      ...node,
      lx: side ? sign * (node.radius + 9) : 0,
      ly: side ? 4 : node.y < 0 ? -node.radius - 9 : node.radius + 15,
      anchor: side ? (sign < 0 ? "end" : "start") : "middle",
    } satisfies Plot
  })
}

export function links(nodes: Plot[], edges: Edge[]) {
  const refs = new Map(nodes.map((node) => [node.id, node] as const))
  const map = new Map<string, { source: string; target: string; forward: number; reverse: number }>()
  for (const edge of edges) {
    if (edge.source === edge.target || !refs.has(edge.source) || !refs.has(edge.target)) continue
    const source = edge.source < edge.target ? edge.source : edge.target
    const target = edge.source < edge.target ? edge.target : edge.source
    const key = `${source}\u0000${target}`
    const row = map.get(key) ?? { source, target, forward: 0, reverse: 0 }
    if (edge.source === source) row.forward++
    if (edge.source !== source) row.reverse++
    map.set(key, row)
  }
  return [...map.values()].map((row) => {
    const a = refs.get(row.source)!
    const b = refs.get(row.target)!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.max(1, Math.hypot(dx, dy))
    const ux = dx / len
    const uy = dy / len
    return {
      ...row,
      x1: a.x + ux * (a.radius + 3),
      y1: a.y + uy * (a.radius + 3),
      x2: b.x - ux * (b.radius + 3),
      y2: b.y - uy * (b.radius + 3),
      count: row.forward + row.reverse,
    } satisfies Link
  })
}

type LabelOptions = {
  scale: number
  selected?: string | null
  related?: Set<string> | null
}

export function labels(nodes: Plot[], opts: LabelOptions) {
  const sorted = nodes.slice().sort((a, b) => {
    if (a.id === opts.selected) return -1
    if (b.id === opts.selected) return 1
    const ar = opts.related?.has(a.id) ? 1 : 0
    const br = opts.related?.has(b.id) ? 1 : 0
    return br - ar || b.importance - a.importance || a.id.localeCompare(b.id)
  })
  const base = Math.max(8, Math.round(Math.sqrt(nodes.length) * 2.2))
  const limit = opts.scale < 0.72 ? base : opts.scale < 1.35 ? base * 2 : nodes.length
  const out = new Set<string>()
  const boxes: { x: number; y: number; w: number; h: number }[] = []
  for (const node of sorted) {
    if (out.size >= limit && node.id !== opts.selected) continue
    const text = node.label.length > 34 ? `${node.label.slice(0, 33).trimEnd()}\u2026` : node.label
    const w = Math.min(194, Math.max(42, text.length * 6.1))
    const x = node.x + node.lx - (node.anchor === "middle" ? w / 2 : node.anchor === "end" ? w : 0)
    const box = { x, y: node.y + node.ly - 12, w, h: 17 }
    const hit = boxes.some(
      (item) =>
        box.x < item.x + item.w + 8 &&
        box.x + box.w + 8 > item.x &&
        box.y < item.y + item.h + 6 &&
        box.y + box.h + 6 > item.y,
    )
    const cover = nodes.some((item) => {
      if (item.id === node.id) return false
      const r = item.radius + 5
      return box.x < item.x + r && box.x + box.w > item.x - r && box.y < item.y + r && box.y + box.h > item.y - r
    })
    if ((hit || cover) && node.id !== opts.selected) continue
    boxes.push(box)
    out.add(node.id)
  }
  return out
}
