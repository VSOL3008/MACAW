import fs from "fs/promises"
import path from "path"
import { Memory } from "./memory"

const LINK_MD = /\[[^\]]+\]\(([^)]+)\)/g
const LINK_WIKI = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/g
const HEADING = /^\s*#\s+(.+?)\s*$/m
const EXTERNAL = /^(?:[a-z][a-z0-9+\-.]*:|#|mailto:|tel:)/i
const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/
const FM_NAME = /^\s*name\s*:\s*(.+?)\s*$/im
const VERSION = 1
const CACHE = ".macaw-index"
const STORE = "graph-v1.json"
const MAX = 1200
const MAX_EDGE = 6000
const MAX_PAGE = 250
const MAX_TEXT = 8192
const FRESH = 30_000
const STAT_CHUNK = 256
const READ_CHUNK = 48
const CORE = ["index.md", "user.md", "log.md", "SCHEMA.md"] as const
const HUB = new Set<string>(CORE)
const ORDER = ["core", "entities", "projects", "preferences", "facts", "skills", "other"] as const

export type GraphNode = {
  id: string
  label: string
  category: string
  size: number
  indegree: number
  outdegree: number
}

export type GraphEdge = {
  source: string
  target: string
}

export type GraphStats = {
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

export type GraphData = {
  root: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
}

export type PageItem = GraphNode & {
  modified: number
}

export type MemoryStatus = {
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

export type PagesData = {
  root: string
  items: PageItem[]
  next_cursor?: string
  stats: MemoryStatus & {
    total_matches: number
  }
}

type Entry = {
  id: string
  size: number
  modified: number
}

type Page = {
  id: string
  label: string
  category: string
  size: number
  modified: number
  links: string[]
  search: string
  score: number
}

type Store = {
  version: number
  root: string
  built_at: number
  pages: Page[]
}

type Index = {
  root: string
  page: Map<string, Page>
  nodes: GraphNode[]
  link: Map<string, string[]>
  edges: number
  built: number
}

type State = {
  root: string
  page: Map<string, Page>
  graph: Index | undefined
  loaded: boolean
  cache: boolean
  built: number
  indexing: boolean
  indexed: number
  total: number
  error: string | undefined
}

let state = fresh()
let job: Promise<void> | undefined

function fresh(): State {
  return {
    root: "",
    page: new Map(),
    graph: undefined,
    loaded: false,
    cache: false,
    built: 0,
    indexing: false,
    indexed: 0,
    total: 0,
    error: undefined,
  }
}

export function reset() {
  state = fresh()
  job = undefined
}

function bucket(category: string) {
  return (ORDER as readonly string[]).includes(category) ? category : "other"
}

function rank(category: string) {
  const idx = (ORDER as readonly string[]).indexOf(bucket(category))
  return idx === -1 ? ORDER.length : idx
}

function score(node: GraphNode) {
  return node.indegree * 2 + node.outdegree + Math.log2(node.size + 8)
}

function category(rel: string): string {
  if (HUB.has(rel)) return "core"
  const first = rel.split("/")[0]
  if (!first || first === rel) return "other"
  return first
}

function norm(rel: string): string {
  return rel.split(path.sep).join("/").replace(/^\.\//, "")
}

function full(root: string, rel: string): string {
  return path.join(root, rel)
}

function file(root: string): string {
  return path.join(root, CACHE, STORE)
}

function target(from: string, raw: string): string | undefined {
  const clean = raw.trim()
  if (!clean || EXTERNAL.test(clean)) return
  const next = clean.endsWith(".md") ? clean : clean + ".md"
  const dir = path.posix.dirname(norm(from))
  const joined = dir === "." ? next : path.posix.join(dir, next)
  return path.posix.normalize(joined).replace(/^\.\//, "")
}

function heading(body: string): string | undefined {
  return HEADING.exec(body)?.[1]?.trim()
}

function skill(body: string): string | undefined {
  const fm = FRONTMATTER.exec(body)
  if (!fm) return
  const name = FM_NAME.exec(fm[1])?.[1]?.trim()
  if (!name) return
  return name.replace(/^["']|["']$/g, "")
}

function valid(page: Page): boolean {
  return (
    typeof page.id === "string" &&
    typeof page.label === "string" &&
    typeof page.category === "string" &&
    typeof page.size === "number" &&
    typeof page.modified === "number" &&
    Array.isArray(page.links) &&
    typeof page.search === "string"
  )
}

function key(node: GraphNode, q: string, page?: Page) {
  const id = node.id.toLowerCase()
  const label = node.label.toLowerCase()
  if (id === q || label === q) return 10_000 + score(node)
  if (id.startsWith(q) || label.startsWith(q)) return 7_500 + score(node)
  if (id.includes(q) || label.includes(q)) return 5_000 + score(node)
  if (page?.search.includes(q)) return 2_500 + score(node)
  return -1
}

function sort(nodes: GraphNode[]) {
  return nodes.sort((a, b) => {
    const cat = rank(a.category) - rank(b.category)
    if (cat !== 0) return cat
    const diff = score(b) - score(a)
    if (diff !== 0) return diff
    return a.id.localeCompare(b.id)
  })
}

function include(seen: Set<string>, out: GraphNode[], node: GraphNode | undefined, limit: number) {
  if (!node) return
  if (seen.has(node.id)) return
  if (out.length >= limit) return
  seen.add(node.id)
  out.push(node)
}

function compile(root: string, page: Map<string, Page>, built: number): Index {
  const ids = new Set(page.keys())
  const nodes = new Map<string, GraphNode>()
  const link = new Map<string, Set<string>>()
  let edges = 0

  for (const item of page.values()) {
    nodes.set(item.id, {
      id: item.id,
      label: item.label,
      category: item.category,
      size: item.size,
      indegree: 0,
      outdegree: 0,
    })
    link.set(item.id, new Set())
  }

  for (const item of page.values()) {
    const seen = new Set<string>()
    for (const id of item.links) {
      if (!ids.has(id) || id === item.id || seen.has(id)) continue
      seen.add(id)
      edges++
      nodes.get(item.id)!.outdegree++
      nodes.get(id)!.indegree++
      link.get(item.id)!.add(id)
      link.get(id)!.add(item.id)
    }
  }

  for (const node of nodes.values()) {
    const item = page.get(node.id)
    if (item) item.score = score(node)
  }

  return {
    root,
    page,
    nodes: sort([...nodes.values()]),
    link: new Map([...link.entries()].map(([id, set]) => [id, [...set].sort()] as const)),
    edges,
    built,
  }
}

function pick(index: Index, q: string, limit: number) {
  const size = Math.max(1, Math.min(limit || MAX, 4000))
  if (!q && index.nodes.length <= size) {
    return {
      nodes: sort(index.nodes.slice()),
      query_nodes: index.nodes.length,
    }
  }

  const byId = new Map(index.nodes.map((node) => [node.id, node] as const))
  const seen = new Set<string>()
  const out: GraphNode[] = []

  if (q) {
    const hits = index.nodes
      .map((node) => ({ node, key: key(node, q, index.page.get(node.id)) }))
      .filter((item) => item.key >= 0)
      .sort((a, b) => b.key - a.key || a.node.id.localeCompare(b.node.id))

    const head = Math.min(size, Math.max(24, Math.ceil(size / 3)))
    for (const item of hits.slice(0, head)) include(seen, out, item.node, size)
    for (const item of hits) {
      if (out.length >= size) break
      for (const id of index.link.get(item.node.id) ?? []) {
        include(seen, out, byId.get(id), size)
      }
    }
    for (const item of hits) include(seen, out, item.node, size)
    for (const node of sort(index.nodes.slice())) include(seen, out, node, size)
    return {
      nodes: sort(out),
      query_nodes: hits.length,
    }
  }

  const groups = new Map<string, GraphNode[]>()
  for (const node of sort(index.nodes.slice())) {
    const cat = bucket(node.category)
    const list = groups.get(cat) ?? []
    list.push(node)
    groups.set(cat, list)
  }
  for (const id of CORE) include(seen, out, byId.get(id), size)
  let added = true
  while (added && out.length < size) {
    added = false
    for (const cat of ORDER) {
      const list = groups.get(cat)
      if (!list?.length) continue
      const node = list.shift()
      if (!node) continue
      include(seen, out, node, size)
      added = true
      if (out.length >= size) break
    }
  }
  return {
    nodes: sort(out),
    query_nodes: index.nodes.length,
  }
}

function edge(index: Index, ids: Set<string>): GraphEdge[] {
  const out: GraphEdge[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const page = index.page.get(id)
    if (!page) continue
    for (const target of page.links) {
      if (!ids.has(target) || id === target) continue
      const key = `${id}\u0000${target}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ source: id, target })
      if (out.length >= MAX_EDGE) return out
    }
  }
  return out
}

async function parse(item: Entry, root: string): Promise<Page> {
  const body = await Bun.file(full(root, item.id))
    .text()
    .catch(() => "")
  const is = path.basename(item.id) === "SKILL.md"
  const base = path.basename(item.id, ".md")
  const raw = is ? skill(body) : heading(body)
  const label = raw || (base === "SKILL" ? path.posix.basename(path.posix.dirname(item.id)) : base)
  const links = new Set<string>()
  let match: RegExpExecArray | null
  LINK_MD.lastIndex = 0
  while ((match = LINK_MD.exec(body))) {
    const next = target(item.id, match[1])
    if (next) links.add(next)
  }
  LINK_WIKI.lastIndex = 0
  while ((match = LINK_WIKI.exec(body))) {
    const next = target(item.id, match[1])
    if (next) links.add(next)
  }
  return {
    id: item.id,
    label,
    category: category(item.id),
    size: item.size,
    modified: item.modified,
    links: [...links],
    search: `${label}\n${item.id}\n${body.slice(0, MAX_TEXT)}`.toLowerCase(),
    score: 0,
  }
}

async function seed(root: string): Promise<Map<string, Page>> {
  const pairs = await Promise.all(
    CORE.map(async (id) => {
      const stat = await fs.stat(full(root, id)).catch(() => undefined)
      if (!stat) return
      return parse({ id, size: stat.size, modified: stat.mtimeMs }, root)
    }),
  )
  return new Map(pairs.filter((item): item is Page => !!item).map((item) => [item.id, item] as const))
}

async function read(root: string): Promise<Store | undefined> {
  const target = file(root)
  if (!(await Bun.file(target).exists())) return
  const raw = await Bun.file(target)
    .json()
    .catch(() => undefined)
  if (!raw || typeof raw !== "object") return
  const store = raw as Store
  if (store.version !== VERSION || store.root !== root || !Array.isArray(store.pages)) return
  return {
    version: VERSION,
    root,
    built_at: typeof store.built_at === "number" ? store.built_at : 0,
    pages: store.pages.filter(valid),
  }
}

async function save(root: string, page: Map<string, Page>, built: number): Promise<void> {
  const target = file(root)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(
    tmp,
    JSON.stringify({
      version: VERSION,
      root,
      built_at: built,
      pages: [...page.values()].sort((a, b) => a.id.localeCompare(b.id)),
    } satisfies Store),
  )
  await fs.rename(tmp, target)
}

async function walk(root: string): Promise<Entry[]> {
  const out: Entry[] = []
  const dirs = [root]
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (!dir) continue
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const files: string[] = []
    for (const item of entries) {
      const next = path.join(dir, item.name)
      if (item.isDirectory()) {
        if (item.name !== CACHE) dirs.push(next)
        continue
      }
      if (item.isFile() && item.name.toLowerCase().endsWith(".md")) files.push(next)
    }
    for (let i = 0; i < files.length; i += STAT_CHUNK) {
      const part = await Promise.all(
        files.slice(i, i + STAT_CHUNK).map(async (name) => {
          const stat = await fs.stat(name).catch(() => undefined)
          if (!stat) return
          return {
            id: norm(path.relative(root, name)),
            size: stat.size,
            modified: stat.mtimeMs,
          } satisfies Entry
        }),
      )
      for (const item of part) if (item) out.push(item)
      state.total = out.length
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

async function load(): Promise<void> {
  const root = Memory.root()
  await Memory.ensure()
  if (state.loaded && state.root === root) return
  state = fresh()
  state.root = root
  const store = await read(root)
  if (store) {
    state.page = new Map(store.pages.map((item) => [item.id, item] as const))
    state.graph = compile(root, state.page, store.built_at)
    state.loaded = true
    state.cache = true
    state.built = store.built_at
    state.indexed = state.page.size
    state.total = state.page.size
    return
  }
  state.page = await seed(root)
  state.graph = compile(root, state.page, 0)
  state.loaded = true
  state.cache = false
  state.indexed = state.page.size
  state.total = state.page.size
}

async function scan(): Promise<void> {
  const root = Memory.root()
  await load()
  state.indexing = true
  state.error = undefined
  state.indexed = 0
  state.total = state.page.size

  const list = await walk(root)
  const keep = new Set(list.map((item) => item.id))
  const next = new Map<string, Page>()
  const work: Entry[] = []

  for (const item of list) {
    const prev = state.page.get(item.id)
    if (prev && prev.size === item.size && prev.modified === item.modified) {
      next.set(prev.id, prev)
      continue
    }
    work.push(item)
  }

  for (let i = 0; i < work.length; i += READ_CHUNK) {
    const part = await Promise.all(work.slice(i, i + READ_CHUNK).map((item) => parse(item, root)))
    for (const item of part) next.set(item.id, item)
    state.indexed = Math.min(keep.size, next.size)
  }

  for (const id of [...next.keys()]) {
    if (!keep.has(id)) next.delete(id)
  }

  const built = Date.now()
  const graph = compile(root, next, built)
  state.page = next
  state.graph = graph
  state.cache = true
  state.built = built
  state.indexed = next.size
  state.total = next.size
  await save(root, next, built)
}

function kick(force = false): Promise<void> | undefined {
  if (job) return job
  if (!force && state.cache && Date.now() - state.built < FRESH) return
  state.indexing = true
  state.error = undefined
  job = scan()
    .catch((err) => {
      state.error = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      state.indexing = false
      job = undefined
    })
  return job
}

function current(): Index {
  if (!state.graph) {
    state.graph = compile(state.root || Memory.root(), state.page, state.built)
  }
  return state.graph
}

function info(): MemoryStatus {
  const graph = state.graph
  const built = state.built ? Math.max(0, Date.now() - state.built) : 0
  return {
    root: state.root || Memory.root(),
    indexing: state.indexing,
    indexed: state.indexed || state.page.size,
    total: state.total || state.page.size,
    pages: graph?.nodes.length ?? state.page.size,
    links: graph?.edges ?? 0,
    cache: state.cache,
    cache_age: built,
    last_error: state.error,
  }
}

function stats(index: Index, picked: GraphNode[], edges: GraphEdge[], matches: number): GraphStats {
  const status = info()
  return {
    total_nodes: status.pages,
    total_edges: status.links,
    visible_nodes: picked.length,
    visible_edges: edges.length,
    query_nodes: matches,
    sampled: picked.length < status.pages || edges.length < status.links,
    indexing: status.indexing,
    indexed_nodes: status.indexed,
    index_total: status.total,
    cache_age: status.cache_age,
    last_error: status.last_error,
  }
}

export async function sync(): Promise<MemoryStatus> {
  await load()
  await kick(true)
  return info()
}

export async function status(): Promise<MemoryStatus> {
  await load()
  void kick()
  return info()
}

export async function pages(input?: { query?: string; limit?: number; cursor?: string }): Promise<PagesData> {
  await load()
  void kick()
  const index = current()
  const q = input?.query?.trim().toLowerCase() ?? ""
  const size = Math.max(20, Math.min(input?.limit ?? 120, MAX_PAGE))
  const pos = Math.max(0, Number.parseInt(input?.cursor ?? "0", 10) || 0)
  const nodes = q
    ? index.nodes
        .map((node) => ({ node, key: key(node, q, index.page.get(node.id)) }))
        .filter((item) => item.key >= 0)
        .sort((a, b) => b.key - a.key || a.node.id.localeCompare(b.node.id))
        .map((item) => item.node)
    : index.nodes
  const part = nodes.slice(pos, pos + size)
  const next = pos + size < nodes.length ? String(pos + size) : undefined
  return {
    root: index.root,
    items: part.map((node) => ({
      ...node,
      modified: index.page.get(node.id)?.modified ?? 0,
    })),
    next_cursor: next,
    stats: {
      ...info(),
      total_matches: nodes.length,
    },
  }
}

export async function graph(input?: { query?: string; limit?: number }): Promise<GraphData> {
  await load()
  void kick()
  const index = current()
  const q = input?.query?.trim().toLowerCase() ?? ""
  const picked = pick(index, q, input?.limit ?? MAX)
  const ids = new Set(picked.nodes.map((node) => node.id))
  const edges = edge(index, ids)

  return {
    root: index.root,
    nodes: picked.nodes,
    edges,
    stats: stats(index, picked.nodes, edges, picked.query_nodes),
  }
}

export async function page(rel: string): Promise<{ path: string; content: string } | undefined> {
  const content = await Memory.read(rel).catch(() => undefined)
  if (content === undefined) return
  return { path: norm(rel), content }
}
