import z from "zod"
import { Tool } from "./tool"
import { prelude } from "./win"
import { run } from "./win"

const parameters = z.object({
  action: z.enum(["click", "double_click", "right_click", "move", "drag"]),
  x: z.number().int(),
  y: z.number().int(),
  to_x: z.number().int().optional(),
  to_y: z.number().int().optional(),
  silent: z.boolean().optional(),
})

export type MouseInput = z.infer<typeof parameters>

function wrap(body: string, input: MouseInput) {
  const silent = input.silent === true && input.action !== "move" && input.action !== "drag"
  if (!silent) return prelude(body)
  return prelude(`
$pt = New-Object POINT
[MacawWin]::GetCursorPos([ref]$pt) | Out-Null
${body}
Start-Sleep -Milliseconds 50
[MacawWin]::SetCursorPos($pt.X, $pt.Y) | Out-Null
`)
}

export function script(input: MouseInput) {
  const start = `[MacawWin]::SetCursorPos(${input.x}, ${input.y}) | Out-Null`
  if (input.action === "move") {
    return prelude(start)
  }
  if (input.action === "drag") {
    if (input.to_x === undefined || input.to_y === undefined) throw new Error("drag requires to_x and to_y")
    return prelude(`
${start}
[MacawWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[MacawWin]::SetCursorPos(${input.to_x}, ${input.to_y}) | Out-Null
Start-Sleep -Milliseconds 120
[MacawWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
`)
  }
  if (input.action === "right_click") {
    return wrap(
      `
${start}
[MacawWin]::mouse_event(8, 0, 0, 0, [UIntPtr]::Zero)
[MacawWin]::mouse_event(16, 0, 0, 0, [UIntPtr]::Zero)
`,
      input,
    )
  }
  if (input.action === "double_click") {
    return wrap(
      `
${start}
[MacawWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[MacawWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[MacawWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[MacawWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
`,
      input,
    )
  }
  return wrap(
    `
${start}
[MacawWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[MacawWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
`,
    input,
  )
}

export const MouseTool = Tool.define("mouse", {
  description: "Move, click, right-click, or drag the mouse.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "mouse",
      patterns: ["*"],
      always: ["*"],
      metadata: input,
    })
    await run(script(input), ctx.abort)
    const silent = input.silent === true && input.action !== "move" && input.action !== "drag"
    return {
      title: `Mouse: ${input.action}`,
      output:
        input.action === "drag"
          ? `Dragged from (${input.x}, ${input.y}) to (${input.to_x}, ${input.to_y}).`
          : `${input.action.replaceAll("_", " ")} at (${input.x}, ${input.y})${silent ? " silently" : ""}.`,
      metadata: {
        action: input.action,
        silent,
      },
    }
  },
})
