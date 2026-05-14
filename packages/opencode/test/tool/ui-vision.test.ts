import { describe, expect, test } from "bun:test"
import { hidden } from "../../src/tool/ui_vision"

describe("ui_vision.hidden", () => {
  test("keeps the fallback visible for non-vision models", () => {
    expect(
      hidden({
        capabilities: {
          input: { image: false },
        },
      }),
    ).toBe(false)
  })

  test("hides the fallback for vision models", () => {
    expect(
      hidden({
        capabilities: {
          input: { image: true },
        },
      }),
    ).toBe(true)
  })
})
