import z from "zod"
import { Tool } from "./tool"
import { json, ps, run } from "./win"

const parameters = z.object({
  action: z.enum(["launch", "list_running", "kill"]),
  name: z.string().optional(),
  path: z.string().optional(),
  args: z.array(z.string()).optional(),
  pid: z.number().int().optional(),
  wait_for_window: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
})

type Proc = {
  Id: number
  ProcessName: string
  MainWindowTitle?: string
}

type Launched = {
  pid: number
  window_title: string
  ready: boolean
}

function list(args?: string[]) {
  if (!args?.length) return "@()"
  return `@(${args.map((item) => `'${ps(item)}'`).join(",")})`
}

export const AppTool = Tool.define("app", {
  description: "Launch apps, list running apps, or terminate a process.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "app",
      patterns: ["*"],
      always: ["*"],
      metadata: input,
    })
    if (input.action === "list_running") {
      const data = (await json<Proc[]>(
        `Get-Process | Sort-Object ProcessName | Select-Object -First 200 Id, ProcessName, MainWindowTitle | ConvertTo-Json -Depth 3`,
        ctx.abort,
      )) ?? []
      return {
        title: "Running apps",
        output: JSON.stringify(data, null, 2),
        metadata: {
          count: data.length,
          pid: 0,
          action: "list_running",
          window_title: "" as string,
          ready: false as boolean,
        },
      }
    }
    if (input.action === "launch") {
      const file = input.path ?? input.name
      if (!file) throw new Error("path or name is required when action is launch")
      const wait = input.wait_for_window !== false
      const timeout = Math.max(500, input.timeout_ms ?? 15000)
      const script = wait
        ? `
$p = Start-Process -FilePath '${ps(file)}' -ArgumentList ${list(input.args)} -PassThru
$deadline = (Get-Date).AddMilliseconds(${timeout})
$title = ''
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $proc = Get-Process -Id $p.Id -ErrorAction Stop
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne 0 -and $proc.MainWindowTitle) {
      $title = $proc.MainWindowTitle
      $ready = $true
      break
    }
  } catch { break }
  Start-Sleep -Milliseconds 200
}
[pscustomobject]@{ pid = $p.Id; window_title = $title; ready = $ready } | ConvertTo-Json -Compress
`
        : `$p = Start-Process -FilePath '${ps(file)}' -ArgumentList ${list(input.args)} -PassThru; [pscustomobject]@{ pid = $p.Id; window_title = ''; ready = $false } | ConvertTo-Json -Compress`
      const out = await run(script, ctx.abort)
      const data = JSON.parse(out) as Launched
      const summary = data.ready
        ? `Started ${file} with PID ${data.pid}. Window: "${data.window_title}".`
        : `Started ${file} with PID ${data.pid}. Window not yet visible after ${timeout}ms; use window list to confirm.`
      return {
        title: "Launch app",
        output: summary,
        metadata: {
          count: 1,
          pid: data.pid,
          action: "launch",
          window_title: data.window_title,
          ready: data.ready,
        },
      }
    }
    const target = input.pid ? `-Id ${input.pid}` : input.name ? `-Name '${ps(input.name)}'` : ""
    if (!target) throw new Error("pid or name is required when action is kill")
    await run(`Stop-Process ${target} -Force`, ctx.abort)
    return {
      title: "Kill app",
      output: input.pid ? `Stopped PID ${input.pid}.` : `Stopped ${input.name}.`,
      metadata: {
        count: 1,
        pid: input.pid ?? 0,
        action: "kill",
        window_title: "" as string,
        ready: false as boolean,
      },
    }
  },
})
