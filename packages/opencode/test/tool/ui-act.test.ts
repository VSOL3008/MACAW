import { describe, expect, test } from "bun:test"
import { resolve, score } from "../../src/tool/ui_act"
import type { Ctrl } from "../../src/tool/uia"

function ctrl(overrides: Partial<Ctrl> = {}): Ctrl {
  return {
    runtimeId: "1,1",
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

const pool: Ctrl[] = [
  ctrl({ runtimeId: "1", name: "Save", automationId: "save", controlType: "button" }),
  ctrl({ runtimeId: "2", name: "Save as", automationId: "saveAs", controlType: "button" }),
  ctrl({ runtimeId: "3", name: "Cancel", automationId: "cancel", controlType: "button" }),
  ctrl({ runtimeId: "4", name: "Title", automationId: "titleField", controlType: "edit", patterns: ["Value"] }),
]

describe("ui_act.score", () => {
  test("exact name match beats partial match", () => {
    expect(score(pool[0], { name: "Save" })).toBeGreaterThan(score(pool[1], { name: "Save" }))
  })

  test("mismatched automation_id returns 0", () => {
    expect(score(pool[0], { automation_id: "not-there" })).toBe(0)
  })

  test("control_type contributes to score", () => {
    expect(score(pool[3], { automation_id: "titleField", control_type: "edit" })).toBeGreaterThan(
      score(pool[3], { automation_id: "titleField" }),
    )
  })
})

describe("ui_act.resolve", () => {
  test("exact name beats partial", () => {
    const hit = resolve(pool, { name: "Save" })
    expect(hit?.runtimeId).toBe("1")
  })

  test("finds by automation_id", () => {
    const hit = resolve(pool, { automation_id: "titleField" })
    expect(hit?.runtimeId).toBe("4")
  })

  test("returns undefined when nothing matches", () => {
    const hit = resolve(pool, { name: "nonexistent" })
    expect(hit).toBeUndefined()
  })

  test("partial name still picks the best candidate", () => {
    const hit = resolve(pool, { name: "Save as" })
    expect(hit?.runtimeId).toBe("2")
  })
})
