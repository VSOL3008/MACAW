import fs from "fs/promises"
import path from "path"
import { Memory } from "./memory"

const LINK_MD = /\[[^\]]+\]\(([^)]+)\)/g
const LINK_WIKI = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/g
const HEADING = /^\s*#\s+(.+?)\s*$/m
const EXTERNAL = /^(?:[a-z][a-z0-9+\-.]*:|#|mailto:|tel:)/i
const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/
const FM_NAME = /^\s*name\s*:\s*(.+?)\s*$/im

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

const CORE_PAGES = new Set(["index.md", "user.md", "log.md", "SCHEMA.md"])

function categoryOf(rel: string): string {
  if (CORE_PAGES.has(rel)) return "core"
  const first = rel.split("/")[0]
  if (!first || first === rel) return "other"
  return first
}

function normalize(rel: string): string {
  return rel.split(path.sep).join("/").replace(/^\.\//, "")
}

function resolveTarget(fromRel: string, target: string): string | undefined {
  const clean = target.trim()
  if (!clean || EXTERNAL.test(clean)) return undefined
  const withExt = clean.endsWith(".md") ? clean : clean + ".md"
  const dir = path.posix.dirname(normalize(fromRel))
  const joined = dir === "." ? withExt : path.posix.join(dir, withExt)
  return path.posix.normalize(joined).replace(/^\.\//, "")
}

function firstHeading(body: string): string | undefined {
  const match = HEADING.exec(body)
  return match?.[1]?.trim()
}

function skillName(body: string): string | undefined {
  const fm = FRONTMATTER.exec(body)
  if (!fm) return undefined
  const name = FM_NAME.exec(fm[1])?.[1]?.trim()
  if (!name) return undefined
  return name.replace(/^["']|["']$/g, "")
}

export async function graph(): Promise<{
  nodes: GraphNode[]
  edges: GraphEdge[]
  root: string
}> {
  const root = Memory.root()
  await Memory.ensure()
  const pages = await Memory.list()
  const ids = new Set(pages.map((p) => normalize(p.path)))

  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()

  for (const page of pages) {
    const id = normalize(page.path)
    const base = path.basename(id, ".md")
    const label = base === "SKILL" ? path.posix.basename(path.posix.dirname(id)) : base
    nodes.set(id, {
      id,
      label,
      category: categoryOf(id),
      size: page.size,
      indegree: 0,
      outdegree: 0,
    })
  }

  for (const page of pages) {
    const id = normalize(page.path)
    const full = path.join(root, page.path)
    const body = await fs.readFile(full, "utf8").catch(() => "")
    if (!body) continue

    const isSkill = path.basename(id) === "SKILL.md"
    const label = isSkill ? skillName(body) : firstHeading(body)
    if (label) nodes.get(id)!.label = label

    const targets = new Set<string>()
    let match: RegExpExecArray | null
    LINK_MD.lastIndex = 0
    while ((match = LINK_MD.exec(body))) {
      const resolved = resolveTarget(id, match[1])
      if (resolved) targets.add(resolved)
    }
    LINK_WIKI.lastIndex = 0
    while ((match = LINK_WIKI.exec(body))) {
      const resolved = resolveTarget(id, match[1])
      if (resolved) targets.add(resolved)
    }

    for (const target of targets) {
      if (target === id || !ids.has(target)) continue
      const key = `${id}\u0000${target}`
      if (edges.has(key)) continue
      edges.set(key, { source: id, target })
      nodes.get(id)!.outdegree += 1
      nodes.get(target)!.indegree += 1
    }
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()],
    root,
  }
}

export async function page(rel: string): Promise<{ path: string; content: string } | undefined> {
  const content = await Memory.read(rel).catch(() => undefined)
  if (content === undefined) return undefined
  return { path: normalize(rel), content }
}
