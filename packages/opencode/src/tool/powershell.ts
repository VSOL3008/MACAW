import z from "zod"
import { Tool } from "./tool"
import { run } from "./win"

export const parameters = z.object({
  script: z.string().min(1).describe("PowerShell script. Use `$var = ...` freely; no shell interpolation happens."),
  timeout_ms: z.number().int().positive().max(300_000).optional(),
})

export type PSInput = z.infer<typeof parameters>

export const PowerShellTool = Tool.define("powershell", {
  description:
    "Run raw PowerShell. Use this instead of `bash` when you need PowerShell (COM Interop like Outlook.Application, WMI, registry, Office, complex pipelines). The script is passed via -EncodedCommand so `$variables` and quotes are never mangled by any outer shell.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "powershell",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        script: input.script.slice(0, 500),
      },
    })
    const timeout = input.timeout_ms ?? 60_000
    const controller = new AbortController()
    const linked = new AbortController()
    const abort = () => linked.abort()
    ctx.abort.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeout)
    controller.signal.addEventListener("abort", () => linked.abort(), { once: true })
    try {
      const out = await run(input.script, linked.signal)
      return {
        title: "PowerShell",
        output: out || "(no output)",
        metadata: {
          chars: out.length,
          timed_out: false,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (controller.signal.aborted) {
        return {
          title: "PowerShell",
          output: `Script timed out after ${timeout}ms.`,
          metadata: { chars: 0, timed_out: true },
        }
      }
      throw new Error(msg)
    } finally {
      clearTimeout(timer)
      ctx.abort.removeEventListener("abort", abort)
    }
  },
})
