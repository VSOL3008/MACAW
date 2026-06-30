import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

let dir = ""

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "macaw-memory-"))
  process.env.MACAW_MEMORY_DIR = dir

  const facts = path.join(dir, "facts")
  await fs.mkdir(facts, { recursive: true })
  await Promise.all(
    Array.from({ length: 1600 }, async (_, i) => {
      const file = path.join(facts, `item-${i}.md`)
      const next = (i + 1) % 1600
      await fs.writeFile(file, `# Item ${i}\n\n- Link to [User](../user.md)\n- Link to [[item-${next}]]\n`, "utf8")
    }),
  )
})

afterAll(async () => {
  if (!dir) return
  await fs.rm(dir, { recursive: true, force: true })
})

test("cold graph returns seed data while indexing runs", async () => {
  const mod = await import("./graph")
  mod.reset()

  const start = performance.now()
  const data = await mod.graph({ limit: 20 })
  const ms = performance.now() - start

  expect(ms).toBeLessThan(1000)
  expect(data.nodes.length).toBeLessThanOrEqual(20)
  expect(data.stats.indexing).toBeTrue()
  expect(data.stats.total_nodes).toBeLessThan(100)
})

test("sync builds the sidecar index and keeps graph output bounded", async () => {
  const mod = await import("./graph")
  const status = await mod.sync()

  expect(status.cache).toBeTrue()
  expect(status.pages).toBeGreaterThanOrEqual(1604)
  expect(status.links).toBeGreaterThanOrEqual(1600)

  const data = await mod.graph({ limit: 30 })
  expect(data.stats.total_nodes).toBeGreaterThanOrEqual(1604)
  expect(data.nodes.length).toBe(30)
  expect(data.edges.length).toBeLessThanOrEqual(6000)
  expect(data.stats.sampled).toBeTrue()
})

test("warm cache loads without reparsing first", async () => {
  const mod = await import("./graph")
  mod.reset()

  const data = await mod.pages({ limit: 25 })
  const status = await mod.status()

  expect(status.cache).toBeTrue()
  expect(status.indexing).toBeFalse()
  expect(data.items.length).toBe(25)
  expect(data.stats.total_matches).toBeGreaterThanOrEqual(1604)
})

test("query filtering uses indexed page text", async () => {
  const mod = await import("./graph")
  const data = await mod.pages({ query: "item 42", limit: 20 })

  expect(data.stats.total_matches).toBeGreaterThan(0)
  expect(data.items.some((item) => item.id === "facts/item-42.md")).toBeTrue()
})

test("refresh picks up changed and deleted pages", async () => {
  const mod = await import("./graph")
  await fs.writeFile(path.join(dir, "facts", "item-42.md"), "# Renamed Fact\n\n- Link to [User](../user.md)\n", "utf8")
  await fs.rm(path.join(dir, "facts", "item-43.md"), { force: true })

  await mod.sync()

  const renamed = await mod.pages({ query: "renamed fact", limit: 20 })
  const deleted = await mod.pages({ query: "item 43", limit: 20 })

  expect(renamed.items.some((item) => item.id === "facts/item-42.md")).toBeTrue()
  expect(deleted.items.some((item) => item.id === "facts/item-43.md")).toBeFalse()
})
