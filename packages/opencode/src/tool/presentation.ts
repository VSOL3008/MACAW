import path from "path"
import os from "os"
import { mkdir, rm } from "fs/promises"
import z from "zod"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { assertExternalDirectory } from "./external-directory"
import { Tool } from "./tool"
import { ensureWindows, runFile } from "./win"

export const MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
export const MAX_ATTACHMENT = 15 * 1024 * 1024
export const PREVIEWS = 8
export const PREVIEW = 2 * 1024 * 1024

export const parameters = z.object({
  path: z.string().min(1).describe("Path to the saved .pptx presentation to preview."),
  title: z.string().min(1).optional().describe("Optional display title for the presentation explorer."),
})

export type PresentationInput = z.infer<typeof parameters>

type Result = {
  slide_count: number
  titles: string[] | string
}

export function resolve(value: string, dir = Instance.directory) {
  const out = path.resolve(path.isAbsolute(value) ? value : path.join(dir, value))
  if (path.extname(out).toLowerCase() !== ".pptx") throw new Error("presentation_preview path must be a .pptx file.")
  return out
}

function b64(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64")
}

export function script(file: string, dir: string) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$cfg = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64({ file, dir })}')) | ConvertFrom-Json
$app = $null
$pres = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $app.DisplayAlerts = 1
  $pres = $app.Presentations.Open([string]$cfg.file, $true, $false, $false)
  if (Test-Path -LiteralPath ([string]$cfg.dir)) { Remove-Item -LiteralPath ([string]$cfg.dir) -Recurse -Force }
  New-Item -ItemType Directory -Force -Path ([string]$cfg.dir) | Out-Null
  $titles = [System.Collections.Generic.List[string]]::new()
  $count = [int]$pres.Slides.Count
  for ($i = 1; $i -le $count; $i++) {
    $slide = $pres.Slides.Item($i)
    $title = ''
    foreach ($shape in @($slide.Shapes)) {
      if ($shape.HasTextFrame -ne -1 -or $shape.TextFrame.HasText -ne -1) { continue }
      $text = ([string]$shape.TextFrame.TextRange.Text).Trim()
      if ([string]::IsNullOrWhiteSpace($text)) { continue }
      $title = ($text -split '[\r\n]+')[0].Trim()
      break
    }
    if ([string]::IsNullOrWhiteSpace($title)) { $title = 'Slide ' + $i }
    [void]$titles.Add($title)
    $slide.Export((Join-Path ([string]$cfg.dir) ('Slide' + $i + '.PNG')), 'PNG', 1600, 900)
    Write-Output ('MACAW_PROGRESS:' + $i + ':' + $count)
  }
  [pscustomobject]@{
    slide_count = $count
    titles = @($titles.ToArray())
  } | ConvertTo-Json -Depth 4 -Compress
} finally {
  if ($pres) { $pres.Close() | Out-Null }
  if ($app) { $app.Quit() | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`.trim()
}

export async function attachment(file: string, dir: string) {
  const size = await Filesystem.size(file)
  const deck =
    size > MAX_ATTACHMENT
      ? []
      : [
          {
            type: "file" as const,
            mime: MIME,
            filename: path.basename(file),
            url: `data:${MIME};base64,${Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64")}`,
          },
        ]
  const names = (await Array.fromAsync(new Bun.Glob("*.PNG").scan({ cwd: dir })))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, PREVIEWS)
  const previews = await Promise.all(
    names.map(async (name, i) => {
      const image = Bun.file(path.join(dir, name))
      if (image.size > PREVIEW) return
      return {
        type: "file" as const,
        mime: "image/png",
        filename: `slide-${i + 1}.png`,
        url: `data:image/png;base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`,
      }
    }),
  )
  return [...deck, ...previews.filter((item) => item !== undefined)]
}

export const PresentationPreviewTool = Tool.define("presentation_preview", {
  description:
    "Render the in-chat presentation explorer for any saved PowerPoint deck. Always call this after creating or modifying a .pptx unless the generator already returned presentation preview metadata (tef1_report does). Requires Windows with desktop PowerPoint installed.",
  parameters,
  async execute(input, ctx) {
    ensureWindows()
    const data = parameters.parse(input)
    const file = resolve(data.path)
    await assertExternalDirectory(ctx, file)
    if (!(await Bun.file(file).exists())) throw new Error(`Presentation not found: ${file}`)
    await ctx.ask({
      permission: "presentation_preview",
      patterns: [file],
      always: [file],
      metadata: { path: file },
    })

    const title = data.title ?? path.basename(file, path.extname(file))
    const update = (progress: number, action: string, count?: number) =>
      ctx.metadata({
        title: action,
        metadata: {
          kind: "presentation",
          title,
          stage: "render",
          progress,
          action,
          ...(count ? { slide_count: count } : {}),
        },
      })
    update(5, "Opening presentation")

    const dir = path.join(os.tmpdir(), `macaw-presentation-${crypto.randomUUID()}`)
    await mkdir(dir, { recursive: true })
    try {
      let seen = 0
      let trace = ""
      const raw = await runFile(script(file, dir), ctx.abort, (chunk) => {
        trace = `${trace}${chunk}`.slice(-2048)
        const hits = [...trace.matchAll(/MACAW_PROGRESS:(\d+):(\d+)/g)]
        const hit = hits.at(-1)
        if (!hit) return
        const slide = Number(hit[1])
        const count = Number(hit[2])
        if (slide <= seen) return
        seen = slide
        update(10 + Math.round((slide / count) * 80), `Rendering slide ${slide} of ${count}`, count)
      })
      const line = raw.split(/\r?\n/).findLast((item) => item.trimStart().startsWith("{")) ?? raw
      const result = JSON.parse(line) as Result
      const titles = Array.isArray(result.titles) ? result.titles : result.titles ? [result.titles] : []
      const plan = Array.from({ length: result.slide_count }, (_, i) => ({
        title: titles[i] ?? `Slide ${i + 1}`,
        kind: "slide",
      }))
      update(94, "Packaging presentation preview", result.slide_count)
      const files = await attachment(file, dir)
      return {
        title: path.basename(file),
        output: `Prepared presentation preview: ${file}\nSlides: ${result.slide_count}`,
        metadata: {
          kind: "presentation",
          title,
          stage: "ready",
          progress: 100,
          action: "Presentation ready",
          output_path: file,
          slide_count: result.slide_count,
          plan,
          attached: files.some((item) => item.mime === MIME),
          previews: files.filter((item) => item.mime === "image/png").length,
        },
        ...(files.length ? { attachments: files } : {}),
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
})
