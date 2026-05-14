import { describe, expect, test } from "bun:test"
import { annotateScript, buildIndex, describe as describeIndex } from "../../src/tool/som"
import type { Candidate } from "../../src/tool/discover"

const btn: Candidate = {
  sid: "a",
  source: "uia",
  rect: [10, 20, 110, 60],
  label: "Save",
  controlType: "button",
  enabled: true,
  invokable: true,
  patterns: ["Invoke"],
  runtimeId: "42,1,17",
  automationId: "save",
  className: "Button",
}

const canvas: Candidate = {
  sid: "b",
  source: "visual",
  rect: [200, 200, 300, 250],
  label: "Canvas",
  controlType: "visual",
  enabled: true,
  invokable: true,
  patterns: [],
}

describe("som.buildIndex", () => {
  test("assigns 1-based numeric keys", () => {
    const idx = buildIndex([btn, canvas])
    expect(idx.get(1)).toBe(btn)
    expect(idx.get(2)).toBe(canvas)
    expect(idx.size).toBe(2)
  })
})

describe("som.describe", () => {
  test("formats candidates for the plan prompt", () => {
    const idx = buildIndex([btn, canvas])
    const text = describeIndex(idx)
    expect(text).toContain("[1]")
    expect(text).toContain("Save")
    expect(text).toContain("(button)")
    expect(text).toContain("uia")
    expect(text).toContain("[2]")
    expect(text).toContain("Canvas")
    expect(text).toContain("visual")
  })
})

describe("som.annotateScript", () => {
  test("emits a rectangle + label per candidate", () => {
    const text = annotateScript("C:\\tmp\\a.png", [
      { n: 1, rect: [10, 20, 110, 60] },
      { n: 2, rect: [200, 200, 300, 250] },
    ])
    expect(text).toContain("DrawRectangle($pen, 10, 20, 100, 40)")
    expect(text).toContain("DrawRectangle($pen, 200, 200, 100, 50)")
    expect(text).toContain("$tx = '1'")
    expect(text).toContain("$tx = '2'")
    expect(text).toContain("[System.Drawing.Image]::FromFile($src)")
  })
})
