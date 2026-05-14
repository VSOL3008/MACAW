import { describe, expect, test } from "bun:test"
import { iou, merge, parseVisual, pick } from "../../src/tool/discover"
import type { Ctrl } from "../../src/tool/uia"

const uiaBtn: Ctrl = {
  runtimeId: "42,1,17",
  automationId: "save",
  name: "Save",
  className: "Button",
  controlType: "button",
  rect: [100, 200, 180, 230],
  enabled: true,
  offscreen: false,
  patterns: ["Invoke"],
}

const uiaDisabled: Ctrl = {
  runtimeId: "42,1,99",
  automationId: "old",
  name: "Old",
  className: "Button",
  controlType: "button",
  rect: [0, 0, 50, 20],
  enabled: false,
  offscreen: false,
  patterns: ["Invoke"],
}

describe("discover.iou", () => {
  test("returns 0 for disjoint rects", () => {
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0)
  })

  test("returns 1 for identical rects", () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1)
  })

  test("returns partial overlap", () => {
    const v = iou([0, 0, 10, 10], [5, 5, 15, 15])
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(1)
  })
})

describe("discover.merge", () => {
  test("prefers UIA when visual overlaps it", () => {
    const list = merge([uiaBtn], [{ rect: [100, 200, 180, 230], label: "Save" }])
    expect(list.length).toBe(1)
    expect(list[0].source).toBe("uia")
    expect(list[0].runtimeId).toBe("42,1,17")
  })

  test("keeps visual-only candidates with no UIA overlap", () => {
    const list = merge([uiaBtn], [{ rect: [500, 500, 600, 540], label: "Canvas" }])
    expect(list.length).toBe(2)
    const visual = list.find((c) => c.source === "visual")
    expect(visual?.label).toBe("Canvas")
  })

  test("filters disabled and offscreen UIA controls", () => {
    const list = merge([uiaBtn, uiaDisabled], [])
    expect(list.length).toBe(1)
    expect(list[0].runtimeId).toBe("42,1,17")
  })
})

describe("discover.parseVisual", () => {
  test("reads bbox_2d + label", () => {
    const hits = parseVisual('[{"bbox_2d":[10,20,30,40],"label":"Send"}]')
    expect(hits.length).toBe(1)
    expect(hits[0].rect).toEqual([10, 20, 30, 40])
    expect(hits[0].label).toBe("Send")
  })

  test("drops malformed entries", () => {
    const hits = parseVisual('[{"bbox_2d":[10,20]},{"bbox_2d":[0,0,10,10],"label":""}]')
    expect(hits.length).toBe(1)
    expect(hits[0].label).toBe("element")
  })
})

describe("discover.pick", () => {
  test("matches instruction to label", () => {
    const candidates = merge([uiaBtn], [])
    const hit = pick(candidates, "Click the Save button")
    expect(hit?.runtimeId).toBe("42,1,17")
  })

  test("returns undefined when nothing scores", () => {
    const candidates = merge([uiaBtn], [])
    const hit = pick(candidates, "mars rover")
    expect(hit).toBeUndefined()
  })
})
