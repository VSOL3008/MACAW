import { describe, expect, test } from "bun:test"
import { classify, diffScript, expand } from "../../src/tool/verify"

describe("verify.expand", () => {
  test("pads the rect symmetrically", () => {
    expect(expand([10, 20, 30, 40], 5)).toEqual([5, 15, 35, 45])
  })
})

describe("verify.classify", () => {
  test("flags no change when both diffs are under the dead threshold", () => {
    const d = classify({ local: 0.001, global: 0.001 }, { source: "uia", risk: "low" })
    expect(d.decision).toBe("fail")
  })

  test("passes clear low-risk region changes without escalation", () => {
    const d = classify({ local: 0.12, global: 0.02 }, { source: "uia", risk: "low" })
    expect(d.decision).toBe("success")
  })

  test("escalates to uia re-query when diff is ambiguous and source is uia", () => {
    const d = classify({ local: 0.04, global: 0.02 }, { source: "uia", risk: "low" })
    expect(d.decision).toBe("escalate_uia")
  })

  test("escalates to visual when source is visual and diff is ambiguous", () => {
    const d = classify({ local: 0.04, global: 0.02 }, { source: "visual", risk: "low" })
    expect(d.decision).toBe("escalate_visual")
  })

  test("escalates high-risk actions even with a clear diff", () => {
    const d = classify({ local: 0.25, global: 0.02 }, { source: "uia", risk: "high" })
    expect(d.decision).toBe("escalate_uia")
  })
})

describe("verify.diffScript", () => {
  test("embeds region coordinates", () => {
    const text = diffScript("C:\\tmp\\a.png", "C:\\tmp\\b.png", [10, 20, 100, 60])
    expect(text).toContain("[MacawDiff]::Compute")
    expect(text).toContain("10, 20, 100, 60")
    expect(text).toContain("PixelFormat.Format32bppArgb")
  })
})
