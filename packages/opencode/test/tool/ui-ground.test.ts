import { describe, expect, test } from "bun:test"
import { script } from "../../src/tool/mouse"
import { parse, verify } from "../../src/tool/ui_ground"

describe("ui_ground.parse", () => {
  test("uses bbox center when bbox_2d is returned", () => {
    const hit = parse({
      text: '{"bbox_2d":[10,20,30,44],"label":"send button"}',
      w: 400,
      h: 300,
    })

    expect(hit).toEqual({
      bbox: [10, 20, 30, 44],
      point: [20, 32],
      label: "send button",
    })
  })

  test("scales normalized coordinates", () => {
    const hit = parse({
      text: '{"coordinate":[0.25,0.5],"label":"field"}',
      w: 320,
      h: 200,
    })

    expect(hit).toEqual({
      point: [80, 100],
      label: "field",
    })
  })
})

describe("ui_ground.verify", () => {
  test("reads click verification state", () => {
    const result = verify({
      text: '{"success":true,"state":"The dialog is now open."}',
    })

    expect(result).toEqual({
      success: true,
      state: "The dialog is now open.",
    })
  })
})

describe("mouse.script", () => {
  test("restores the cursor for silent clicks", () => {
    const text = script({
      action: "click",
      x: 120,
      y: 44,
      silent: true,
    })

    expect(text).toContain("[MacawWin]::GetCursorPos([ref]$pt)")
    expect(text).toContain("SetCursorPos(120, 44)")
    expect(text).toContain("SetCursorPos($pt.X, $pt.Y)")
  })

  test("does not wrap normal clicks with cursor restore", () => {
    const text = script({
      action: "click",
      x: 120,
      y: 44,
    })

    expect(text).not.toContain("[MacawWin]::GetCursorPos([ref]$pt)")
    expect(text).not.toContain("SetCursorPos($pt.X, $pt.Y)")
  })
})
