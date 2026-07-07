import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Permission } from "../permission"
import { CorporatePermission } from "./permission"

let mem = ""
let root = ""
let corp: typeof import("./index")

beforeAll(async () => {
  mem = await fs.mkdtemp(path.join(os.tmpdir(), "macaw-corp-memory-"))
  root = await fs.mkdtemp(path.join(os.tmpdir(), "macaw-corp-drive-"))
  process.env.MACAW_MEMORY_DIR = mem
  corp = await import("./index")
  await fs.mkdir(path.join(root, "Finance"), { recursive: true })
  await fs.mkdir(path.join(root, "HR"), { recursive: true })
  await fs.writeFile(path.join(root, "Finance", "budget.txt"), "Budget alpha\nCapex beta\n", "utf8")
  await fs.writeFile(path.join(root, "Finance", "ledger.csv"), "name,total\nalpha,42\n", "utf8")
  await fs.writeFile(path.join(root, "HR", "policy.txt"), "Remote work policy\n", "utf8")
})

afterAll(async () => {
  corp?.reset()
  await import("../config/config").then((mod) => mod.Config.invalidate(true)).catch(() => undefined)
  await fs.rm(mem, { recursive: true, force: true })
  await fs.rm(root, { recursive: true, force: true })
})

test("imports tree output and searches metadata without scanning the real root", async () => {
  const tree = [
    ".",
    "|-- Finance",
    "|   |-- budget.txt",
    "|   `-- ledger.csv",
    "`-- HR",
    "    `-- policy.txt",
  ].join("\n")

  const data = await corp.importTree({ source: "shared", root, label: "Shared", content: tree })
  expect(data.imported).toBe(5)

  const found = await corp.search({ query: "budget", limit: 10 })
  expect(found.items.some((item) => item.path === "Finance/budget.txt")).toBeTrue()
})

test("handles thousands of tree rows as metadata-only index data", async () => {
  const tree = ["."]
    .concat(Array.from({ length: 6000 }, (_, i) => `|-- target-${i}.pdf`))
    .join("\n")
  const start = performance.now()
  await corp.importTree({ source: "huge", root: path.join(root, "missing"), label: "Huge", content: tree })
  const found = await corp.search({ source: "huge", query: "target-5999", limit: 5 })
  const ms = performance.now() - start

  expect(ms).toBeLessThan(3000)
  expect(found.items[0]?.path).toBe("target-5999.pdf")
})

test("streams tree files into the metadata index", async () => {
  const file = path.join(mem, "stream-tree.txt")
  const tree = ["."]
    .concat(Array.from({ length: 3000 }, (_, i) => (i === 2999 ? "|-- target-2999.xlsx" : `|-- file-${i}.pdf`)))
    .concat(["|-- Alpha", "|   `-- budget-final.csv"])
    .join("\n")
  await fs.writeFile(file, tree, "utf8")

  const data = await corp.importFile({
    source: "stream",
    root: path.join(root, "missing-stream"),
    label: "Stream",
    file,
  })
  const byName = await corp.search({ source: "stream", query: "target 2999", limit: 5 })
  const byExt = await corp.search({ source: "stream", query: "xlsx", limit: 5 })
  const byDir = await corp.search({ source: "stream", query: "Alpha budget", limit: 5 })

  expect(data.imported).toBe(3002)
  expect(byName.items[0]?.path).toBe("target-2999.xlsx")
  expect(byExt.items.some((item) => item.path === "target-2999.xlsx")).toBeTrue()
  expect(byDir.items.some((item) => item.path === "Alpha/budget-final.csv")).toBeTrue()
})

test("streams utf16 tree files into the metadata index", async () => {
  const file = path.join(mem, "stream-tree-utf16.txt")
  await fs.writeFile(
    file,
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from([".", "|-- Utf16", "|   `-- budget-final.xlsx"].join("\r\n"), "utf16le"),
    ]),
  )

  const data = await corp.importFile({
    source: "utf16",
    root: path.join(root, "missing-utf16"),
    label: "UTF16",
    file,
  })
  const found = await corp.search({ source: "utf16", query: "budget final", limit: 5 })

  expect(data.imported).toBe(2)
  expect(found.items[0]?.path).toBe("Utf16/budget-final.xlsx")
})

test("file reimport marks missing entries stale", async () => {
  const file = path.join(mem, "stale-tree.txt")
  await fs.writeFile(file, [".", "|-- old.txt", "|-- keep.txt"].join("\n"), "utf8")
  await corp.importFile({ source: "stale", root: path.join(root, "missing-stale"), file })

  await fs.writeFile(file, [".", "|-- keep.txt", "|-- fresh.txt"].join("\n"), "utf8")
  const data = await corp.importFile({ source: "stale", root: path.join(root, "missing-stale"), file })
  const old = await corp.search({ source: "stale", query: "old", limit: 5 })
  const fresh = await corp.search({ source: "stale", query: "fresh", limit: 5 })

  expect(data.imported).toBe(2)
  expect(data.stale).toBe(1)
  expect(old.items.length).toBe(0)
  expect(fresh.items[0]?.path).toBe("fresh.txt")
})

test("file import rejects missing tree files", async () => {
  await expect(
    corp.importFile({
      source: "missing-file",
      root: path.join(root, "missing-file"),
      file: path.join(mem, "missing-tree.txt"),
    }),
  ).rejects.toThrow("not found")
})

test("explicit import root repairs a stale persisted source root", async () => {
  await corp.importTree({
    source: "repair",
    root: path.join(root, "missing-repair"),
    content: [".", "|-- ghost.txt"].join("\n"),
  })
  await corp.importTree({
    source: "repair",
    root: path.join(root, "Finance"),
    content: [".", "|-- budget.txt"].join("\n"),
  })

  const read = await corp.read({ source: "repair", path: "budget.txt", limit: 10 })

  expect(read.available).toBeTrue()
  expect(read.text).toContain("Budget alpha")
})

test("loads corporate sources from local project config without instance context", async () => {
  const cwd = process.cwd()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "macaw-corp-project-"))
  await fs.mkdir(path.join(dir, ".opencode"), { recursive: true })
  await fs.writeFile(
    path.join(dir, ".opencode", "opencode.jsonc"),
    JSON.stringify({
      corporate_search: {
        sources: [
          {
            id: "local-config",
            label: "Local Config",
            root: path.join(root, "Finance"),
          },
        ],
      },
    }),
    "utf8",
  )
  process.chdir(dir)

  try {
    await corp.importTree({ source: "local-config", content: [".", "|-- budget.txt"].join("\n") })
    const read = await corp.read({ source: "local-config", path: "budget.txt", limit: 10 })
    const status = await corp.status()

    expect(read.available).toBeTrue()
    expect(read.text).toContain("Budget alpha")
    expect(status.sources.find((item) => item.id === "local-config")?.root).toBe(path.join(root, "Finance"))
  } finally {
    process.chdir(cwd)
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("targeted list refreshes one directory and read extracts capped text", async () => {
  const listed = await corp.list({ source: "shared", path: "Finance", limit: 10 })
  expect(listed.mode).toBe("disk")
  expect(listed.items.map((item) => item.path)).toContain("Finance/ledger.csv")

  const read = await corp.read({ source: "shared", path: "Finance/budget.txt", limit: 10 })
  expect(read.available).toBeTrue()
  expect(read.text).toContain("Budget alpha")
  expect(read.truncated).toBeFalse()
})

test("list falls back to indexed children when the real root is unavailable", async () => {
  const tree = [".", "|-- Build", "|   `-- Alpha", "|       `-- README.txt"].join("\n")
  await corp.importTree({ source: "offline", root: path.join(root, "missing-offline"), label: "Offline", content: tree })

  const listed = await corp.list({ source: "offline", path: "Build/Alpha", limit: 10 })

  expect(listed.mode).toBe("index")
  expect(listed.reason).toContain("unavailable")
  expect(listed.items.map((item) => item.path)).toContain("Build/Alpha/README.txt")
})

test("read returns indexed metadata instead of throwing when the real file is unavailable", async () => {
  const tree = [".", "|-- Build", "|   `-- Alpha", "|       `-- README.txt"].join("\n")
  await corp.importTree({
    source: "offline-read",
    root: path.join(root, "missing-offline-read"),
    label: "Offline Read",
    content: tree,
  })

  const read = await corp.read({ source: "offline-read", path: "Build/Alpha/README.txt" })

  expect(read.available).toBeFalse()
  expect(read.reason).toContain("unavailable")
  expect(read.text).toContain("Indexed metadata only")
  expect(read.text).toContain("offline-read:Build/Alpha/README.txt")
})

test("read reports unsupported existing files without failing", async () => {
  await fs.writeFile(path.join(root, "Finance", "archive.bin"), Buffer.from([1, 2, 3, 4]))
  const read = await corp.read({ source: "shared", path: "Finance/archive.bin" })

  expect(read.available).toBeTrue()
  expect(read.reason).toBe("unsupported type")
  expect(read.text).toContain("not supported")
})

test("rejects paths that escape the configured source root", async () => {
  await fs.writeFile(path.join(path.dirname(root), "outside.txt"), "secret", "utf8")
  await expect(corp.read({ source: "shared", path: "../outside.txt" })).rejects.toThrow("escapes")
})

test("agent notes become searchable aliases in the local mirror", async () => {
  await corp.note({ source: "shared", path: "HR/policy.txt", aliases: "work-from-home", notes: "Remote policy summary" })
  const found = await corp.search({ query: "work from home", limit: 10 })
  expect(found.items.some((item) => item.path === "HR/policy.txt")).toBeTrue()
})

test("corporate search permissions allow only corporate and safe memory tools", async () => {
  const rules = CorporatePermission.rules()
  expect(Permission.evaluate("corp_read", "*", rules).action).toBe("allow")
  expect(Permission.evaluate("corp_search", "*", rules).action).toBe("allow")
  expect(Permission.evaluate("corp_import_file", "*", rules).action).toBe("allow")
  expect(Permission.evaluate("memory_read", "*", rules).action).toBe("allow")
  expect(Permission.evaluate("bash", "*", rules).action).toBe("deny")
  expect(Permission.evaluate("read", "*", rules).action).toBe("deny")
  expect(Permission.evaluate("edit", "*", rules).action).toBe("deny")
  expect(Permission.evaluate("memory_write", "*", rules).action).toBe("deny")
})
