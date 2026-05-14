import { describe, expect, test } from "bun:test"
import { parse, parseCheck, parseDecompose, parseStep } from "../../src/tool/ui_navigate"

describe("ui_navigate.parseDecompose", () => {
  test("reads a subgoal list", () => {
    const d = parseDecompose({
      text: '{"subgoals":[{"text":"Open menu","cue":"menu visible"},{"text":"Click Settings","cue":"Settings page"}]}',
    })
    expect(d.subgoals.length).toBe(2)
    expect(d.subgoals[0].text).toBe("Open menu")
    expect(d.subgoals[1].cue).toBe("Settings page")
  })

  test("rejects an empty list", () => {
    expect(() => parseDecompose({ text: '{"subgoals":[]}' })).toThrow()
  })
})

describe("ui_navigate.parseStep", () => {
  test("reads a click step with numeric target", () => {
    const s = parseStep({
      text: '{"done":false,"action":"click","target":3,"reason":"Open Settings"}',
    })
    expect(s).toEqual({ done: false, action: "click", target: 3, reason: "Open Settings" })
  })

  test("rejects click without numeric target", () => {
    expect(() => parseStep({ text: '{"done":false,"action":"click","reason":"..."}' })).toThrow("target")
  })

  test("rejects type without text", () => {
    expect(() =>
      parseStep({ text: '{"done":false,"action":"type","target":2,"reason":"enter"}' }),
    ).toThrow("text")
  })

  test("accepts done", () => {
    const s = parseStep({ text: '{"done":true,"reason":"already there"}' })
    expect(s.done).toBe(true)
  })
})

describe("ui_navigate.parseCheck", () => {
  test("reads satisfaction state", () => {
    const s = parseCheck({ text: '{"satisfied":true,"state":"Settings page is open."}' })
    expect(s.satisfied).toBe(true)
    expect(s.state).toBe("Settings page is open.")
  })
})

describe("ui_navigate.parse (legacy)", () => {
  test("still parses the old free-text step shape", () => {
    const s = parse({
      text: '{"done":false,"action":"click","target":"Settings button","reason":"Open settings first."}',
    })
    expect(s).toEqual({
      done: false,
      action: "click",
      target: "Settings button",
      reason: "Open settings first.",
    })
  })
})
