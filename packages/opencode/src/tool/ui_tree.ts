import z from "zod"
import { Tool } from "./tool"
import * as uia from "./uia"
import { json } from "./win"

const parameters = z.object({
  window_title: z.string().optional(),
  include_offscreen: z.boolean().optional(),
  include_decorative: z.boolean().optional(),
  limit: z.number().int().positive().max(800).optional(),
})

export type TreeInput = z.infer<typeof parameters>

const DECORATIVE = new Set(["image", "separator", "text", "pane", "group"])

export function keep(n: uia.Node, opts: { decorative: boolean }) {
  const c = n.ctrl
  if (!c.enabled) return false
  if (opts.decorative) return true
  if (c.patterns.length > 0) return true
  const kind = (c.controlType ?? "").toLowerCase()
  if (!DECORATIVE.has(kind)) return true
  const labelled = (c.name ?? "").trim().length > 0 || (c.automationId ?? "").trim().length > 0
  return labelled
}

function flag(patterns: string[]) {
  const tags: string[] = []
  if (patterns.includes("Invoke")) tags.push("invoke")
  if (patterns.includes("Toggle")) tags.push("toggle")
  if (patterns.includes("Value")) tags.push("value")
  if (patterns.includes("ExpandCollapse")) tags.push("expand")
  if (patterns.includes("SelectionItem")) tags.push("select")
  if (patterns.includes("ScrollItem")) tags.push("scroll")
  return tags.length ? `[${tags.join(",")}]` : ""
}

export type Line = {
  n: number
  depth: number
  text: string
  ctrl: uia.Ctrl
}

export function serialize(nodes: uia.Node[], opts: { decorative?: boolean } = {}) {
  const kept = nodes.filter((n) => keep(n, { decorative: opts.decorative === true }))
  const lines: Line[] = []
  const index = new Map<number, uia.Ctrl>()
  kept.forEach((n, i) => {
    const num = i + 1
    const c = n.ctrl
    const name = (c.name ?? "").trim() || (c.automationId ?? "").trim() || ""
    const quoted = name ? `"${name.replaceAll('"', '\\"')}"` : ""
    const aid = (c.automationId ?? "").trim()
    const pats = flag(c.patterns)
    const off = c.offscreen ? " offscreen" : ""
    const parts = [
      `#${num}`,
      `d${n.depth}`,
      (c.controlType ?? "").trim() || "control",
      quoted,
      pats,
      aid ? `aid=${aid}` : "",
      `rid=${c.runtimeId}`,
      `rect=${c.rect.join(",")}`,
      off,
    ].filter(Boolean)
    const indent = "  ".repeat(n.depth)
    lines.push({
      n: num,
      depth: n.depth,
      text: `${indent}${parts.join(" ")}`,
      ctrl: c,
    })
    index.set(num, c)
  })
  return {
    text: lines.map((l) => l.text).join("\n"),
    lines,
    index,
  }
}

type Cache = { index: Map<number, uia.Ctrl>; title?: string; at: number }
const store = new Map<string, Cache>()
const TTL = 60_000

export function remember(sessionID: string, cache: Omit<Cache, "at">) {
  store.set(sessionID, { ...cache, at: Date.now() })
}

export function recall(sessionID: string) {
  const hit = store.get(sessionID)
  if (!hit) return undefined
  if (Date.now() - hit.at > TTL) {
    store.delete(sessionID)
    return undefined
  }
  return hit
}

export function forget(sessionID: string) {
  store.delete(sessionID)
}

export const UITreeTool = Tool.define("ui_tree", {
  description:
    "Read the Windows UI Automation control tree for a window (or the whole desktop). Returns an indented, numbered list the model can reference by #N when calling `ui_act`.",
  parameters,
  async execute(input, ctx) {
    let nodes: uia.Node[] = []
    try {
      nodes = await uia.tree(
        {
          title: input.window_title,
          limit: input.limit ?? 300,
          includeOffscreen: input.include_offscreen === true,
        },
        ctx.abort,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (input.window_title && /Window not found|not reachable/i.test(msg)) {
        const list =
          (await json<{ title: string }[]>(
            `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object @{Name='title';Expression={$_.MainWindowTitle}} | ConvertTo-Json -Depth 2`,
            ctx.abort,
          ).catch(() => [])) ?? []
        const open = list.map((w) => `"${w.title}"`).join(", ")
        throw new Error(
          `Window "${input.window_title}" not found. Open windows: ${open || "(none visible)"}.`,
        )
      }
      throw err
    }
    const result = serialize(nodes, { decorative: input.include_decorative === true })
    remember(ctx.sessionID, { index: result.index, title: input.window_title })
    const header = input.window_title ? `Window: ${input.window_title}` : "Desktop"
    const body = result.text || "(no visible controls)"
    return {
      title: "UI tree",
      output: `${header}\n${body}`,
      metadata: {
        count: result.lines.length,
        total: nodes.length,
        window: input.window_title ?? "",
        include_offscreen: input.include_offscreen === true,
        include_decorative: input.include_decorative === true,
      },
    }
  },
})
