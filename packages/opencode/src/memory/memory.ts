import fs from "fs/promises"
import os from "os"
import path from "path"

const SEED_INDEX = `# Index

Catalog of user memory pages. Maintained by the agent.

## Core
- [User profile](user.md) - root page about the user
- [Schema](SCHEMA.md) - how this wiki is structured
- [Log](log.md) - chronological ledger

## Topics
(none yet)
`

const SEED_LOG = `# Log
`

const SEED_USER = `# User

(No durable facts about the user have been recorded yet.)
`

const SEED_SCHEMA = `# Schema

Rules for maintaining this wiki. The agent follows these; humans can read and revise them.

## Layout

- \`index.md\` - catalog of every page. Updated on every write.
- \`log.md\` - chronological append-only ledger (\`## [ISO] kind | detail\`).
- \`user.md\` - root profile. High-signal, compact.
- \`entities/<slug>.md\` - named things (accounts, apps, people, orgs).
- \`projects/<slug>.md\` - ongoing projects or goals.
- \`preferences/<slug>.md\` - how the user likes things done.
- \`facts/<slug>.md\` - durable misc facts that do not fit elsewhere.
- \`skills/<slug>/SKILL.md\` - reusable workflows with YAML frontmatter (\`name\`, \`description\`).

## Page conventions

- H1 matches the entity or topic.
- Prefer bullet lists of short declarative facts over prose.
- Date each fact in parentheses (YYYY-MM-DD) when the source is conversational.
- Link related pages with Markdown links. A new page must contain at least one link to an existing page, so the memory graph stays connected.
- Never include secrets: passwords, tokens, keys. If in doubt, ask.

## Writes

- Update the existing page first. Only create a new page when the topic is genuinely new.
- Every new page must be registered in \`index.md\` under the matching \`## Heading\` (Core, Entities, Projects, Preferences, Facts, Skills, Topics). Create the heading if missing.
- Every write should improve the wiki. Small, incremental, factual.
- Do not announce memory edits in chat; execute and continue.
`

export namespace Memory {
  const MAX_FILE = 1024 * 512
  const MAX_QUERY_BYTES = 1024 * 1024
  const HUB = new Set(["index.md", "user.md", "log.md", "SCHEMA.md"])
  const LINK_MD = /\[[^\]]+\]\(([^)]+)\)/g
  const LINK_WIKI = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/g
  const TITLE_H1 = /^\s*#\s+(.+?)\s*$/m
  const FRONT = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/
  const FRONT_NAME = /^\s*name\s*:\s*(.+?)\s*$/im
  const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+\-.]*:|#|mailto:|tel:)/i

  let cachedRoot: string | null = null

  export function root(): string {
    if (cachedRoot) return cachedRoot
    const env = process.env.MACAW_MEMORY_DIR?.trim()
    cachedRoot = env && env.length > 0 ? path.resolve(env) : path.join(os.homedir(), ".macaw", "memory")
    return cachedRoot
  }

  function resolve(rel: string): string {
    if (!rel || typeof rel !== "string") throw new Error("memory path is required")
    if (path.isAbsolute(rel)) throw new Error("memory path must be relative to the wiki root")
    const base = root()
    const full = path.resolve(base, rel)
    const rootWithSep = base.endsWith(path.sep) ? base : base + path.sep
    if (full !== base && !full.startsWith(rootWithSep)) {
      throw new Error("memory path escapes the wiki root")
    }
    return full
  }

  async function exists(full: string): Promise<boolean> {
    const stat = await fs.stat(full).catch(() => undefined)
    return !!stat
  }

  let ensured = false
  export async function ensure(): Promise<void> {
    if (ensured) return
    const base = root()
    await fs.mkdir(base, { recursive: true })
    const seeds: Array<[string, string]> = [
      ["index.md", SEED_INDEX],
      ["log.md", SEED_LOG],
      ["user.md", SEED_USER],
      ["SCHEMA.md", SEED_SCHEMA],
    ]
    for (const [name, body] of seeds) {
      const full = path.join(base, name)
      if (!(await exists(full))) await fs.writeFile(full, body, "utf8")
    }
    ensured = true
  }

  export async function read(rel: string): Promise<string> {
    await ensure()
    return fs.readFile(resolve(rel), "utf8")
  }

  export async function write(rel: string, content: string): Promise<void> {
    await ensure()
    const full = resolve(rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf8")
  }

  export async function append(rel: string, content: string): Promise<void> {
    await ensure()
    const full = resolve(rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    const prior = (await fs.readFile(full, "utf8").catch(() => "")) || ""
    const sep = prior.length === 0 || prior.endsWith("\n") ? "" : "\n"
    await fs.writeFile(full, prior + sep + content + (content.endsWith("\n") ? "" : "\n"), "utf8")
  }

  export async function list(): Promise<Array<{ path: string; size: number; modified: number }>> {
    await ensure()
    const base = root()
    const out: Array<{ path: string; size: number; modified: number }> = []
    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.name.toLowerCase().endsWith(".md")) continue
        const stat = await fs.stat(full).catch(() => undefined)
        if (!stat) continue
        out.push({
          path: path.relative(base, full).split(path.sep).join("/"),
          size: stat.size,
          modified: stat.mtimeMs,
        })
      }
    }
    await walk(base)
    out.sort((a, b) => a.path.localeCompare(b.path))
    return out
  }

  export async function search(query: string, limit = 20): Promise<Array<{ path: string; line: number; text: string }>> {
    await ensure()
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const pages = await list()
    const hits: Array<{ path: string; line: number; text: string }> = []
    let budget = MAX_QUERY_BYTES
    for (const page of pages) {
      if (hits.length >= limit) break
      if (page.size > budget) continue
      budget -= page.size
      const full = path.join(root(), page.path)
      const body = await fs.readFile(full, "utf8").catch(() => "")
      if (!body) continue
      const lines = body.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= limit) break
        const line = lines[i]
        if (line.toLowerCase().includes(needle)) {
          hits.push({ path: page.path, line: i + 1, text: line.length > 200 ? line.slice(0, 200) + "..." : line })
        }
      }
    }
    return hits
  }

  function truncate(body: string, maxBytes = 4096): string {
    const buf = Buffer.from(body, "utf8")
    if (buf.byteLength <= maxBytes) return body
    return buf.subarray(0, maxBytes).toString("utf8") + "\n... [truncated]"
  }

  export async function context(): Promise<string> {
    await ensure()
    const base = root()
    const user = await fs.readFile(path.join(base, "user.md"), "utf8").catch(() => "")
    const index = await fs.readFile(path.join(base, "index.md"), "utf8").catch(() => "")
    return [
      "You have a persistent long-term memory about the user stored as a markdown wiki.",
      `Wiki root: ${base}`,
      "Use the memory_read, memory_write, memory_append, memory_list, and memory_search tools to maintain it.",
      "The blocks below are the current contents of user.md and index.md, refreshed every turn.",
      "",
      "<memory>",
      "  <user>",
      truncate(user, 4096),
      "  </user>",
      "  <index>",
      truncate(index, 4096),
      "  </index>",
      "</memory>",
    ].join("\n")
  }

  export async function logEntry(kind: "write" | "append" | "ingest", detail: string): Promise<void> {
    const now = new Date().toISOString()
    await append("log.md", `## [${now}] ${kind} | ${detail}`)
  }

  export function maxFile(): number {
    return MAX_FILE
  }

  export async function has(rel: string): Promise<boolean> {
    await ensure()
    return exists(resolve(rel))
  }

  function norm(rel: string): string {
    return rel.replace(/\\/g, "/")
  }

  export function isHub(rel: string): boolean {
    return HUB.has(norm(rel))
  }

  export function bucket(rel: string): string {
    const n = norm(rel)
    if (n.startsWith("entities/")) return "Entities"
    if (n.startsWith("projects/")) return "Projects"
    if (n.startsWith("preferences/")) return "Preferences"
    if (n.startsWith("facts/")) return "Facts"
    if (n.startsWith("skills/")) return "Skills"
    return "Topics"
  }

  export function title(content: string, rel: string): string {
    const n = norm(rel)
    const skill = n.endsWith("/SKILL.md") || n === "SKILL.md"
    if (skill) {
      const fm = FRONT.exec(content)
      if (fm) {
        const m = FRONT_NAME.exec(fm[1])
        if (m) return m[1].trim().replace(/^["']|["']$/g, "")
      }
      const parts = n.split("/")
      return parts[parts.length - 2] || "skill"
    }
    const h = TITLE_H1.exec(content)
    if (h) return h[1].trim()
    const base = n.split("/").pop() || n
    return base.replace(/\.md$/i, "")
  }

  export function links(content: string): string[] {
    const out: string[] = []
    LINK_MD.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LINK_MD.exec(content))) {
      const t = m[1].trim()
      if (t && !EXTERNAL_LINK.test(t)) out.push(t)
    }
    LINK_WIKI.lastIndex = 0
    while ((m = LINK_WIKI.exec(content))) {
      const t = m[1].trim()
      if (t) out.push(t)
    }
    return out
  }

  function inject(text: string, heading: string, line: string): string {
    const lines = text.split(/\r?\n/)
    const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, "i")
    const idx = lines.findIndex((l) => headingRe.test(l))
    if (idx === -1) {
      const out = lines.slice()
      while (out.length > 0 && out[out.length - 1].trim() === "") out.pop()
      out.push("", `## ${heading}`, line, "")
      return out.join("\n").replace(/\n{3,}/g, "\n\n")
    }
    let end = lines.length
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        end = i
        break
      }
    }
    const head = lines.slice(0, idx + 1)
    const block = lines
      .slice(idx + 1, end)
      .filter((l) => !/^\s*\(none yet\)\s*$/i.test(l))
    while (block.length > 0 && block[block.length - 1].trim() === "") block.pop()
    block.push(line)
    const tail = lines.slice(end)
    const out = [...head, ...block, "", ...tail]
    return out.join("\n").replace(/\n{3,}/g, "\n\n")
  }

  export async function register(rel: string, label: string): Promise<boolean> {
    const n = norm(rel)
    if (HUB.has(n)) return false
    await ensure()
    const idx = resolve("index.md")
    const prior = (await fs.readFile(idx, "utf8").catch(() => "")) || SEED_INDEX
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`\\(${escaped}\\)`).test(prior)) return false
    const next = inject(prior, bucket(n), `- [${label}](${n})`)
    if (next === prior) return false
    await fs.writeFile(idx, next.endsWith("\n") ? next : next + "\n", "utf8")
    return true
  }
}
