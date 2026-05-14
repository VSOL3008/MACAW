import z from "zod"
import { Tool } from "./tool"
import { png, prelude, ps } from "./win"

const parameters = z.object({
  target: z.enum(["screen", "window", "region"]).default("screen"),
  window_title: z.string().optional(),
  region: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    })
    .optional(),
})
export type CaptureInput = z.infer<typeof parameters>

function script(input: z.infer<typeof parameters>) {
  if (input.target === "window") {
    if (!input.window_title) throw new Error("window_title is required when target is window")
    return prelude(`
$hit = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${ps(input.window_title)}*' } | Select-Object -First 1
if (-not $hit) { throw 'Window not found' }
$rect = New-Object RECT
[MacawWin]::GetWindowRect($hit.MainWindowHandle, [ref]$rect) | Out-Null
$w = [Math]::Max(1, $rect.Right - $rect.Left)
$h = [Math]::Max(1, $rect.Bottom - $rect.Top)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$file = Join-Path $env:TEMP ('macaw-shot-' + [guid]::NewGuid().ToString() + '.png')
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
Write-Output $file
`)
  }
  if (input.target === "region") {
    if (!input.region) throw new Error("region is required when target is region")
    return prelude(`
$bmp = New-Object System.Drawing.Bitmap ${input.region.w}, ${input.region.h}
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen(${input.region.x}, ${input.region.y}, 0, 0, $bmp.Size)
$file = Join-Path $env:TEMP ('macaw-shot-' + [guid]::NewGuid().ToString() + '.png')
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
Write-Output $file
`)
  }
  return prelude(`
$rect = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($rect.X, $rect.Y, 0, 0, $bmp.Size)
$file = Join-Path $env:TEMP ('macaw-shot-' + [guid]::NewGuid().ToString() + '.png')
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
Write-Output $file
`)
}

export async function capture(input: CaptureInput, signal?: AbortSignal) {
  return png(script(input), signal)
}

export const ScreenshotTool = Tool.define("screenshot", {
  description: "Capture the full screen, a window, or a region.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "screenshot",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        target: input.target,
      },
    })
    const url = await capture(input, ctx.abort)
    return {
      title: `Screenshot: ${input.target}`,
      output: `Captured a ${input.target} screenshot.`,
      metadata: {
        target: input.target,
      },
      attachments: [
        {
          type: "file",
          mime: "image/png",
          filename: "screenshot.png",
          url,
        },
      ],
    }
  },
})
