import { describe, expect, test } from "bun:test"
import { parseCtrls, parseState, sid } from "../../src/tool/uia"

const sample = JSON.stringify([
  {
    runtimeId: "42,1,17",
    automationId: "save",
    name: "Save",
    className: "Button",
    controlType: "button",
    rect: [100, 200, 180, 230],
    enabled: true,
    offscreen: false,
    patterns: ["Invoke"],
  },
  {
    runtimeId: "42,1,18",
    automationId: "",
    name: "Title",
    className: "Edit",
    controlType: "edit",
    rect: [100, 100, 400, 130],
    enabled: true,
    offscreen: false,
    patterns: ["Value"],
  },
  {
    runtimeId: "42,1,19",
    name: "broken",
    rect: [0, 0, 10, 10],
    enabled: true,
    offscreen: true,
    patterns: [],
  },
])

describe("uia.parseCtrls", () => {
  test("reads a JSON array of controls", () => {
    const list = parseCtrls(sample)
    expect(list.length).toBe(3)
    expect(list[0].runtimeId).toBe("42,1,17")
    expect(list[0].patterns).toContain("Invoke")
    expect(list[1].patterns).toContain("Value")
  })

  test("unwraps a single object response", () => {
    const one = JSON.stringify({
      runtimeId: "1,2",
      name: "Only",
      rect: [0, 0, 1, 1],
      enabled: true,
      offscreen: false,
      patterns: [],
    })
    const list = parseCtrls(one)
    expect(list.length).toBe(1)
    expect(list[0].runtimeId).toBe("1,2")
  })

  test("returns empty list for empty text", () => {
    expect(parseCtrls("")).toEqual([])
    expect(parseCtrls("[]")).toEqual([])
  })
})

describe("uia.sid", () => {
  test("is stable across whitespace and casing in the name", () => {
    const a = sid({
      rect: [100, 200, 180, 230],
      className: "Button",
      name: "Save",
      automationId: "save",
      controlType: "button",
    })
    const b = sid({
      rect: [100, 200, 180, 230],
      className: "Button",
      name: "  save  ",
      automationId: "save",
      controlType: "button",
    })
    expect(a).toBe(b)
  })

  test("changes when rect changes", () => {
    const a = sid({
      rect: [100, 200, 180, 230],
      className: "Button",
      name: "Save",
      automationId: "save",
      controlType: "button",
    })
    const b = sid({
      rect: [101, 200, 180, 230],
      className: "Button",
      name: "Save",
      automationId: "save",
      controlType: "button",
    })
    expect(a).not.toBe(b)
  })
})

describe("uia.parseState", () => {
  test("reads toggle + value + selected", () => {
    const text = JSON.stringify({
      runtimeId: "42,1,17",
      enabled: true,
      offscreen: false,
      rect: [0, 0, 10, 10],
      toggle: "On",
      value: "hello",
      selected: true,
    })
    const state = parseState(text)
    expect(state.toggle).toBe("On")
    expect(state.value).toBe("hello")
    expect(state.selected).toBe(true)
  })
})
