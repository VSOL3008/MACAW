import { unlink } from "fs/promises"
import { base64 } from "./ui"
import type { Candidate } from "./discover"
import { prelude, run } from "./win"

export type Marked = {
  shot: string
  index: Map<number, Candidate>
}

function tmpPath(url: string) {
  const raw = Buffer.from(base64(url), "base64")
  const tmp = `${process.env.TEMP ?? process.env.TMP ?? "."}\\macaw-som-src-${crypto.randomUUID()}.png`
  return { raw, tmp }
}

export function annotateScript(src: string, boxes: { n: number; rect: readonly [number, number, number, number] }[]) {
  const lines = boxes
    .map((b) => {
      const [x1, y1, x2, y2] = b.rect
      const w = Math.max(1, x2 - x1)
      const h = Math.max(1, y2 - y1)
      return `
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 64, 64)), 2
$gfx.DrawRectangle($pen, ${x1}, ${y1}, ${w}, ${h})
$pen.Dispose()
$tx = '${b.n}'
$sz = $gfx.MeasureString($tx, $font)
$bx = ${x1}
$by = ${y1}
$bw = [int][Math]::Ceiling($sz.Width) + 6
$bh = [int][Math]::Ceiling($sz.Height) + 2
$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 0, 0, 0))
$gfx.FillRectangle($bg, $bx, $by, $bw, $bh)
$bg.Dispose()
$gfx.DrawString($tx, $font, [System.Drawing.Brushes]::White, ($bx + 3), ($by + 1))
`
    })
    .join("\n")
  return prelude(`
$src = '${src}'
$bmp = [System.Drawing.Image]::FromFile($src)
$canvas = New-Object System.Drawing.Bitmap $bmp.Width, $bmp.Height
$gfx = [System.Drawing.Graphics]::FromImage($canvas)
$gfx.DrawImage($bmp, 0, 0)
$gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$font = New-Object System.Drawing.Font 'Segoe UI', 12, [System.Drawing.FontStyle]::Bold
${lines}
$font.Dispose()
$out = Join-Path $env:TEMP ('macaw-som-' + [guid]::NewGuid().ToString() + '.png')
$canvas.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$canvas.Dispose()
$bmp.Dispose()
Write-Output $out
`)
}

export function buildIndex(candidates: Candidate[]) {
  const index = new Map<number, Candidate>()
  candidates.forEach((c, idx) => {
    index.set(idx + 1, c)
  })
  return index
}

export async function annotate(shot: string, candidates: Candidate[], signal?: AbortSignal): Promise<Marked> {
  const index = buildIndex(candidates)
  if (!candidates.length) return { shot, index }
  const { raw, tmp } = tmpPath(shot)
  await Bun.write(tmp, raw)
  try {
    const boxes = Array.from(index.entries()).map(([n, c]) => ({ n, rect: c.rect }))
    const file = await run(annotateScript(tmp, boxes), signal)
    const buf = Buffer.from(await Bun.file(file).arrayBuffer())
    await unlink(file).catch(() => undefined)
    return {
      shot: `data:image/png;base64,${buf.toString("base64")}`,
      index,
    }
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}

export function describe(index: Map<number, import("./discover").Candidate>) {
  const lines: string[] = []
  for (const [n, c] of index.entries()) {
    const parts = [
      `[${n}]`,
      c.label || "element",
      c.controlType ? `(${c.controlType})` : "",
      `rect=${c.rect.join(",")}`,
      c.source === "uia" ? "uia" : "visual",
    ].filter(Boolean)
    lines.push(parts.join(" "))
  }
  return lines.join("\n")
}
