import type { Candidate } from "./discover"
import { center } from "./discover"
import { script as keyScript } from "./keyboard"
import { script as mouseScript } from "./mouse"
import type { Tool } from "./tool"
import * as uia from "./uia"
import { prelude, ps, run } from "./win"

export type ActKind = "activate" | "type"

export type ActResult = {
  rung: "uia_invoke" | "uia_setvalue" | "uia_toggle" | "mouse_silent" | "keyboard"
  cursorMoved: boolean
}

const HIGH_RISK = /\b(submit|delete|remove|close|send|post|publish|save|confirm|purchase|buy|pay|ok|yes|sign\s*in|sign\s*out|log\s*out|install|uninstall)\b/i

export function risk(c: Candidate, kind: ActKind, text?: string): "low" | "high" {
  const body = `${c.label} ${c.automationId ?? ""} ${text ?? ""}`
  if (HIGH_RISK.test(body)) return "high"
  if (kind === "type" && (text?.length ?? 0) > 40) return "high"
  return "low"
}

export function focusScript(title: string) {
  return prelude(`
$hit = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${ps(title)}*' } | Select-Object -First 1
if ($hit) {
  [MacawWin]::ShowWindowAsync($hit.MainWindowHandle, 9) | Out-Null
  [MacawWin]::SetForegroundWindow($hit.MainWindowHandle) | Out-Null
}
`)
}

export async function focus(title: string | undefined, signal?: AbortSignal) {
  if (!title) return
  await run(focusScript(title), signal).catch(() => undefined)
}

export async function activate(
  c: Candidate,
  ctx: Tool.Context,
  opts: { title?: string } = {},
): Promise<ActResult> {
  await focus(opts.title, ctx.abort)
  if (c.source === "uia" && c.runtimeId) {
    if (c.patterns.includes("Invoke")) {
      await uia.invoke({ runtimeId: c.runtimeId, title: opts.title }, ctx.abort)
      return { rung: "uia_invoke", cursorMoved: false }
    }
    if (c.patterns.includes("Toggle")) {
      await uia.toggle({ runtimeId: c.runtimeId, title: opts.title }, ctx.abort)
      return { rung: "uia_toggle", cursorMoved: false }
    }
    if (c.patterns.includes("SelectionItem") || c.patterns.includes("ExpandCollapse")) {
      await uia.invoke({ runtimeId: c.runtimeId, title: opts.title }, ctx.abort)
      return { rung: "uia_invoke", cursorMoved: false }
    }
  }
  const [x, y] = center(c.rect)
  await run(mouseScript({ action: "click", x, y, silent: true }), ctx.abort)
  return { rung: "mouse_silent", cursorMoved: false }
}

export async function write(
  c: Candidate,
  text: string,
  ctx: Tool.Context,
  opts: { title?: string } = {},
): Promise<ActResult> {
  await focus(opts.title, ctx.abort)
  if (c.source === "uia" && c.runtimeId && c.patterns.includes("Value")) {
    await uia.setValue({ runtimeId: c.runtimeId, value: text, title: opts.title }, ctx.abort)
    return { rung: "uia_setvalue", cursorMoved: false }
  }
  const [x, y] = center(c.rect)
  await run(mouseScript({ action: "click", x, y, silent: true }), ctx.abort)
  await Bun.sleep(80)
  await run(keyScript({ action: "type", text }), ctx.abort)
  return { rung: "keyboard", cursorMoved: false }
}
