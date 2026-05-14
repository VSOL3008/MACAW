import { describe, expect, test } from "bun:test"
import { keep, serialize } from "../../src/tool/ui_tree"
import type { Node } from "../../src/tool/uia"

function ctrl(overrides: Partial<Node["ctrl"]> = {}): Node["ctrl"] {
  return {
    runtimeId: "1,2",
    automationId: "",
    name: "",
    className: "",
    controlType: "button",
    rect: [0, 0, 10, 10],
    enabled: true,
    offscreen: false,
    patterns: ["Invoke"],
    ...overrides,
  }
}

const sample: Node[] = [
  { depth: 0, ctrl: ctrl({ runtimeId: "1", controlType: "window", name: "Notepad" }) },
  {
    depth: 1,
    ctrl: ctrl({ runtimeId: "2", controlType: "menu item", name: "File", patterns: ["ExpandCollapse"] }),
  },
  {
    depth: 1,
    ctrl: ctrl({
      runtimeId: "3",
      controlType: "edit",
      name: "Text editor",
      automationId: "15",
      patterns: ["Value"],
    }),
  },
  {
    depth: 1,
    ctrl: ctrl({ runtimeId: "4", controlType: "text", name: "", automationId: "", patterns: [] }),
  },
  {
    depth: 1,
    ctrl: ctrl({ runtimeId: "5", controlType: "button", name: "Save", patterns: ["Invoke"] }),
  },
]

describe("ui_tree.keep", () => {
  test("drops decorative unnamed nodes by default", () => {
    expect(keep(sample[3], { decorative: false })).toBe(false)
  })

  test("keeps interactive controls by default", () => {
    expect(keep(sample[2], { decorative: false })).toBe(true)
    expect(keep(sample[4], { decorative: false })).toBe(true)
  })

  test("keeps decorative nodes when requested", () => {
    expect(keep(sample[3], { decorative: true })).toBe(true)
  })

  test("drops disabled controls regardless", () => {
    const disabled: Node = { depth: 0, ctrl: ctrl({ enabled: false, name: "Old" }) }
    expect(keep(disabled, { decorative: true })).toBe(false)
  })
})

describe("ui_tree.serialize", () => {
  test("produces numbered indented lines with pattern tags", () => {
    const r = serialize(sample)
    expect(r.lines.length).toBe(4)
    expect(r.text).toContain("#1 d0 window")
    expect(r.text).toContain("Notepad")
    expect(r.text).toContain("[expand]")
    expect(r.text).toContain("[value]")
    expect(r.text).toContain("aid=15")
    expect(r.text).toContain("rid=5")
    expect(r.text).toContain("\n  #3")
  })

  test("builds a 1-based index map", () => {
    const r = serialize(sample)
    expect(r.index.get(1)?.runtimeId).toBe("1")
    expect(r.index.get(2)?.runtimeId).toBe("2")
    expect(r.index.get(3)?.runtimeId).toBe("3")
    expect(r.index.get(4)?.runtimeId).toBe("5")
    expect(r.index.has(5)).toBe(false)
  })

  test("includes decorative nodes when enabled", () => {
    const r = serialize(sample, { decorative: true })
    expect(r.lines.length).toBe(5)
    expect(r.index.get(4)?.runtimeId).toBe("4")
  })
})
