import { describe, expect, test } from "bun:test"
import path from "path"
import { attachment, MIME, parameters, resolve, script } from "../../src/tool/presentation"
import { tmpdir } from "../fixture/fixture"

describe("presentation.parameters", () => {
  test("accepts a PowerPoint path and optional title", () => {
    expect(parameters.parse({ path: "deck.pptx", title: "Quarterly review" })).toEqual({
      path: "deck.pptx",
      title: "Quarterly review",
    })
  })
})

describe("presentation.resolve", () => {
  test("resolves relative paths", async () => {
    await using tmp = await tmpdir()
    expect(resolve("reports/deck.pptx", tmp.path)).toBe(path.resolve(tmp.path, "reports/deck.pptx"))
  })

  test("rejects non-PowerPoint files", async () => {
    await using tmp = await tmpdir()
    expect(() => resolve("report.pdf", tmp.path)).toThrow(".pptx")
  })
})

describe("presentation.script", () => {
  test("renders each slide and emits progress", () => {
    const out = script("C:\\reports\\deck.pptx", "C:\\Temp\\preview")
    expect(out).toContain("$slide.Export")
    expect(out).toContain("MACAW_PROGRESS:")
    expect(out).toContain("slide_count = $count")
  })
})

describe("presentation.attachment", () => {
  test("packages the editable deck and ordered previews", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "deck.pptx"), "deck")
        await Bun.write(path.join(dir, "Slide10.PNG"), "ten")
        await Bun.write(path.join(dir, "Slide2.PNG"), "two")
      },
    })
    const files = await attachment(path.join(tmp.path, "deck.pptx"), tmp.path)
    expect(files.map((file) => file.mime)).toEqual([MIME, "image/png", "image/png"])
    expect(files.slice(1).map((file) => file.filename)).toEqual(["slide-1.png", "slide-2.png"])
    expect(Buffer.from(files[1]!.url.split(",")[1]!, "base64").toString()).toBe("two")
  })
})
