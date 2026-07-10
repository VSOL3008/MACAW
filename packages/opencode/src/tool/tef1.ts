import path from "path"
import { mkdir, rm } from "fs/promises"
import os from "os"
import z from "zod"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"
import { assertExternalDirectory } from "./external-directory"
import { Tool } from "./tool"
import { ensureWindows, runFile } from "./win"
import template from "./tef1/TEF1_Report_template.pptx" with { type: "file" }

export const MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
export const MAX_ATTACHMENT = 15 * 1024 * 1024
export const PAGE = 12
export const DPI = 160

const ref = z.object({
  label: z.string().min(1),
  source: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
})

const stats = z.object({
  ok: z.number().nonnegative().optional(),
  nok: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
  fpy: z.number().nonnegative().optional(),
})

const report = z.object({
  theme: z.string().min(1),
  requester: z.string().min(1),
  date: z.string().min(1),
  target: z.string().min(1),
  safe_launch: z.boolean(),
  report_id: z.string().optional(),
  production: z.string().optional(),
  line: z.string().optional(),
  station: z.string().optional(),
  author: z.string().optional(),
  recipients: z.array(z.string()).optional(),
  results: z.string().optional(),
  summary: z.string().optional(),
  contracting: z.union([z.boolean(), z.string()]).optional(),
  protechs_4d: z.boolean().optional(),
  process: z.string().optional(),
  product_type: z.string().optional(),
  production_date: z.string().optional(),
  result_link: z.string().optional(),
  stats: stats.optional(),
})

const section = z.object({
  title: z.string().min(1),
  bullets: z.array(z.string().min(1)).min(1).max(12),
  notes: z.string().optional(),
})

const crop = z.object({
  left: z.number().nonnegative().optional(),
  top: z.number().nonnegative().optional(),
  right: z.number().nonnegative().optional(),
  bottom: z.number().nonnegative().optional(),
})

const visual = z
  .object({
    title: z.string().min(1),
    caption: z.string().min(1),
    image_path: z.string().min(1).optional(),
    pdf_path: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
    source: z.string().min(1),
    crop: crop.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.image_path && val.pdf_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "visual must use either image_path or pdf_path, not both",
        path: ["image_path"],
      })
    }
    if (!val.image_path && !val.pdf_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "visual requires image_path or pdf_path",
        path: ["image_path"],
      })
    }
    if (val.pdf_path && !val.page) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "visual pdf_path requires page",
        path: ["page"],
      })
    }
  })

export const parameters = z.object({
  output_path: z.string().min(1),
  overwrite: z.boolean().optional(),
  mode: z.enum(["full", "form"]).default("full"),
  appendix_policy: z.enum(["auto", "always", "never"]).default("auto"),
  report,
  evidence: z.array(ref).max(100).default([]),
  sections: z.array(section).max(40).default([]),
  visuals: z.array(visual).max(40).default([]),
})

export type Tef1Input = z.infer<typeof parameters>

type Build = {
  output?: string
  render?: string
  template?: string
}

type Result = {
  output_path: string
  render_path: string
  slide_count: number
  evidence: string[]
  warnings: string[]
}

type Tooling = {
  pdftoppm?: string | null
  gswin64c?: string | null
  gswin32c?: string | null
  gs?: string | null
}

function b64(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64")
}

function file(value: string, dir?: string) {
  if (path.isAbsolute(value)) return path.resolve(value)
  return path.resolve(path.join(dir ?? Instance.directory, value))
}

export function pages(items: Tef1Input["evidence"] = []) {
  return Array.from({ length: Math.ceil(items.length / PAGE) }, (_, i) => ({
    items: items.slice(i * PAGE, i * PAGE + PAGE),
  }))
}

export function refs(input: Pick<Tef1Input, "appendix_policy" | "evidence">) {
  if (input.appendix_policy === "never") return []
  const out = pages(input.evidence)
  if (out.length) return out
  if (input.appendix_policy === "always") return [{ items: [] }]
  return []
}

export function deck(input: Pick<Tef1Input, "appendix_policy" | "evidence" | "mode" | "sections" | "visuals">) {
  return [
    ...(input.mode === "full" ? input.sections.map((item) => ({ kind: "section" as const, section: item })) : []),
    ...(input.mode === "full" ? input.visuals.map((item) => ({ kind: "visual" as const, visual: item })) : []),
    ...refs(input).map((page) => ({ kind: "reference" as const, page })),
  ]
}

export function slides(input: Pick<Tef1Input, "appendix_policy" | "evidence" | "mode" | "report" | "sections" | "visuals">) {
  return 1 + (input.report.safe_launch ? 2 : 0) + deck(input).length
}

export function output(input: Pick<Tef1Input, "output_path" | "overwrite">, dir = Instance.directory) {
  const base = path.isAbsolute(input.output_path) ? input.output_path : path.join(dir, input.output_path)
  const ext = path.extname(base)
  if (ext && ext.toLowerCase() !== ".pptx") {
    throw new Error("tef1_report output_path must be a .pptx file.")
  }
  const out = path.resolve(ext ? base : `${base}.pptx`)
  if (Filesystem.stat(out) && input.overwrite !== true) {
    throw new Error(`tef1_report output already exists: ${out}. Set overwrite=true to replace it.`)
  }
  return out
}

export function pattern(out: string) {
  const rel = path.relative(Instance.worktree, out)
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel
  return out
}

export function renderer(tool: Tooling) {
  if (tool.pdftoppm) return { kind: "pdftoppm" as const, path: tool.pdftoppm }
  const gs = tool.gswin64c ?? tool.gswin32c ?? tool.gs
  if (gs) return { kind: "ghostscript" as const, path: gs }
  return undefined
}

async function runbin(cmd: string, args: string[], signal?: AbortSignal) {
  const child = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const abort = () => child.kill()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) {
      throw new Error((err || out || "TEF1 visual conversion failed").trim())
    }
  } finally {
    signal?.removeEventListener("abort", abort)
  }
}

async function convert(pdf: string, page: number, dir: string, i: number, signal?: AbortSignal) {
  await mkdir(dir, { recursive: true })
  const tool = renderer({
    pdftoppm: Bun.which("pdftoppm"),
    gswin64c: Bun.which("gswin64c"),
    gswin32c: Bun.which("gswin32c"),
    gs: Bun.which("gs"),
  })
  if (!tool) {
    throw new Error("TEF1 visual pdf_path requires pdftoppm or Ghostscript. Provide image_path instead.")
  }
  if (tool.kind === "pdftoppm") {
    const prefix = path.join(dir, `visual-${i}`)
    const out = `${prefix}.png`
    await runbin(tool.path, ["-f", `${page}`, "-l", `${page}`, "-png", "-singlefile", "-r", `${DPI}`, pdf, prefix], signal)
    return out
  }
  const out = path.join(dir, `visual-${i}.png`)
  await runbin(
    tool.path,
    [
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-sDEVICE=png16m",
      `-r${DPI}`,
      `-dFirstPage=${page}`,
      `-dLastPage=${page}`,
      `-sOutputFile=${out}`,
      pdf,
    ],
    signal,
  )
  return out
}

export async function prepare(input: Tef1Input, signal?: AbortSignal) {
  const dir = path.join(os.tmpdir(), `macaw-tef1-visual-${crypto.randomUUID()}`)
  const pdfs = input.visuals.filter((item) => item.pdf_path)
  const visuals = await Promise.all(
    input.visuals.map(async (item, i) => {
      if (item.image_path) {
        const image = file(item.image_path)
        if (!(await Bun.file(image).exists())) throw new Error(`TEF1 visual image not found: ${image}`)
        return { ...item, image_path: image }
      }
      const pdf = file(item.pdf_path!)
      if (!(await Bun.file(pdf).exists())) throw new Error(`TEF1 visual PDF not found: ${pdf}`)
      return { ...item, image_path: await convert(pdf, item.page!, dir, i + 1, signal), pdf_path: undefined }
    }),
  )
  return {
    input: { ...input, visuals },
    cleanup: () => (pdfs.length ? rm(dir, { recursive: true, force: true }) : Promise.resolve()),
  }
}

export function build(input: Tef1Input, opts: Build = {}) {
  const doc = parameters.parse(input)
  const cfg = {
    ...doc,
    output_path: opts.output ?? doc.output_path,
    template_path: opts.template ?? template,
    render_path: opts.render ?? "",
    deck: deck(doc),
  }
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$cfg = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(cfg)}')) | ConvertFrom-Json
$warnings = New-Object System.Collections.Generic.List[string]

function Txt($value, [string]$fallback = 'N/A') {
  if ($null -eq $value) { return $fallback }
  $out = [string]$value
  if ([string]::IsNullOrWhiteSpace($out)) { return $fallback }
  return $out.Trim()
}

function Lines($value) {
  if ($null -eq $value) { return 'N/A' }
  $items = @($value) | ForEach-Object { Txt $_ } | Where-Object { $_ -ne 'N/A' }
  if ($items.Count -eq 0) { return 'N/A' }
  return ($items -join [Environment]::NewLine)
}

function YesNo($value) {
  if ($null -eq $value) { return 'N/A' }
  if ($value -is [bool]) {
    if ($value) { return 'Yes' }
    return 'No'
  }
  $out = [string]$value
  if ([string]::IsNullOrWhiteSpace($out)) { return 'N/A' }
  return $out.Trim()
}

function Add-Text($slide, [double]$left, [double]$top, [double]$width, [double]$height, [string]$text, [int]$size = 12, [bool]$bold = $false) {
  $shape = $slide.Shapes.AddTextbox(1, $left, $top, $width, $height)
  $shape.TextFrame.TextRange.Text = $text
  $shape.TextFrame.TextRange.Font.Name = 'Bosch Office Sans'
  $shape.TextFrame.TextRange.Font.Size = $size
  $shape.TextFrame.TextRange.Font.Bold = $bold
  $shape.TextFrame.TextRange.ParagraphFormat.Bullet.Visible = 0
  $shape.TextFrame.WordWrap = -1
  $shape.Fill.Visible = 0
  $shape.Line.Visible = 0
  return $shape
}

function Set-Box($shape, [string]$value, [int]$size = 12, [bool]$bold = $false) {
  $shape.TextFrame.TextRange.Text = $value
  $shape.TextFrame.TextRange.Font.Name = 'Bosch Office Sans'
  $shape.TextFrame.TextRange.Font.Size = $size
  $shape.TextFrame.TextRange.Font.Bold = $bold
  $shape.TextFrame.TextRange.ParagraphFormat.Bullet.Visible = 0
  $shape.TextFrame.WordWrap = -1
}

function Mark-Contracting($slide) {
  if ($null -eq $cfg.report.contracting -or $cfg.report.contracting -isnot [bool]) { return }
  foreach ($shape in $slide.Shapes) {
    if ($shape.Type -ne 6) { continue }
    $items = @($shape.GroupItems)
    $boxes = @($items | Where-Object { $_.Type -eq 1 -and $_.Width -lt 12 -and $_.Height -lt 14 } | Sort-Object Left)
    if ($boxes.Count -lt 2) { continue }
    Set-Box $boxes[0] '' 7 $false
    Set-Box $boxes[1] '' 7 $false
    $box = if ($cfg.report.contracting) { $boxes[0] } else { $boxes[1] }
    Set-Box $box 'X' 7 $true
    $box.TextFrame.TextRange.ParagraphFormat.Alignment = 2
    $box.TextFrame.VerticalAnchor = 3
    return
  }
}

function Shape-Texts($shape) {
  $out = New-Object System.Collections.Generic.List[string]
  if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
    [void]$out.Add([string]$shape.TextFrame.TextRange.Text)
  }
  if ($shape.Type -eq 6) {
    foreach ($child in $shape.GroupItems) {
      foreach ($text in (Shape-Texts $child)) { [void]$out.Add($text) }
    }
  }
  return $out.ToArray()
}

function Find-Contains($slide, [string]$needle) {
  foreach ($shape in $slide.Shapes) {
    if (-not $shape.HasTextFrame -or -not $shape.TextFrame.HasText) { continue }
    if ([string]$shape.TextFrame.TextRange.Text -notlike ('*' + $needle + '*')) { continue }
    return $shape
  }
  return $null
}

function Set-Contains($slide, [string]$needle, [string]$value, [int]$size = 12, [bool]$bold = $false) {
  $shape = Find-Contains $slide $needle
  if ($shape) {
    Set-Box $shape $value $size $bold
    return $true
  }
  return $false
}

function Is-Green($shape) {
  if (-not $shape.Fill -or -not $shape.Fill.Visible) { return $false }
  $rgb = [int]$shape.Fill.ForeColor.RGB
  $a = $rgb -band 255
  $b = ($rgb -shr 8) -band 255
  $c = ($rgb -shr 16) -band 255
  return ($b -ge 200 -and $a -ge 70 -and $a -le 180 -and $c -ge 70 -and $c -le 180)
}

function Is-Instruction($shape) {
  $text = ((Shape-Texts $shape) -join [Environment]::NewLine)
  if ($text -like '*slide vymazat*') { return $true }
  if ($text -like '*Vzhled tohoto*') { return $true }
  if ($text -like '*2x klik*') { return $true }
  if ($text -like '*odkaz na*') { return $true }
  if ($text -like '*vyplnit cislo*') { return $true }
  if ($text -like '*prazdne stranky*') { return $true }
  if ($text -like '*smazat*') { return $true }
  if ($text -like '*atp.*') { return $true }
  return $false
}

function Remove-Instructions($slide) {
  $drop = New-Object System.Collections.Generic.List[object]
  foreach ($shape in @($slide.Shapes)) {
    if ((Is-Green $shape) -or (Is-Instruction $shape)) { [void]$drop.Add($shape) }
  }
  foreach ($shape in $drop.ToArray()) { $shape.Delete() }
}

function Remove-BodyText($slide) {
  $drop = New-Object System.Collections.Generic.List[object]
  foreach ($shape in @($slide.Shapes)) {
    $text = ((Shape-Texts $shape) -join [Environment]::NewLine)
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    if ($shape.Top -lt 130 -or $shape.Top -gt 452) { continue }
    if ($text -like '*Report:*' -or $text -like '*Theme:*') { continue }
    [void]$drop.Add($shape)
  }
  foreach ($shape in $drop.ToArray()) { $shape.Delete() }
}

function Remove-DetailObjects($slide) {
  $drop = New-Object System.Collections.Generic.List[object]
  foreach ($shape in @($slide.Shapes)) {
    if ($shape.Type -eq 7 -or $shape.Type -eq 10) { [void]$drop.Add($shape); continue }
    if ($shape.Left -gt 380 -and $shape.Top -gt 90 -and $shape.Width -gt 200) {
      $text = ((Shape-Texts $shape) -join [Environment]::NewLine)
      if ($text -eq '' -or $text -like '*#DIV/0!*' -or $text -like '*########*') { [void]$drop.Add($shape) }
    }
  }
  foreach ($shape in $drop.ToArray()) { $shape.Delete() }
}

function Remove-Zoom($slide) {
  $drop = New-Object System.Collections.Generic.List[object]
  foreach ($shape in @($slide.Shapes)) {
    if ($shape.Left -gt 330 -and $shape.Top -gt 180 -and $shape.Width -gt 120 -and $shape.Height -gt 80) {
      [void]$drop.Add($shape)
    }
  }
  foreach ($shape in $drop.ToArray()) { $shape.Delete() }
}

function Set-Cell($table, [int]$row, [int]$col, [string]$value, [bool]$bold = $false) {
  $range = $table.Cell($row, $col).Shape.TextFrame.TextRange
  $range.Text = $value
  $range.Font.Name = 'Bosch Office Sans'
  $range.Font.Size = 8
  $range.Font.Bold = $bold
}

function Pct($part, $total) {
  if ($null -eq $part -or $null -eq $total -or [double]$total -eq 0) { return 'N/A' }
  return ('{0:N1}%' -f (([double]$part / [double]$total) * 100))
}

function Add-Stats($slide) {
  $ok = $cfg.report.stats.ok
  $nok = $cfg.report.stats.nok
  $total = $cfg.report.stats.total
  if ($null -eq $total -and ($null -ne $ok -or $null -ne $nok)) { $total = [double](0 + $ok + $nok) }
  $fpy = $cfg.report.stats.fpy
  $shape = $slide.Shapes.AddTable(4, 4, 426, 118, 420, 96)
  $table = $shape.Table
  Set-Cell $table 1 1 'Status' $true
  Set-Cell $table 1 2 'OK' $true
  Set-Cell $table 1 3 'NOK' $true
  Set-Cell $table 1 4 'Total' $true
  Set-Cell $table 2 1 'pcs' $true
  Set-Cell $table 2 2 (Txt $ok) $false
  Set-Cell $table 2 3 (Txt $nok) $false
  Set-Cell $table 2 4 (Txt $total) $false
  Set-Cell $table 3 1 '%' $true
  Set-Cell $table 3 2 (Pct $ok $total) $false
  Set-Cell $table 3 3 (Pct $nok $total) $false
  Set-Cell $table 3 4 '100%' $false
  Set-Cell $table 4 1 'FPY' $true
  Set-Cell $table 4 2 (Txt $fpy) $false
  Set-Cell $table 4 3 'N/A' $false
  Set-Cell $table 4 4 'N/A' $false
}

function Ref-Line($item, [int]$i) {
  $parts = New-Object System.Collections.Generic.List[string]
  [void]$parts.Add((Txt $item.label))
  if (-not [string]::IsNullOrWhiteSpace([string]$item.source)) { [void]$parts.Add('source: ' + [string]$item.source) }
  if (-not [string]::IsNullOrWhiteSpace([string]$item.path)) { [void]$parts.Add('path: ' + (Clip ([string]$item.path) 112)) }
  if (-not [string]::IsNullOrWhiteSpace([string]$item.url)) { [void]$parts.Add('url: ' + (Clip ([string]$item.url) 112)) }
  return ([string]$i + '. ' + (($parts.ToArray()) -join ' | '))
}

function Clip([string]$value, [int]$limit) {
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  if ($value.Length -le $limit) { return $value }
  return ('...' + $value.Substring($value.Length - $limit + 3))
}

function Fill-Refs($slide, $page, [int]$index, [int]$total, [int]$start) {
  Remove-Instructions $slide
  $head = Find-Contains $slide 'Backup'
  if ($head) {
    $head.Left = 54
    $head.Top = 104
    $head.Width = 740
    $head.Height = 28
    Set-Box $head ('Appendix / References' + $(if ($total -gt 1) { ' ' + $index + '/' + $total } else { '' })) 16 $true
  }
  Set-Contains $slide 'Theme:' ('Theme: ' + (Txt $cfg.report.theme)) 18 $false | Out-Null
  Remove-BodyText $slide
  $lines = New-Object System.Collections.Generic.List[string]
  $base = (($index - 1) * ${PAGE}) + 1
  $items = @($page.items)
  for ($i = 0; $i -lt $items.Count; $i++) {
    [void]$lines.Add((Ref-Line $items[$i] ($base + $i)))
  }
  Add-Text $slide 54 142 756 278 (($lines.ToArray()) -join [Environment]::NewLine) 8 $false | Out-Null
}

function Fill-Title($slide, [string]$title, [int]$index, [int]$total) {
  Remove-Instructions $slide
  $head = Find-Contains $slide 'Backup'
  if ($head) {
    $head.Left = 54
    $head.Top = 104
    $head.Width = 740
    $head.Height = 30
    Set-Box $head $title 17 $true
    return
  }
  Add-Text $slide 54 104 740 30 $title 17 $true | Out-Null
}

function Bullet-Lines($items) {
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($item in @($items)) {
    [void]$lines.Add('- ' + (Txt $item))
  }
  if ($lines.Count -eq 0) { return 'N/A' }
  return (($lines.ToArray()) -join [Environment]::NewLine)
}

function Fill-Section($slide, $item, [int]$index, [int]$total) {
  Fill-Title $slide (Txt $item.section.title) $index $total
  Remove-BodyText $slide
  Add-Text $slide 62 150 704 190 (Bullet-Lines $item.section.bullets) 15 $false | Out-Null
  if (-not [string]::IsNullOrWhiteSpace([string]$item.section.notes)) {
    Add-Text $slide 62 356 704 72 ('Notes:' + [Environment]::NewLine + (Txt $item.section.notes)) 10 $false | Out-Null
  }
}

function Apply-Crop($pic, $crop) {
  if ($null -eq $crop) { return }
  if ($null -ne $crop.left) { $pic.PictureFormat.CropLeft = [double]$crop.left }
  if ($null -ne $crop.top) { $pic.PictureFormat.CropTop = [double]$crop.top }
  if ($null -ne $crop.right) { $pic.PictureFormat.CropRight = [double]$crop.right }
  if ($null -ne $crop.bottom) { $pic.PictureFormat.CropBottom = [double]$crop.bottom }
}

function Add-PictureFit($slide, [string]$file, [double]$left, [double]$top, [double]$width, [double]$height, $crop) {
  if (-not (Test-Path -LiteralPath $file)) { throw ('TEF1 visual image not found: ' + $file) }
  $pic = $slide.Shapes.AddPicture($file, $false, $true, $left, $top, -1, -1)
  Apply-Crop $pic $crop
  $pic.LockAspectRatio = -1
  if ($pic.Width -le 0 -or $pic.Height -le 0) { return $pic }
  $scale = [Math]::Min($width / $pic.Width, $height / $pic.Height)
  $pic.Width = $pic.Width * $scale
  $pic.Height = $pic.Height * $scale
  $pic.Left = $left + (($width - $pic.Width) / 2)
  $pic.Top = $top + (($height - $pic.Height) / 2)
  return $pic
}

function Fill-Visual($slide, $item, [int]$index, [int]$total) {
  Fill-Title $slide (Txt $item.visual.title) $index $total
  Remove-BodyText $slide
  Add-PictureFit $slide ([string]$item.visual.image_path) 54 142 756 238 $item.visual.crop | Out-Null
  Add-Text $slide 54 392 756 52 ((Txt $item.visual.caption) + [Environment]::NewLine + ('Source: ' + (Txt $item.visual.source))) 9 $false | Out-Null
}

function Fill-Slide1($slide) {
  Set-Contains $slide 'Report:' ('TEF1 Report: ' + (Txt $cfg.report.report_id '')) 22 $false | Out-Null
  Set-Contains $slide 'Theme:' ('Theme: ' + (Txt $cfg.report.theme)) 18 $false | Out-Null
  Set-Contains $slide 'Requester:' (('Requester: ' + (Txt $cfg.report.requester)) + [Environment]::NewLine + ('Production: ' + (Txt $cfg.report.production)) + [Environment]::NewLine + ('Line: ' + (Txt $cfg.report.line)) + [Environment]::NewLine + ('Station: ' + (Txt $cfg.report.station)) + [Environment]::NewLine + ('Author: ' + (Txt $cfg.report.author)) + [Environment]::NewLine + ('Date: ' + (Txt $cfg.report.date))) 10 $false | Out-Null
  Set-Contains $slide 'Recipients:' ('Recipients:' + [Environment]::NewLine + (Lines $cfg.report.recipients)) 10 $false | Out-Null
  Set-Contains $slide 'Target:' ('Target:' + [Environment]::NewLine + (Txt $cfg.report.target)) 8 $false | Out-Null
  Set-Contains $slide 'Results:' ('Results:' + [Environment]::NewLine + (Txt $cfg.report.results)) 10 $false | Out-Null
  Set-Contains $slide 'Summary and next steps' ('Summary and next steps:' + [Environment]::NewLine + (Txt $cfg.report.summary)) 10 $false | Out-Null
  Set-Contains $slide 'With process team' ('Contracting / With process team: ' + (YesNo $cfg.report.contracting)) 7 $false | Out-Null
  Set-Contains $slide 'Projektová dohoda' ('Contracting: ' + (YesNo $cfg.report.contracting)) 12 $false | Out-Null
  Mark-Contracting $slide
  Set-Contains $slide 'screewing' ('ProtechS 4D applied for screwing process: ' + (YesNo $cfg.report.protechs_4d)) 7 $false | Out-Null
  Set-Contains $slide 'screwing' ('ProtechS 4D applied for screwing process: ' + (YesNo $cfg.report.protechs_4d)) 7 $false | Out-Null
}

function Fill-Safe($pres) {
  $slide = $pres.Slides.Item(2)
  Remove-Instructions $slide
  Remove-Zoom $slide
  Remove-BodyText $slide
  Set-Contains $slide 'Datum' ('Current production evaluation' + [Environment]::NewLine + ('Production date: ' + (Txt $cfg.report.production_date)) + [Environment]::NewLine + ('Result link: ' + (Txt $cfg.report.result_link))) | Out-Null
  Add-Text $slide 398 214 342 118 'Safe Launch detail is summarized on the following editable slide. Source files and links are listed in the appendix when evidence was provided.' 12 $false | Out-Null

  $detail = $pres.Slides.Item(3)
  Remove-Instructions $detail
  Remove-DetailObjects $detail
  Set-Contains $detail 'Process' (('Process: ' + (Txt $cfg.report.process)) + [Environment]::NewLine + ('Line: ' + (Txt $cfg.report.line)) + [Environment]::NewLine + ('Station: ' + (Txt $cfg.report.station)) + [Environment]::NewLine + ('Product type: ' + (Txt $cfg.report.product_type)) + [Environment]::NewLine + ('Production date: ' + (Txt $cfg.report.production_date))) | Out-Null
  Add-Stats $detail
  Add-Text $detail 426 230 420 178 (('Results / process data:' + [Environment]::NewLine + (Txt $cfg.report.results)) + [Environment]::NewLine + [Environment]::NewLine + ('Result link: ' + (Txt $cfg.report.result_link))) 9 $false | Out-Null
}

function Fill-Headings($pres) {
  for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    Set-Contains $pres.Slides.Item($i) 'Report:' ('TEF1 Report: ' + (Txt $cfg.report.report_id '')) 22 $false | Out-Null
    Set-Contains $pres.Slides.Item($i) 'Theme:' ('Theme: ' + (Txt $cfg.report.theme)) 18 $false | Out-Null
  }
}

function Configure-Deck($pres, [int]$start) {
  $items = @()
  if ($null -ne $cfg.deck) { $items = @($cfg.deck) }
  if ($items.Count -eq 0) {
    for ($i = $pres.Slides.Count; $i -ge $start; $i--) { $pres.Slides.Item($i).Delete() }
    return
  }
  for ($i = $pres.Slides.Count; $i -ge ($start + 1); $i--) { $pres.Slides.Item($i).Delete() }
  $base = $pres.Slides.Item($start)
  for ($i = 2; $i -le $items.Count; $i++) {
    $dup = $base.Duplicate()
    $dup.Item(1).MoveTo($start + $i - 1)
  }
  $refs = @($items | Where-Object { [string]$_.kind -eq 'reference' })
  $ref = 0
  for ($i = 1; $i -le $items.Count; $i++) {
    $item = $items[$i - 1]
    $slide = $pres.Slides.Item($start + $i - 1)
    if ([string]$item.kind -eq 'section') {
      Fill-Section $slide $item $i $items.Count
      continue
    }
    if ([string]$item.kind -eq 'visual') {
      Fill-Visual $slide $item $i $items.Count
      continue
    }
    if ([string]$item.kind -eq 'reference') {
      $ref++
      Fill-Refs $slide $item.page $ref $refs.Count $start
      continue
    }
    throw ('Unknown TEF1 slide kind: ' + [string]$item.kind)
  }
}

function All-Text($pres) {
  $out = New-Object System.Collections.Generic.List[string]
  for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    foreach ($shape in $pres.Slides.Item($i).Shapes) {
      foreach ($text in (Shape-Texts $shape)) { [void]$out.Add($text) }
    }
  }
  return (($out.ToArray()) -join [Environment]::NewLine)
}

function Has-Green($pres) {
  for ($i = 1; $i -le $pres.Slides.Count; $i++) {
    foreach ($shape in $pres.Slides.Item($i).Shapes) {
      if (Is-Green $shape) { return $true }
    }
  }
  return $false
}

function Validate($pres, [int]$expected) {
  $fail = New-Object System.Collections.Generic.List[string]
  if ($pres.Slides.Count -ne $expected) { [void]$fail.Add('expected ' + $expected + ' slides but found ' + $pres.Slides.Count) }
  $text = All-Text $pres
  foreach ($needle in @('#DIV/0!', '########', 'screewing', 'vyplnit', 'smazat')) {
    if ($text -like ('*' + $needle + '*')) { [void]$fail.Add('visible placeholder/error remains: ' + $needle) }
  }
  foreach ($needle in @($cfg.report.theme, $cfg.report.requester, $cfg.report.date, $cfg.report.target)) {
    if ($text -notlike ('*' + [string]$needle + '*')) { [void]$fail.Add('critical field not visible: ' + [string]$needle) }
  }
  foreach ($item in @($cfg.deck)) {
    if ([string]$item.kind -eq 'section' -and $text -notlike ('*' + [string]$item.section.title + '*')) {
      [void]$fail.Add('section title not visible: ' + [string]$item.section.title)
    }
    if ([string]$item.kind -eq 'visual' -and $text -notlike ('*' + [string]$item.visual.title + '*')) {
      [void]$fail.Add('visual title not visible: ' + [string]$item.visual.title)
    }
  }
  if (Has-Green $pres) { [void]$fail.Add('green instruction overlay remains') }
  return $fail
}

$template = [string]$cfg.template_path
$out = [string]$cfg.output_path
$render = [string]$cfg.render_path
if ([string]::IsNullOrWhiteSpace($render)) {
  $render = Join-Path ([System.IO.Path]::GetTempPath()) ('macaw-tef1-' + [guid]::NewGuid().ToString())
}
if (-not (Test-Path -LiteralPath $template)) { throw ('TEF1 template asset not found: ' + $template) }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null
Copy-Item -LiteralPath $template -Destination $out -Force

$app = $null
$pres = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $app.DisplayAlerts = 1
} catch {
  throw 'Microsoft PowerPoint COM automation is unavailable. TEF1 report generation requires Windows with desktop PowerPoint installed.'
}

try {
  $pres = $app.Presentations.Open($out, $false, $false, $false)
  Fill-Slide1 $pres.Slides.Item(1)
  if ($cfg.report.safe_launch) {
    Fill-Safe $pres
    Configure-Deck $pres 4
  } else {
    $pres.Slides.Item(3).Delete()
    $pres.Slides.Item(2).Delete()
    Configure-Deck $pres 2
  }
  Fill-Headings $pres
  $pres.Save()
  $pres.Close()
  $pres = $null
  $pres = $app.Presentations.Open($out, $true, $false, $false)
  if (Test-Path -LiteralPath $render) { Remove-Item -LiteralPath $render -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $render | Out-Null
  $pres.Export($render, 'PNG', 1600, 900)
  $expected = ${slides(doc)}
  $fail = Validate $pres $expected
  if ($fail.Count -gt 0) {
    throw ('TEF1 validation failed for draft ' + $out + ': ' + (($fail.ToArray()) -join '; '))
  }
  $refs = @()
  if ($null -ne $cfg.evidence) { $refs = @($cfg.evidence) | ForEach-Object { Txt $_.label } }
  [pscustomobject]@{
    output_path = $out
    render_path = $render
    slide_count = [int]$pres.Slides.Count
    evidence = @($refs)
    warnings = @($warnings.ToArray())
  } | ConvertTo-Json -Depth 8 -Compress
} finally {
  if ($pres) { $pres.Close() | Out-Null }
  if ($app) { $app.Quit() | Out-Null }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
`.trim()
}

async function attachment(out: string) {
  const size = await Filesystem.size(out)
  if (size > MAX_ATTACHMENT) return []
  const buf = Buffer.from(await Bun.file(out).arrayBuffer())
  return [
    {
      type: "file" as const,
      mime: MIME,
      filename: path.basename(out),
      url: `data:${MIME};base64,${buf.toString("base64")}`,
    },
  ]
}

export const Tef1ReportTool = Tool.define("tef1_report", {
  description:
    "Generate a final-ready editable TEF1 PowerPoint report from structured TEF1 context using the built-in TEF1_Report_template.pptx. Requires Windows with desktop PowerPoint installed.",
  parameters,
  async execute(input, ctx) {
    ensureWindows()
    const data = parameters.parse(input)
    const out = output(data)
    await assertExternalDirectory(ctx, out)
    await Promise.all(
      data.visuals.map((item) => assertExternalDirectory(ctx, file(item.image_path ?? item.pdf_path!))),
    )
    const target = pattern(out)
    await ctx.ask({
      permission: "tef1_report",
      patterns: [target],
      always: [target],
      metadata: {
        output_path: out,
        overwrite: input.overwrite === true,
      },
    })

    const ready = await prepare(data, ctx.abort)
    const raw = await runFile(build(ready.input, { output: out }), ctx.abort).finally(ready.cleanup)
    const result = JSON.parse(raw) as Result
    const files = await attachment(out)
    const refs = result.evidence.length ? `\nEvidence references: ${result.evidence.join(", ")}` : ""
    const warn = result.warnings.length ? `\nWarnings: ${result.warnings.join("; ")}` : ""
    return {
      title: path.basename(out),
      output: `Generated TEF1 report: ${result.output_path}\nSlides: ${result.slide_count}${refs}${warn}`,
      metadata: {
        output_path: result.output_path,
        render_path: result.render_path,
        slide_count: result.slide_count,
        evidence: result.evidence,
        warnings: result.warnings,
        attached: files.length > 0,
      },
      ...(files.length ? { attachments: files } : {}),
    }
  },
})
