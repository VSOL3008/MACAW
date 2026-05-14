import z from "zod"
import { Tool } from "./tool"
import { json, prelude, ps, run } from "./win"

const parameters = z.object({
  action: z.enum(["list", "focus", "minimize", "maximize", "close", "resize"]),
  title: z.string().optional(),
  pid: z.number().int().optional(),
  size: z
    .object({
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    })
    .optional(),
})

type Win = {
  id: number
  title: string
}

function pick(input: z.infer<typeof parameters>) {
  if (input.pid) return `$hit = Get-Process -Id ${input.pid} | Select-Object -First 1`
  if (input.title) {
    return `$hit = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${ps(input.title)}*' } | Select-Object -First 1`
  }
  throw new Error("title or pid is required for this action")
}

async function titles(signal?: AbortSignal) {
  const data = await json<Win[]>(
    `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object @{Name='id';Expression={$_.Id}}, @{Name='title';Expression={$_.MainWindowTitle}} | ConvertTo-Json -Depth 3`,
    signal,
  )
  return (data ?? []).map((w) => w.title)
}

export const WindowTool = Tool.define("window", {
  description: "List, focus, resize, minimize, maximize, or close windows.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "window",
      patterns: ["*"],
      always: ["*"],
      metadata: input,
    })
    if (input.action === "list") {
      const data = (await json<Win[]>(
        `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object @{Name='id';Expression={$_.Id}}, @{Name='title';Expression={$_.MainWindowTitle}} | ConvertTo-Json -Depth 3`,
        ctx.abort,
      )) ?? []
      return {
        title: "Windows",
        output: JSON.stringify(data, null, 2),
        metadata: {
          count: data.length,
          pid: 0,
          action: "list",
        },
      }
    }
    if (input.action === "resize" && !input.size) throw new Error("size is required when action is resize")
    let out: string
    try {
      out = await doAction(input, ctx.abort)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("WINDOW_NOT_FOUND")) {
        const open = await titles(ctx.abort).catch(() => [])
        throw new Error(
          `Window "${input.title ?? input.pid}" not found. Open windows: ${open.length ? open.map((t) => `"${t}"`).join(", ") : "(none visible)"}.`,
        )
      }
      throw err
    }
    return {
      title: `Window: ${input.action}`,
      output: `Applied ${input.action} to window process ${out}.`,
      metadata: {
        count: 1,
        action: input.action,
        pid: Number(out),
      },
    }
  },
})

async function doAction(input: z.infer<typeof parameters>, signal: AbortSignal) {
  return run(
    prelude(`
${pick(input)}
if (-not $hit) { throw 'WINDOW_NOT_FOUND' }
if (${input.action === "focus" ? "$true" : "$false"}) {
  [MacawWin]::ShowWindowAsync($hit.MainWindowHandle, 9) | Out-Null
  [MacawWin]::SetForegroundWindow($hit.MainWindowHandle) | Out-Null
}
if (${input.action === "minimize" ? "$true" : "$false"}) {
  [MacawWin]::ShowWindowAsync($hit.MainWindowHandle, 6) | Out-Null
}
if (${input.action === "maximize" ? "$true" : "$false"}) {
  [MacawWin]::ShowWindowAsync($hit.MainWindowHandle, 3) | Out-Null
}
if (${input.action === "close" ? "$true" : "$false"}) {
  $hit.CloseMainWindow() | Out-Null
}
if (${input.action === "resize" ? "$true" : "$false"}) {
  $rect = New-Object RECT
  [MacawWin]::GetWindowRect($hit.MainWindowHandle, [ref]$rect) | Out-Null
  [MacawWin]::MoveWindow($hit.MainWindowHandle, $rect.Left, $rect.Top, ${input.size?.w ?? 0}, ${input.size?.h ?? 0}, $true) | Out-Null
}
$hit.Id
`),
    signal,
  )
}
