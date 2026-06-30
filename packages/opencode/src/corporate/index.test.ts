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

test("targeted list refreshes one directory and read extracts capped text", async () => {
  const listed = await corp.list({ source: "shared", path: "Finance", limit: 10 })
  expect(listed.items.map((item) => item.path)).toContain("Finance/ledger.csv")

  const read = await corp.read({ source: "shared", path: "Finance/budget.txt", limit: 10 })
  expect(read.text).toContain("Budget alpha")
  expect(read.truncated).toBeFalse()
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
  expect(Permission.evaluate("memory_read", "*", rules).action).toBe("allow")
  expect(Permission.evaluate("bash", "*", rules).action).toBe("deny")
  expect(Permission.evaluate("read", "*", rules).action).toBe("deny")
  expect(Permission.evaluate("edit", "*", rules).action).toBe("deny")
  expect(Permission.evaluate("memory_write", "*", rules).action).toBe("deny")
})
