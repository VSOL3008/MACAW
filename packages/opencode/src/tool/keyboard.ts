import z from "zod"
import { Tool } from "./tool"
import { prelude, run } from "./win"

const parameters = z.object({
  action: z.enum(["type", "press", "hotkey"]),
  text: z.string().optional(),
  key: z.string().optional(),
  modifiers: z.array(z.string()).optional(),
})

export type KeyboardInput = z.infer<typeof parameters>

const KEY: Record<string, string> = {
  enter: "{ENTER}",
  tab: "{TAB}",
  esc: "{ESC}",
  escape: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  space: " ",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
}

function escape(text: string) {
  return text.replace(/[+^%~(){}\[\]]/g, (part) => `{${part}}`)
}

function key(name: string) {
  const lower = name.toLowerCase()
  if (KEY[lower]) return KEY[lower]
  if (/^f\d{1,2}$/.test(lower)) return `{${lower.toUpperCase()}}`
  if (lower.length === 1) return escape(lower)
  return `{${lower.toUpperCase()}}`
}

function body(input: KeyboardInput) {
  if (input.action === "type") {
    if (!input.text) throw new Error("text is required when action is type")
    return escape(input.text)
  }
  if (!input.key) throw new Error("key is required when action is press or hotkey")
  const mods = (input.modifiers ?? []).map((item) => item.toLowerCase())
  const prefix = [
    mods.includes("ctrl") || mods.includes("control") ? "^" : "",
    mods.includes("alt") ? "%" : "",
    mods.includes("shift") ? "+" : "",
  ].join("")
  return `${prefix}${key(input.key)}`
}

export function script(input: KeyboardInput) {
  return prelude(`
$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys('${body(input)}')
`)
}

export const KeyboardTool = Tool.define("keyboard", {
  description: "Type text, press keys, or send keyboard shortcuts.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "keyboard",
      patterns: ["*"],
      always: ["*"],
      metadata: input,
    })
    await run(script(input), ctx.abort)
    return {
      title: `Keyboard: ${input.action}`,
      output:
        input.action === "type"
          ? `Typed ${input.text?.length ?? 0} characters.`
          : `Sent ${input.action === "press" ? "key" : "hotkey"} ${input.key}.`,
      metadata: {
        action: input.action,
      },
    }
  },
})
