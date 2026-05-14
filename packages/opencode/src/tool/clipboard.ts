import z from "zod"
import { Tool } from "./tool"
import { ps, run } from "./win"

const parameters = z.object({
  action: z.enum(["read", "write"]),
  text: z.string().optional(),
})

export const ClipboardTool = Tool.define("clipboard", {
  description: "Read from or write text to the clipboard.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "clipboard",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        action: input.action,
      },
    })
    if (input.action === "read") {
      const out = await run(`Get-Clipboard -Raw`, ctx.abort)
      return {
        title: "Clipboard",
        output: out || "Clipboard is empty.",
        metadata: {
          action: "read",
        },
      }
    }
    if (!input.text) throw new Error("text is required when action is write")
    await run(`Set-Clipboard -Value '${ps(input.text)}'`, ctx.abort)
    return {
      title: "Clipboard",
      output: `Copied ${input.text.length} characters to the clipboard.`,
      metadata: {
        action: "write",
      },
    }
  },
})
