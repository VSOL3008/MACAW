import fs from "fs/promises"
import os from "os"
import path from "path"
import { createReadStream, mkdirSync } from "fs"
import { createInterface } from "readline"
import { Database } from "bun:sqlite"
import { parse as parseJsonc } from "jsonc-parser"
import { Config } from "@/config/config"
import { AppFileSystem } from "@/filesystem"
import { Memory } from "@/memory/memory"
import { extractPdfText } from "@/util/pdf"

const CACHE = ".macaw-index"
const STORE = "corporate-v1.sqlite"
const RESULTS = 50
const ENTRIES = 200
const BYTES = 5 * 1024 * 1024
const TEXT = 12_000
const SEARCH_MAX = 500
const BATCH = 5000
const ENTRY_SQL = `INSERT INTO corporate_entry (
  source, path, name, ext, type, parent, depth, size, modified, discovered, stale, notes, aliases
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(source, path) DO UPDATE SET
  name = excluded.name,
  ext = excluded.ext,
  type = excluded.type,
  parent = excluded.parent,
  depth = excluded.depth,
  size = excluded.size,
  modified = excluded.modified,
  discovered = excluded.discovered,
  stale = excluded.stale`

export type Source = {
  id: string
  label: string
  root: string
  tree?: string
}

export type Limits = {
  results: number
  entries: number
  bytes: number
  text: number
}

export type Entry = {
  source: string
  path: string
  name: string
  ext: string
  type: "file" | "directory"
  parent: string
  depth: number
  size?: number
  modified?: number
  discovered: number
  stale: boolean
  notes: string
  aliases: string
}

export type SearchData = {
  items: Array<Entry & { score: number }>
  next_cursor?: string
  stats: {
    total_matches: number
    limit: number
  }
}

export type StatusData = {
  root: string
  sources: Array<Source & { entries: number; stale: number; imported?: number }>
  totals: {
    sources: number
    entries: number
    stale: number
  }
  limits: Limits
}

export type ImportData = {
  source: string
  imported: number
  stale: number
}

export type ListData = {
  source: string
  path: string
  items: Entry[]
  truncated: boolean
  mode: "disk" | "index"
  reason?: string
}

export type ReadData = {
  source: string
  path: string
  type: string
  text: string
  truncated: boolean
  bytes: number
  available: boolean
  reason?: string
}

type Store = {
  root: string
  db: Database
}

type Row = {
  source: string
  path: string
  name: string
  ext: string
  type: string
  parent: string
  depth: number
  size: number | null
  modified: number | null
  discovered: number
  stale: number
  notes: string
  aliases: string
}

type SourceRow = {
  id: string
  label: string
  root: string
  tree: string | null
  updated: number
  imported: number | null
}

type Hit = Row & {
  rank?: number
}

type ImportInput = {
  source: string
  root?: string
  label?: string
  tree?: string
}

type RawSource = {
  id?: unknown
  label?: unknown
  root?: unknown
  tree?: unknown
}

type RawConfig = {
  corporate_search?: {
    sources?: RawSource[]
  }
}

type Real = {
  full: string
  rel: string
  root: string
}

let store: Store | undefined
let clock = 0
let local: { cwd: string; sources: Source[] } | undefined
let roots = new Map<string, string>()
let reals = new Map<string, Real>()

export function reset() {
  store?.db.close()
  store = undefined
  local = undefined
  roots = new Map()
  reals = new Map()
}

function expand(input: string) {
  if (input === "~") return os.homedir()
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2))
  if (input.startsWith("$HOME")) return path.join(os.homedir(), input.slice(5))
  return input
}

function cleanRoot(root: string) {
  return AppFileSystem.normalizePath(path.resolve(expand(root)))
}

function cleanSource(item: RawSource): Source | undefined {
  if (typeof item.id !== "string" || typeof item.root !== "string") return
  return {
    id: item.id,
    label: typeof item.label === "string" ? item.label : item.id,
    root: cleanRoot(item.root),
    tree: typeof item.tree === "string" ? item.tree : undefined,
  }
}

function norm(input: string) {
  return input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "")
}

function inside(root: string, file: string) {
  const base = process.platform === "win32" ? root.toLowerCase() : root
  const next = process.platform === "win32" ? file.toLowerCase() : file
  return next === base || next.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
}

function stamp() {
  clock = Math.max(Date.now(), clock + 1)
  return clock
}

function rel(input = ".") {
  if (path.isAbsolute(input)) throw new Error("Corporate path must be relative to the configured source root")
  const next = path.posix.normalize(norm(input) || ".")
  if (next === ".") return ""
  if (next === ".." || next.startsWith("../")) throw new Error("Corporate path escapes the configured source root")
  return next
}

function lost(err: unknown) {
  if (!err || typeof err !== "object" || !("code" in err)) return false
  const code = String((err as { code?: unknown }).code)
  return code === "ENOENT" || code === "ENOTDIR"
}

async function localSources() {
  const cwd = process.cwd()
  if (local?.cwd === cwd) return local.sources
  const files: string[] = []
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    files.unshift(path.join(dir, ".opencode", "opencode.jsonc"))
    files.unshift(path.join(dir, ".opencode", "opencode.json"))
    if (dir === path.dirname(dir)) break
  }
  const map = new Map<string, Source>()
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    if (!text) continue
    const parsed = parseJsonc(text, undefined, { allowTrailingComma: true }) as RawConfig | undefined
    const sources = parsed?.corporate_search?.sources ?? []
    for (const item of sources) {
      const src = cleanSource(item)
      if (src) map.set(src.id, src)
    }
  }
  local = { cwd, sources: [...map.values()] }
  return local.sources
}

async function db() {
  const root = Memory.root()
  if (store?.root === root) return store.db
  store?.db.close()
  mkdirSync(path.join(root, CACHE), { recursive: true })
  const next = new Database(path.join(root, CACHE, STORE), { create: true })
  next.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS corporate_source (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      root TEXT NOT NULL,
      tree TEXT,
      updated INTEGER NOT NULL,
      imported INTEGER
    );
    CREATE TABLE IF NOT EXISTS corporate_entry (
      source TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      type TEXT NOT NULL,
      parent TEXT NOT NULL,
      depth INTEGER NOT NULL,
      size INTEGER,
      modified INTEGER,
      discovered INTEGER NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      aliases TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (source, path)
    );
    CREATE INDEX IF NOT EXISTS corporate_entry_source_idx ON corporate_entry (source);
    CREATE INDEX IF NOT EXISTS corporate_entry_parent_idx ON corporate_entry (source, parent);
    CREATE INDEX IF NOT EXISTS corporate_entry_parent_stale_idx ON corporate_entry (source, parent, stale, type, name);
    CREATE INDEX IF NOT EXISTS corporate_entry_name_idx ON corporate_entry (source, name);
    CREATE INDEX IF NOT EXISTS corporate_entry_ext_idx ON corporate_entry (source, ext);
    CREATE INDEX IF NOT EXISTS corporate_entry_stale_idx ON corporate_entry (source, stale);
    CREATE VIRTUAL TABLE IF NOT EXISTS corporate_fts USING fts5(
      source UNINDEXED,
      path,
      name,
      ext,
      parent,
      notes,
      aliases
    );
    PRAGMA user_version = 1;
  `)
  store = { root, db: next }
  return next
}

function entry(row: Row): Entry {
  return {
    source: row.source,
    path: row.path,
    name: row.name,
    ext: row.ext,
    type: row.type === "directory" ? "directory" : "file",
    parent: row.parent,
    depth: row.depth,
    size: row.size ?? undefined,
    modified: row.modified ?? undefined,
    discovered: row.discovered,
    stale: row.stale === 1,
    notes: row.notes,
    aliases: row.aliases,
  }
}

async function cfg() {
  const info = await Config.get().catch(() => Config.getGlobal().catch(() => undefined))
  const corp = info?.corporate_search
  const map = new Map<string, Source>((await localSources()).map((item) => [item.id, item]))
  for (const item of corp?.sources ?? []) {
    map.set(item.id, {
      id: item.id,
      label: item.label ?? item.id,
      root: cleanRoot(item.root),
      tree: item.tree,
    })
  }
  return {
    sources: [...map.values()],
    limits: {
      results: Math.max(1, Math.min(corp?.limits?.results ?? RESULTS, 250)),
      entries: Math.max(1, Math.min(corp?.limits?.entries ?? ENTRIES, 1000)),
      bytes: Math.max(1024, Math.min(corp?.limits?.bytes ?? BYTES, 50 * 1024 * 1024)),
      text: Math.max(1000, Math.min(corp?.limits?.text ?? TEXT, 100_000)),
    },
  }
}

async function source(id: string, root?: string, label?: string): Promise<Source> {
  const conf = await cfg()
  const found = conf.sources.find((item) => item.id === id)
  if (found) return found
  if (root) {
    return {
      id,
      label: label ?? id,
      root: cleanRoot(root),
    }
  }
  const sql = await db()
  const row = sql.query("SELECT id, label, root, tree, updated, imported FROM corporate_source WHERE id = ?").get(id) as
    | SourceRow
    | undefined
  if (row) {
    return {
      id: row.id,
      label: row.label,
      root: cleanRoot(row.root),
      tree: row.tree ?? undefined,
    }
  }
  throw new Error(`Corporate source is not configured: ${id}`)
}

async function base(src: Source) {
  const hit = roots.get(src.root)
  if (hit) return hit
  const next = await fs.realpath(src.root).then(AppFileSystem.normalizePath)
  roots.set(src.root, next)
  return next
}

async function safe(src: Source, rel = "."): Promise<Real> {
  const next = rel === "." ? "" : rel
  const key = `${src.root}\0${next}`
  const hit = reals.get(key)
  if (hit) return hit
  const root = await base(src)
  const full = AppFileSystem.normalizePath(path.resolve(root, next || "."))
  const real = await fs.realpath(full).then(AppFileSystem.normalizePath)
  if (!inside(root, real)) throw new Error("Corporate path escapes the configured source root")
  const out = {
    full: real,
    rel: norm(path.relative(root, real)),
    root,
  }
  reals.set(key, out)
  return out
}

function parts(rel: string) {
  const name = path.posix.basename(rel)
  const ext = name.includes(".") ? path.posix.extname(name).slice(1).toLowerCase() : ""
  const parent = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel)
  const depth = rel ? rel.split("/").length - 1 : 0
  return { name, ext, parent, depth }
}

function save(stmt: ReturnType<Database["query"]>, item: Entry) {
  stmt.run(
    item.source,
    item.path,
    item.name,
    item.ext,
    item.type,
    item.parent,
    item.depth,
    item.size ?? null,
    item.modified ?? null,
    item.discovered,
    item.stale ? 1 : 0,
    item.notes,
    item.aliases,
  )
}

function upsert(sql: Database, item: Entry) {
  save(sql.query(ENTRY_SQL), item)
  sql.query("DELETE FROM corporate_fts WHERE source = ? AND path = ?").run(item.source, item.path)
  sql
    .query("INSERT INTO corporate_fts (source, path, name, ext, parent, notes, aliases) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(item.source, item.path, item.name, item.ext, item.parent, item.notes, item.aliases)
}

function bulk(sql: Database, items: Entry[]) {
  const stmt = sql.query(ENTRY_SQL)
  for (const item of items) {
    save(stmt, item)
  }
}

function syncFts(sql: Database, source: string) {
  sql.query("DELETE FROM corporate_fts WHERE source = ?").run(source)
  sql
    .query(
      `INSERT INTO corporate_fts (source, path, name, ext, parent, notes, aliases)
      SELECT source, path, name, ext, parent, notes, aliases
      FROM corporate_entry
      WHERE source = ? AND stale = 0`,
    )
    .run(source)
}

function tokens(query: string) {
  return query
    .toLowerCase()
    .match(/[a-z0-9_]+/g)
    ?.filter((item) => item.length > 1)
    .slice(0, 8)
}

function score(row: Hit, query: string, toks: string[]) {
  const q = query.toLowerCase()
  const name = row.name.toLowerCase()
  const rel = row.path.toLowerCase()
  const notes = row.notes.toLowerCase()
  const alias = row.aliases.toLowerCase()
  const exact = name === q ? 10_000 : 0
  const start = name.startsWith(q) || rel.startsWith(q) ? 7_500 : 0
  const contain = rel.includes(q) || notes.includes(q) || alias.includes(q) ? 3_000 : 0
  const ext = row.ext && toks.includes(row.ext) ? 800 : 0
  const stale = row.stale === 1 ? -2_000 : 0
  const rank = row.rank ? Math.max(0, 1000 - row.rank) : 0
  return exact + start + contain + ext + stale + rank + Math.max(0, 200 - row.depth)
}

function parse(line: string) {
  const raw = line.replace(/^\uFEFF/, "").replace(/\r/g, "")
  const text = raw.trim()
  if (!text) return
  if (text === "." || /^[A-Za-z]:\.$/.test(text)) return
  if (/^(Folder PATH listing|Volume serial number|[0-9]+ directories?,|[0-9]+ files?)/i.test(text)) return
  if (/^```/.test(text) || /^#+\s/.test(text)) return

  const connector = raw.match(/^([ \u2502|\t]*)(?:[\u251c\u2514]\u2500+\s*|[|`+\\]-+\s*)(.+)$/)
  if (connector) {
    return {
      depth: Math.max(0, Math.floor(connector[1].replace(/\t/g, "    ").length / 4)),
      name: connector[2].trim(),
    }
  }

  const plain = raw.match(/^([ \u2502|\t]+)([^\u2502\u251c\u2514]+)$/)
  if (!plain) return
  return {
    depth: Math.max(0, Math.floor(plain[1].replace(/\t/g, "    ").length / 4) - 1),
    name: plain[2].trim(),
  }
}

function* textLines(text: string) {
  let start = 0
  while (start <= text.length) {
    const end = text.indexOf("\n", start)
    if (end === -1) {
      if (start < text.length) yield text.slice(start)
      return
    }
    yield text.slice(start, end)
    start = end + 1
  }
}

async function* fileLines(file: string) {
  const enc = await encoding(file)
  const lines = createInterface({
    input: createReadStream(file, { encoding: enc }),
    crlfDelay: Infinity,
  })
  for await (const line of lines) yield line
}

async function encoding(file: string) {
  const handle = await fs.open(file, "r")
  const buf = Buffer.alloc(3)
  const read = await handle.read(buf, 0, 3, 0)
  await handle.close()
  if (read.bytesRead >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return "utf16le"
  if (read.bytesRead >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    throw new Error(`Unsupported corporate tree encoding: UTF-16BE (${file})`)
  }
  return "utf8"
}

async function importLines(input: ImportInput, lines: AsyncIterable<string> | Iterable<string>): Promise<ImportData> {
  const src = await source(input.source, input.root, input.label)
  const sql = await db()
  const now = stamp()
  const stack: string[] = []
  const seen = new Set<string>()
  const dirs = new Set<string>()
  const rows: Entry[] = []
  let imported = 0

  const tx = sql.transaction((items: Entry[], parents: string[]) => {
    bulk(sql, items)
    const stmt = sql.query("UPDATE corporate_entry SET type = 'directory', ext = '' WHERE source = ? AND path = ?")
    for (const item of parents) stmt.run(src.id, item)
  })

  function flush() {
    if (rows.length === 0 && dirs.size === 0) return
    tx(rows.splice(0), [...dirs])
    dirs.clear()
  }

  for await (const line of lines) {
    const item = parse(line)
    if (!item) continue
    const name = item.name.replace(/\/$/, "").trim()
    if (!name || name === ".") continue
    while (stack.length > item.depth) stack.pop()
    const parent = stack[item.depth - 1] ?? ""
    const rel = norm(parent ? path.posix.join(parent, name) : name)
    stack[item.depth] = rel
    if (seen.has(rel)) continue
    seen.add(rel)
    if (parent) dirs.add(parent)
    const p = parts(rel)
    rows.push({
      source: src.id,
      path: rel,
      name: p.name,
      ext: item.name.endsWith("/") ? "" : p.ext,
      parent: p.parent,
      depth: p.depth,
      discovered: now,
      stale: false,
      notes: "",
      aliases: "",
      type: item.name.endsWith("/") ? "directory" : "file",
    })
    imported += 1
    if (rows.length >= BATCH) flush()
  }
  flush()

  const done = sql.transaction(() => {
    sql
      .query(
        `INSERT INTO corporate_source (id, label, root, tree, updated, imported)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          root = excluded.root,
          tree = excluded.tree,
          updated = excluded.updated,
          imported = excluded.imported`,
      )
      .run(src.id, input.label ?? src.label, src.root, input.tree ?? src.tree ?? null, now, now)
    sql.query("UPDATE corporate_entry SET stale = 1 WHERE source = ? AND discovered != ?").run(src.id, now)
    syncFts(sql, src.id)
  })
  done()

  const stale = (
    sql.query("SELECT COUNT(*) AS count FROM corporate_entry WHERE source = ? AND stale = 1").get(src.id) as {
      count: number
    }
  ).count
  return { source: src.id, imported, stale }
}

export async function importTree(input: ImportInput & { content: string }): Promise<ImportData> {
  return importLines(input, textLines(input.content))
}

export async function importFile(input: ImportInput & { file: string }): Promise<ImportData> {
  const file = AppFileSystem.normalizePath(path.resolve(expand(input.file)))
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat) throw new Error(`Corporate tree file not found: ${file}`)
  if (!stat.isFile()) throw new Error(`Corporate tree path is not a file: ${file}`)
  return importLines({ ...input, tree: input.tree ?? file }, fileLines(file))
}

export async function status(): Promise<StatusData> {
  const sql = await db()
  const conf = await cfg()
  const rows = sql.query("SELECT id, label, root, tree, updated, imported FROM corporate_source").all() as SourceRow[]
  const map = new Map<string, SourceRow>(rows.map((row) => [row.id, row]))
  for (const item of conf.sources) {
    const row = map.get(item.id)
    map.set(item.id, {
      id: item.id,
      label: item.label,
      root: item.root,
      tree: item.tree ?? row?.tree ?? null,
      updated: row?.updated ?? 0,
      imported: row?.imported ?? null,
    })
  }
  const sources = [...map.values()].map((row) => {
    const count = sql
      .query("SELECT COUNT(*) AS count FROM corporate_entry WHERE source = ? AND stale = 0")
      .get(row.id) as { count: number }
    const stale = sql
      .query("SELECT COUNT(*) AS count FROM corporate_entry WHERE source = ? AND stale = 1")
      .get(row.id) as { count: number }
    return {
      id: row.id,
      label: row.label,
      root: row.root,
      tree: row.tree ?? undefined,
      imported: row.imported ?? undefined,
      entries: count.count,
      stale: stale.count,
    }
  })
  return {
    root: path.join(Memory.root(), CACHE, STORE),
    sources,
    totals: {
      sources: sources.length,
      entries: sources.reduce((sum, item) => sum + item.entries, 0),
      stale: sources.reduce((sum, item) => sum + item.stale, 0),
    },
    limits: conf.limits,
  }
}

export async function search(input: {
  query: string
  source?: string
  limit?: number
  cursor?: string
}): Promise<SearchData> {
  const sql = await db()
  const conf = await cfg()
  const limit = Math.max(1, Math.min(input.limit ?? conf.limits.results, 250))
  const cursor = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0)
  const query = input.query.trim()
  const toks = tokens(query) ?? []
  const size = Math.max(limit + cursor, SEARCH_MAX)
  const match = toks.map((item) => `${item}*`).join(" ")
  const rows =
    toks.length > 0 && input.source
      ? (sql
          .query(
            `SELECT e.*, bm25(corporate_fts) AS rank
              FROM corporate_fts JOIN corporate_entry e
                ON e.source = corporate_fts.source AND e.path = corporate_fts.path
              WHERE corporate_fts MATCH ? AND e.source = ? AND e.stale = 0
              LIMIT ?`,
          )
          .all(match, input.source, size) as Hit[])
      : toks.length > 0
        ? (sql
            .query(
              `SELECT e.*, bm25(corporate_fts) AS rank
                FROM corporate_fts JOIN corporate_entry e
                  ON e.source = corporate_fts.source AND e.path = corporate_fts.path
                WHERE corporate_fts MATCH ? AND e.stale = 0
                LIMIT ?`,
            )
            .all(match, size) as Hit[])
        : input.source
          ? (sql
              .query("SELECT * FROM corporate_entry WHERE source = ? AND stale = 0 ORDER BY discovered DESC LIMIT ?")
              .all(input.source, size) as Hit[])
          : (sql
              .query("SELECT * FROM corporate_entry WHERE stale = 0 ORDER BY discovered DESC LIMIT ?")
              .all(size) as Hit[])

  const ranked = rows
    .map((row) => ({ ...entry(row), score: score(row, query, toks) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const part = ranked.slice(cursor, cursor + limit)
  return {
    items: part,
    next_cursor: cursor + limit < ranked.length ? String(cursor + limit) : undefined,
    stats: {
      total_matches: ranked.length,
      limit,
    },
  }
}

export async function note(input: {
  source: string
  path: string
  notes?: string
  aliases?: string
}): Promise<Entry> {
  const sql = await db()
  const rel = norm(input.path)
  sql
    .query(
      `UPDATE corporate_entry SET
        notes = CASE WHEN ? IS NULL OR ? = '' THEN notes ELSE trim(notes || char(10) || ?) END,
        aliases = CASE WHEN ? IS NULL OR ? = '' THEN aliases ELSE trim(aliases || ' ' || ?) END
      WHERE source = ? AND path = ?`,
    )
    .run(
      input.notes ?? null,
      input.notes ?? null,
      input.notes ?? "",
      input.aliases ?? null,
      input.aliases ?? null,
      input.aliases ?? "",
      input.source,
      rel,
    )
  const row = sql
    .query("SELECT source, path, name, ext, type, parent, depth, size, modified, discovered, stale, notes, aliases FROM corporate_entry WHERE source = ? AND path = ?")
    .get(input.source, rel) as Row | undefined
  if (!row) throw new Error(`Corporate entry not found: ${input.source}:${rel}`)
  upsert(sql, entry(row))
  return entry(row)
}

function indexed(sql: Database, source: string, parent: string, limit: number, reason: string): ListData {
  const rows = sql
    .query(
      `SELECT source, path, name, ext, type, parent, depth, size, modified, discovered, stale, notes, aliases
      FROM corporate_entry
      WHERE source = ? AND parent = ? AND stale = 0
      ORDER BY type, name
      LIMIT ?`,
    )
    .all(source, parent, limit + 1) as Row[]
  return {
    source,
    path: parent,
    items: rows.slice(0, limit).map(entry),
    truncated: rows.length > limit,
    mode: "index",
    reason,
  }
}

function unavailable(sql: Database, source: string, path: string, reason: string): ReadData {
  const row = sql
    .query(
      `SELECT source, path, name, ext, type, parent, depth, size, modified, discovered, stale, notes, aliases
      FROM corporate_entry
      WHERE source = ? AND path = ? AND stale = 0`,
    )
    .get(source, path) as Row | undefined
  const item = row ? entry(row) : undefined
  const text = item
    ? [
        "Indexed metadata only. No file content was extracted by corp_read.",
        `Reason: ${reason}`,
        `Path: ${source}:${item.path}`,
        `Type: ${item.type}${item.ext ? ` .${item.ext}` : ""}`,
        item.size === undefined ? undefined : `Size: ${item.size} bytes`,
        item.modified === undefined ? undefined : `Modified: ${new Date(item.modified).toISOString()}`,
        item.notes ? `Notes: ${item.notes}` : undefined,
        item.aliases ? `Aliases: ${item.aliases}` : undefined,
        item.type === "directory"
          ? "Use corp_list on this path to inspect indexed children."
          : "Reconnect or sync the corporate drive, then retry corp_read to extract file content.",
      ]
        .filter((line): line is string => !!line)
        .join("\n")
    : [
        "No active corporate mirror entry was found, and the real path is not available from this machine.",
        `Reason: ${reason}`,
        `Path: ${source}:${path}`,
      ].join("\n")
  return {
    source,
    path,
    type: item?.type === "directory" ? "directory" : item?.ext || "missing",
    text,
    truncated: false,
    bytes: 0,
    available: false,
    reason,
  }
}

export async function list(input: { source: string; path?: string; limit?: number; refresh?: boolean }): Promise<ListData> {
  const src = await source(input.source)
  const conf = await cfg()
  const limit = Math.max(1, Math.min(input.limit ?? conf.limits.entries, 1000))
  const parent = rel(input.path ?? ".")
  const sql = await db()
  if (!input.refresh) {
    const cached = indexed(sql, src.id, parent, limit, "Using indexed mirror. Pass refresh=true to refresh this real corporate directory.")
    if (cached.items.length > 0 || cached.truncated) return cached
  }
  const resolved = await safe(src, parent).catch((err) => {
    if (lost(err)) return undefined
    throw err
  })
  if (!resolved) return indexed(sql, src.id, parent, limit, `Real corporate path is unavailable under ${src.root}`)
  const now = Date.now()
  const rows: Entry[] = []
  let total = 0

  const dir = await fs.opendir(resolved.full).catch((err) => {
    if (lost(err)) return undefined
    throw err
  })
  if (!dir) return indexed(sql, src.id, parent, limit, `Real corporate directory is unavailable: ${resolved.full}`)
  for await (const item of dir) {
    total += 1
    if (rows.length >= limit) break
    const child = norm(parent ? path.posix.join(parent, item.name) : item.name)
    const p = parts(child)
    rows.push({
      source: src.id,
      path: child,
      name: p.name,
      ext: p.ext,
      type: item.isDirectory() ? "directory" : "file",
      parent: p.parent,
      depth: p.depth,
      discovered: now,
      stale: false,
      notes: "",
      aliases: "",
    })
  }
  rows.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name))

  const tx = sql.transaction((entries: Entry[]) => {
    sql.query("UPDATE corporate_entry SET stale = 1 WHERE source = ? AND parent = ?").run(src.id, parent)
    for (const item of entries) upsert(sql, item)
  })
  tx(rows)
  return {
    source: src.id,
    path: parent,
    items: rows,
    truncated: total > rows.length,
    mode: "disk",
  }
}

function textish(ext: string) {
  return new Set(["", "txt", "md", "csv", "json", "xml", "log", "ini", "cfg", "yml", "yaml", "sql", "ps1"]).has(ext)
}

function lines(text: string, offset: number, limit: number) {
  const raw = text.split(/\r?\n/)
  const start = Math.max(0, offset - 1)
  const part = raw.slice(start, start + limit)
  return {
    text: part.map((line, idx) => `${start + idx + 1}: ${line}`).join("\n"),
    truncated: start + part.length < raw.length,
  }
}

function cap(text: string, max: number) {
  if (Buffer.byteLength(text, "utf8") <= max) return { text, truncated: false }
  return { text: Buffer.from(text, "utf8").subarray(0, max).toString("utf8"), truncated: true }
}

async function office(full: string, ext: string, max: number) {
  const zip = await import("@zip.js/zip.js")
  const reader = new zip.ZipReader(new zip.BlobReader(Bun.file(full)))
  const entries = await reader.getEntries()
  const wanted = entries
    .filter((item) => {
      if (!item.filename.endsWith(".xml")) return false
      if (["docx", "docm"].includes(ext)) return item.filename === "word/document.xml"
      if (["xlsx", "xlsm"].includes(ext)) {
        return item.filename.startsWith("xl/sharedStrings") || item.filename.startsWith("xl/worksheets/")
      }
      if (["pptx", "pptm"].includes(ext)) return item.filename.startsWith("ppt/slides/")
      return false
    })
    .sort((a, b) => a.filename.localeCompare(b.filename))
  const out: string[] = []
  for (const item of wanted) {
    const body = await item.getData?.(new zip.TextWriter())
    if (!body) continue
    out.push(`# ${item.filename}\n${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`)
    if (Buffer.byteLength(out.join("\n\n"), "utf8") >= max) break
  }
  await reader.close()
  return cap(out.join("\n\n") || "(no extractable Office XML text)", max)
}

export async function read(input: {
  source: string
  path: string
  offset?: number
  limit?: number
}): Promise<ReadData> {
  const src = await source(input.source)
  const conf = await cfg()
  const next = rel(input.path)
  const sql = await db()
  const resolved = await safe(src, next).catch((err) => {
    if (lost(err)) return undefined
    throw err
  })
  if (!resolved) return unavailable(sql, src.id, next, `Real corporate path is unavailable under ${src.root}`)
  const stat = await fs.stat(resolved.full).catch((err) => {
    if (lost(err)) return undefined
    throw err
  })
  if (!stat) return unavailable(sql, src.id, next, `Real corporate file is unavailable: ${resolved.full}`)
  const file = norm(resolved.rel)
  if (stat.isDirectory()) return unavailable(sql, src.id, file, "Path is a directory; use corp_list to inspect it.")
  const p = parts(file)
  upsert(sql, {
    source: src.id,
    path: file,
    name: p.name,
    ext: p.ext,
    type: "file",
    parent: p.parent,
    depth: p.depth,
    size: stat.size,
    modified: stat.mtimeMs,
    discovered: Date.now(),
    stale: false,
    notes: "",
    aliases: "",
  })

  if (stat.size > conf.limits.bytes) {
    return {
      source: src.id,
      path: file,
      type: p.ext || "file",
      text: `File is ${stat.size} bytes, above the configured corporate read cap of ${conf.limits.bytes} bytes.`,
      truncated: true,
      bytes: 0,
      available: true,
      reason: "size cap",
    }
  }

  if (p.ext === "pdf") {
    const text = await extractPdfText(new Uint8Array(await Bun.file(resolved.full).arrayBuffer()))
    const next = cap(text, conf.limits.text)
    return {
      source: src.id,
      path: file,
      type: "pdf",
      text: next.text,
      truncated: next.truncated,
      bytes: stat.size,
      available: true,
    }
  }

  if (["docx", "docm", "xlsx", "xlsm", "pptx", "pptm"].includes(p.ext)) {
    const next = await office(resolved.full, p.ext, conf.limits.text)
    return {
      source: src.id,
      path: file,
      type: p.ext,
      text: next.text,
      truncated: next.truncated,
      bytes: stat.size,
      available: true,
    }
  }

  if (!textish(p.ext)) {
    return {
      source: src.id,
      path: file,
      type: p.ext || "file",
      text: `File exists, but .${p.ext || "unknown"} extraction is not supported by corp_read. Use the real corporate drive or add a supported extractor for this file type.`,
      truncated: false,
      bytes: stat.size,
      available: true,
      reason: "unsupported type",
    }
  }

  const raw = await Bun.file(resolved.full).slice(0, conf.limits.bytes).text()
  const clipped = cap(raw, conf.limits.text)
  const view = lines(clipped.text, Math.max(1, input.offset ?? 1), Math.max(1, Math.min(input.limit ?? 200, 2000)))
  return {
    source: src.id,
    path: file,
    type: p.ext || "text",
    text: view.text,
    truncated: clipped.truncated || view.truncated || stat.size > conf.limits.bytes,
    bytes: Math.min(stat.size, conf.limits.bytes),
    available: true,
  }
}
