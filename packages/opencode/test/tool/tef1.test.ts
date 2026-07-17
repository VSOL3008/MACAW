import { describe, expect, test } from "bun:test"
import path from "path"
import {
  build,
  deck,
  PAGE,
  pages,
  parameters,
  prepare,
  renderer,
  slides,
  storyboard,
  Tef1ReportTool,
  output,
} from "../../src/tool/tef1"
import { runFile } from "../../src/tool/win"
import { tmpdir } from "../fixture/fixture"

const ppt = process.platform === "win32" && process.env.MACAW_TEST_POWERPOINT === "1"
const livetest = ppt ? test : test.skip
const pdfok =
  ppt &&
  !!renderer({
    pdftoppm: Bun.which("pdftoppm"),
    gswin64c: Bun.which("gswin64c"),
    gswin32c: Bun.which("gswin32c"),
    gs: Bun.which("gs"),
  })
const pdftest = pdfok ? test : test.skip

function sample(safe = false) {
  return parameters.parse({
    output_path: "report.pptx",
    report: {
      theme: "Torque audit",
      requester: "TEF14",
      date: "2026-07-10",
      target: "Confirm station release",
      safe_launch: safe,
    },
  })
}

function refs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    label: `Evidence ${i + 1}`,
    source: "tef14",
    path: `folder/file-${i + 1}.xlsx`,
  }))
}

function cfg(script: string) {
  const match = script.match(/FromBase64String\('([^']+)'\)/)
  expect(match).toBeTruthy()
  return JSON.parse(Buffer.from(match![1], "base64").toString("utf8"))
}

describe("tef1.parameters", () => {
  test("accepts required critical fields", () => {
    expect(parameters.parse(sample()).report.theme).toBe("Torque audit")
    expect(parameters.parse(sample()).mode).toBe("full")
    expect(parameters.parse(sample()).appendix_policy).toBe("auto")
  })

  test("requires critical report fields", () => {
    expect(() =>
      parameters.parse({
        output_path: "report.pptx",
        report: {
          theme: "Torque audit",
          requester: "TEF14",
          date: "2026-07-10",
          safe_launch: false,
        },
      }),
    ).toThrow()
  })

  test("caps evidence references", () => {
    expect(() =>
      parameters.parse({
        ...sample(),
        evidence: refs(101),
      }),
    ).toThrow()
  })

  test("accepts sections and visuals", () => {
    const out = parameters.parse({
      ...sample(),
      sections: [{ title: "Release matrix", bullets: ["ST10 released"] }],
      visuals: [{ title: "Evidence image", caption: "Checked result", image_path: "result.png", source: "TEF drive" }],
    })
    expect(out.sections[0]?.title).toBe("Release matrix")
    expect(out.visuals[0]?.image_path).toBe("result.png")
    expect(out.visuals[0]?.layout).toBe("large")
  })

  test("accepts PPTX slide visual extraction", () => {
    const out = parameters.parse({
      ...sample(),
      visuals: [{ title: "Deck image", caption: "Picture from source slide", pptx_path: "evidence.pptx", slide: 2, source: "TEF deck" }],
    })
    expect(out.visuals[0]?.pptx_path).toBe("evidence.pptx")
    expect(out.visuals[0]?.pick).toBe("largest")
  })

  test("rejects invalid visual inputs", () => {
    expect(() =>
      parameters.parse({
        ...sample(),
        visuals: [{ title: "Missing source", caption: "No file", source: "TEF drive" }],
      }),
    ).toThrow("visual requires")
    expect(() =>
      parameters.parse({
        ...sample(),
        visuals: [{ title: "PDF", caption: "No page", pdf_path: "deck.pdf", source: "TEF drive" }],
      }),
    ).toThrow("requires page")
    expect(() =>
      parameters.parse({
        ...sample(),
        visuals: [
          { title: "Both", caption: "Ambiguous", image_path: "image.png", pdf_path: "deck.pdf", page: 1, source: "TEF" },
        ],
      }),
    ).toThrow("only one")
    expect(() =>
      parameters.parse({
        ...sample(),
        visuals: [{ title: "PPTX", caption: "No slide", pptx_path: "deck.pptx", source: "TEF drive" }],
      }),
    ).toThrow("requires slide")
  })
})

describe("tef1.output", () => {
  test("appends pptx for extensionless paths", async () => {
    await using tmp = await tmpdir()
    expect(output({ output_path: "reports/tef1" }, tmp.path)).toBe(path.resolve(tmp.path, "reports/tef1.pptx"))
  })

  test("rejects non-pptx output", async () => {
    await using tmp = await tmpdir()
    expect(() => output({ output_path: "report.pdf" }, tmp.path)).toThrow(".pptx")
  })

  test("rejects existing files unless overwrite is explicit", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "report.pptx"), "x")
      },
    })
    expect(() => output({ output_path: "report.pptx" }, tmp.path)).toThrow("already exists")
    expect(output({ output_path: "report.pptx", overwrite: true }, tmp.path)).toBe(
      path.resolve(tmp.path, "report.pptx"),
    )
  })
})

describe("tef1.slide planning", () => {
  test("deletes Safe Launch slides when not needed", () => {
    expect(slides(sample(false))).toBe(1)
  })

  test("keeps Safe Launch slides when requested", () => {
    expect(slides(sample(true))).toBe(3)
  })

  test("adds reference pages only for evidence", () => {
    expect(slides({ ...sample(false), evidence: refs(1) })).toBe(2)
    expect(slides({ ...sample(true), evidence: refs(PAGE + 1) })).toBe(5)
  })

  test("places references after sections and visuals in full mode", () => {
    const out = parameters.parse({
      ...sample(false),
      sections: [{ title: "Release matrix", bullets: ["All checks closed"] }],
      visuals: [{ title: "Evidence image", caption: "Result screenshot", image_path: "result.png", source: "TEF" }],
      evidence: refs(1),
    })
    expect(slides(out)).toBe(4)
    expect(deck(out).map((item) => item.kind)).toEqual(["section", "visual", "reference"])
  })

  test("keeps form mode minimal", () => {
    const out = parameters.parse({
      ...sample(false),
      mode: "form",
      sections: [{ title: "Ignored", bullets: ["Only form output requested"] }],
      visuals: [{ title: "Ignored visual", caption: "Only form output requested", image_path: "result.png", source: "TEF" }],
      evidence: refs(1),
    })
    expect(slides(out)).toBe(2)
    expect(deck(out).map((item) => item.kind)).toEqual(["reference"])
  })

  test("honors appendix policy", () => {
    expect(slides(parameters.parse({ ...sample(false), appendix_policy: "never", evidence: refs(1) }))).toBe(1)
    expect(slides(parameters.parse({ ...sample(false), appendix_policy: "always" }))).toBe(2)
    expect(
      slides(
        parameters.parse({
          ...sample(false),
          appendix_policy: "auto",
          sections: [{ title: "Release matrix", bullets: ["All checks closed"] }],
          evidence: refs(1),
        }),
      ),
    ).toBe(3)
  })

  test("paginates evidence references", () => {
    const out = pages(refs(PAGE + 1))
    expect(out.length).toBe(2)
    expect(out[0].items.length).toBe(PAGE)
    expect(out[1].items.length).toBe(1)
  })

  test("builds a live storyboard in final slide order", () => {
    const input = parameters.parse({
      ...sample(true),
      sections: [{ title: "Release matrix", bullets: ["ST10 released"] }],
      visuals: [{ title: "Evidence image", caption: "Checked result", image_path: "result.png", source: "TEF" }],
      evidence: refs(1),
    })
    expect(storyboard(input).map((item) => item.title)).toEqual([
      "Torque audit",
      "Safe Launch overview",
      "Safe Launch results",
      "Release matrix",
      "Evidence image",
      "Evidence references",
    ])
  })
})

describe("tef1.visual renderer", () => {
  test("prefers pdftoppm", () => {
    expect(renderer({ pdftoppm: "pdftoppm.exe", gswin64c: "gswin64c.exe" })).toEqual({
      kind: "pdftoppm",
      path: "pdftoppm.exe",
    })
  })

  test("falls back to Ghostscript", () => {
    expect(renderer({ gswin64c: "gswin64c.exe" })).toEqual({
      kind: "ghostscript",
      path: "gswin64c.exe",
    })
  })

  test("returns undefined when no PDF renderer exists", () => {
    expect(renderer({})).toBeUndefined()
  })
})

describe("tef1.build", () => {
  test("base64-encodes report data and paths", () => {
    const doc = parameters.parse({
      ...sample(true),
      output_path: "ignored.pptx",
      report: {
        ...sample(true).report,
        theme: "O'Hara $env:USERPROFILE",
      },
      evidence: [{ label: "Workbook $x", source: "tef14" }],
    })
    const script = build(doc, {
      output: "C:\\tmp\\out.pptx",
      template: "C:\\tmp\\template.pptx",
      render: "C:\\tmp\\render",
    })
    expect(script).toContain("FromBase64String")
    expect(script).not.toContain("O'Hara $env:USERPROFILE")
    expect(script).not.toContain("Workbook $x")
    expect(cfg(script).report.theme).toBe("O'Hara $env:USERPROFILE")
  })

  test("embeds expected slide count in validation", () => {
    expect(build({ ...sample(false), evidence: refs(2) })).toContain("$expected = 2")
    expect(
      build(
        parameters.parse({
          ...sample(false),
          sections: [{ title: "Release matrix", bullets: ["All checks closed"] }],
          evidence: refs(2),
        }),
      ),
    ).toContain("$expected = 3")
    expect(build({ ...sample(true), evidence: refs(2) })).toContain("$expected = 4")
  })

  test("emits opt-in progress events for the live presentation card", () => {
    const script = build(sample(), { progress: true })
    expect(script).toContain("MACAW_PROGRESS:open")
    expect(script).toContain("MACAW_PROGRESS:compose")
    expect(script).toContain("MACAW_PROGRESS:export")
    expect(script).toContain("MACAW_PROGRESS:validate")
    expect(build(sample())).not.toContain("MACAW_PROGRESS:")
  })
})

describe("tef1 command template", () => {
  test("tells the agent to prepare before calling and stop after success", async () => {
    const text = await Bun.file(path.join(import.meta.dir, "../../src/command/template/tef1-report.txt")).text()
    expect(text).toContain("Build the complete report plan before calling `tef1_report`")
    expect(text).toContain("Do not call it early just to start a deck")
    expect(text).toContain("Use `pptx_path` plus `slide`")
    expect(text).toContain("After `tef1_report` succeeds, stop tool use")
  })
})

describe("Tef1ReportTool", () => {
  test("registers as tef1_report", () => {
    expect(Tef1ReportTool.id).toBe("tef1_report")
  })

  livetest(
    "generates from the real template and exports PNGs",
    async () => {
      await using tmp = await tmpdir()
      const out = path.join(tmp.path, "report.pptx")
      const dir = path.join(tmp.path, "render")
      const raw = await runFile(
        build(
          parameters.parse({
            ...sample(true),
            output_path: out,
            report: {
              ...sample(true).report,
              process: "Screwing",
              line: "L1",
              station: "ST10",
              product_type: "Rotor",
              production_date: "2026-07-10",
              results: "No defects found in the checked sample.",
              summary: "Release remains approved after the checked sample.",
              stats: {
                ok: 10,
                nok: 0,
              },
            },
            evidence: refs(1),
          }),
          { output: out, render: dir },
        ),
      )
      const res = JSON.parse(raw)
      expect(await Bun.file(res.output_path).exists()).toBe(true)
      expect(res.slide_count).toBe(4)
      expect((await Array.fromAsync(new Bun.Glob("*.PNG").scan({ cwd: res.render_path }))).length).toBe(4)
      const text = await runFile(
        [
          "$ErrorActionPreference = 'Stop'",
          `$file = '${out.replaceAll("'", "''")}'`,
          "$app = New-Object -ComObject PowerPoint.Application",
          "$pres = $app.Presentations.Open($file, $true, $false, $false)",
          "$out = New-Object System.Collections.Generic.List[string]",
          "foreach ($slide in $pres.Slides) { foreach ($shape in $slide.Shapes) { if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { [void]$out.Add([string]$shape.TextFrame.TextRange.Text) } } }",
          "$pres.Close()",
          "$app.Quit()",
          "($out.ToArray() -join [Environment]::NewLine)",
        ].join("\n"),
      )
      expect(text).toContain("Release remains approved")
      expect(text).not.toContain("možné doplnit")
      expect(text).not.toContain("prázdné stránky")
    },
    { timeout: 60000 },
  )

  livetest(
    "generates a full report with sections and visual slides",
    async () => {
      await using tmp = await tmpdir()
      const out = path.join(tmp.path, "full.pptx")
      const dir = path.join(tmp.path, "render-full")
      const img = path.join(tmp.path, "result.png")
      await Bun.write(
        img,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        ),
      )
      const raw = await runFile(
        build(
          parameters.parse({
            ...sample(false),
            output_path: out,
            report: {
              ...sample(false).report,
              results: "Release checks passed.",
              summary: "Proceed with controlled release.",
            },
            sections: [{ title: "Release matrix", bullets: ["ST10 released", "ST20 pending final signature"] }],
            visuals: [{ title: "Evidence image", caption: "Curated screenshot from source file.", image_path: img, source: "TEF" }],
            evidence: refs(1),
          }),
          { output: out, render: dir },
        ),
      )
      const res = JSON.parse(raw)
      expect(res.slide_count).toBe(4)
      expect((await Array.fromAsync(new Bun.Glob("*.PNG").scan({ cwd: res.render_path }))).length).toBe(4)
      const text = await runFile(
        [
          "$ErrorActionPreference = 'Stop'",
          `$file = '${out.replaceAll("'", "''")}'`,
          "$app = New-Object -ComObject PowerPoint.Application",
          "$pres = $app.Presentations.Open($file, $true, $false, $false)",
          "$out = New-Object System.Collections.Generic.List[string]",
          "foreach ($slide in $pres.Slides) { foreach ($shape in $slide.Shapes) { if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { [void]$out.Add([string]$shape.TextFrame.TextRange.Text) } } }",
          "$pres.Close()",
          "$app.Quit()",
          "($out.ToArray() -join [Environment]::NewLine)",
        ].join("\n"),
      )
      expect(text).toContain("Release matrix")
      expect(text).toContain("Evidence image")
      expect(text).toContain("Appendix / References")
    },
    { timeout: 60000 },
  )

  pdftest(
    "generates a full report with a PDF-page visual",
    async () => {
      await using tmp = await tmpdir()
      const pdf = path.join(tmp.path, "evidence.pdf")
      const out = path.join(tmp.path, "pdf-visual.pptx")
      const dir = path.join(tmp.path, "render-pdf")
      await runFile(
        [
          "$ErrorActionPreference = 'Stop'",
          "$app = New-Object -ComObject PowerPoint.Application",
          "$pres = $app.Presentations.Add()",
          "$slide = $pres.Slides.Add(1, 12)",
          "$shape = $slide.Shapes.AddTextbox(1, 80, 80, 560, 120)",
          "$shape.TextFrame.TextRange.Text = 'PDF evidence page'",
          `$pres.SaveAs('${pdf.replaceAll("'", "''")}', 32)`,
          "$pres.Close()",
          "$app.Quit()",
        ].join("\n"),
      )
      const ready = await prepare(
        parameters.parse({
          ...sample(false),
          output_path: out,
          report: {
            ...sample(false).report,
            results: "PDF evidence was rendered.",
            summary: "Curated PDF page included as visual evidence.",
          },
          visuals: [{ title: "PDF evidence visual", caption: "Selected page from the evidence PDF.", pdf_path: pdf, page: 1, source: "TEF PDF" }],
        }),
      )
      try {
        const raw = await runFile(build(ready.input, { output: out, render: dir }))
        const res = JSON.parse(raw)
        expect(res.slide_count).toBe(2)
        expect((await Array.fromAsync(new Bun.Glob("*.PNG").scan({ cwd: res.render_path }))).length).toBe(2)
      } finally {
        await ready.cleanup()
      }
    },
    { timeout: 60000 },
  )

  livetest(
    "generates a full report with an embedded PPTX picture visual",
    async () => {
      await using tmp = await tmpdir()
      const img = path.join(tmp.path, "source.png")
      const pptx = path.join(tmp.path, "source.pptx")
      const out = path.join(tmp.path, "pptx-visual.pptx")
      const dir = path.join(tmp.path, "render-pptx")
      await Bun.write(
        img,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        ),
      )
      await runFile(
        [
          "$ErrorActionPreference = 'Stop'",
          "$app = New-Object -ComObject PowerPoint.Application",
          "$app.DisplayAlerts = 1",
          "$pres = $app.Presentations.Add()",
          "$slide = $pres.Slides.Add(1, 12)",
          `$slide.Shapes.AddPicture('${img.replaceAll("'", "''")}', $false, $true, 100, 100, 320, 180) | Out-Null`,
          `$pres.SaveAs('${pptx.replaceAll("'", "''")}')`,
          "$pres.Close()",
          "$app.Quit()",
        ].join("\n"),
      )
      const ready = await prepare(
        parameters.parse({
          ...sample(false),
          output_path: out,
          report: {
            ...sample(false).report,
            results: "Embedded PPTX image was extracted.",
            summary: "Use real source visuals rather than full-slide screenshots.",
          },
          visuals: [{ title: "Extracted source picture", caption: "Largest embedded picture from source deck.", pptx_path: pptx, slide: 1, source: "TEF PPTX" }],
        }),
      )
      try {
        expect(await Bun.file(ready.input.visuals[0]?.image_path ?? "").exists()).toBe(true)
        const raw = await runFile(build(ready.input, { output: out, render: dir }))
        const res = JSON.parse(raw)
        expect(res.slide_count).toBe(2)
        expect((await Array.fromAsync(new Bun.Glob("*.PNG").scan({ cwd: res.render_path }))).length).toBe(2)
      } finally {
        await ready.cleanup()
      }
    },
    { timeout: 60000 },
  )
})
