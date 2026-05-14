import { describe, expect, test } from "bun:test"
import { parameters, PowerShellTool } from "../../src/tool/powershell"

describe("PowerShellTool", () => {
  test("exposes a script parameter", () => {
    const parsed = parameters.parse({ script: "$a = 1; $a" })
    expect(parsed.script).toBe("$a = 1; $a")
  })

  test("rejects empty scripts", () => {
    expect(() => parameters.parse({ script: "" })).toThrow()
  })

  test("caps timeout_ms to 5 minutes", () => {
    expect(() => parameters.parse({ script: "x", timeout_ms: 400_000 })).toThrow()
    expect(parameters.parse({ script: "x", timeout_ms: 120_000 }).timeout_ms).toBe(120_000)
  })

  test("identifies as powershell in the registry", () => {
    expect(PowerShellTool.id).toBe("powershell")
  })
})
