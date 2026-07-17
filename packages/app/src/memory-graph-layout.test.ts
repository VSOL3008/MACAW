import { describe, expect, test } from "bun:test"
import { labels, layout, links, type Edge, type Node, type Plot } from "./memory-graph-layout"

function node(id: string, indegree = 0, outdegree = 0, category = "other"): Node {
  return { id, label: id, category, size: 20, indegree, outdegree }
}

function plot(id: string, x: number, y: number, importance = 1): Plot {
  return {
    ...node(id),
    x,
    y,
    lx: 12,
    ly: 4,
    anchor: "start",
    radius: 6,
    importance,
    component: 0,
  }
}

describe("memory graph layout", () => {
  test("is deterministic and handles empty and single-node graphs", () => {
    expect(layout([], [])).toEqual([])
    expect(layout([node("only")], [])).toHaveLength(1)

    const nodes = [node("hub", 0, 4, "core"), ...["a", "b", "c", "d"].map((id) => node(id, 1))]
    const edges = nodes.slice(1).map((item) => ({ source: "hub", target: item.id }))
    expect(layout(nodes, edges)).toEqual(layout(nodes, edges))
  })

  test("keeps the hub central and preserves readable node spacing", () => {
    const leaves = Array.from({ length: 10 }, (_, idx) => node(`leaf-${idx}`, 1, 0, idx % 2 ? "facts" : "skills"))
    const nodes = [node("hub", 0, leaves.length, "core"), ...leaves]
    const edges = leaves.map((item) => ({ source: "hub", target: item.id }))
    const out = layout(nodes, edges)
    const hub = out.find((item) => item.id === "hub")!
    const center = {
      x: out.reduce((sum, item) => sum + item.x, 0) / out.length,
      y: out.reduce((sum, item) => sum + item.y, 0) / out.length,
    }
    const core = Math.hypot(hub.x - center.x, hub.y - center.y)
    const average = leaves.reduce((sum, item) => {
      const leaf = out.find((entry) => entry.id === item.id)!
      return sum + Math.hypot(leaf.x - center.x, leaf.y - center.y)
    }, 0) / leaves.length
    expect(core).toBeLessThan(average * 0.45)
    const reach = leaves.reduce((sum, item) => {
      const leaf = out.find((entry) => entry.id === item.id)!
      return sum + Math.hypot(leaf.x - hub.x, leaf.y - hub.y)
    }, 0) / leaves.length
    expect(reach).toBeGreaterThan(120)

    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y)).toBeGreaterThanOrEqual(
          out[i].radius + out[j].radius + 26,
        )
      }
    }
  })

  test("places disconnected components into separate islands", () => {
    const nodes = [node("a", 0, 1), node("b", 1), node("x", 0, 1), node("y", 1), node("solo")]
    const edges: Edge[] = [
      { source: "a", target: "b" },
      { source: "x", target: "y" },
    ]
    const out = layout(nodes, edges)
    const center = (ids: string[]) => {
      const list = out.filter((item) => ids.includes(item.id))
      return {
        x: list.reduce((sum, item) => sum + item.x, 0) / list.length,
        y: list.reduce((sum, item) => sum + item.y, 0) / list.length,
      }
    }
    const one = center(["a", "b"])
    const two = center(["x", "y"])
    expect(Math.hypot(one.x - two.x, one.y - two.y)).toBeGreaterThan(180)
  })
})

describe("memory graph links", () => {
  test("aggregates duplicate directions into one straight structural link", () => {
    const nodes = [plot("a", 0, 0), plot("b", 100, 40)]
    const out = links(nodes, [
      { source: "a", target: "b" },
      { source: "a", target: "b" },
      { source: "b", target: "a" },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ source: "a", target: "b", forward: 2, reverse: 1, count: 3 })
    expect((out[0].x2 - out[0].x1) * 40 - (out[0].y2 - out[0].y1) * 100).toBeCloseTo(0)
  })
})

describe("memory graph semantic labels", () => {
  test("reveals more labels with zoom and always retains the selection", () => {
    const nodes = Array.from({ length: 24 }, (_, idx) => plot(`node-${idx}`, (idx % 6) * 130, Math.floor(idx / 6) * 70, 24 - idx))
    const low = labels(nodes, { scale: 0.5 })
    const high = labels(nodes, { scale: 2 })
    expect(high.size).toBeGreaterThan(low.size)

    const close = [
      { ...plot("first", 0, 0, 2), label: "A very long memory page label" },
      { ...plot("second", 8, 0, 1), label: "Another very long memory page label" },
    ]
    const selected = labels(close, { scale: 0.5, selected: "second" })
    expect(selected.has("second")).toBe(true)
    expect(selected.size).toBe(1)
  })
})
