import { createHash } from "crypto"
import { capture } from "./screenshot"
import { Tool } from "./tool"
import { call, resolve, size, type UIModel } from "./ui"
import * as uia from "./uia"

export type Rect = readonly [number, number, number, number]

export type Candidate = {
  sid: string
  source: "uia" | "visual"
  rect: Rect
  label: string
  controlType: string
  enabled: boolean
  invokable: boolean
  patterns: string[]
  runtimeId?: string
  automationId?: string
  className?: string
}

function visualSid(rect: Rect, label: string) {
  return createHash("sha1").update(`visual|${label.trim().toLowerCase()}|${rect.join(",")}`).digest("hex").slice(0, 12)
}

function mid(rect: Rect) {
  return [Math.round((rect[0] + rect[2]) / 2), Math.round((rect[1] + rect[3]) / 2)] as const
}

export function center(rect: Rect) {
  return mid(rect)
}

export function iou(a: Rect, b: Rect) {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2])
  const y2 = Math.min(a[3], b[3])
  if (x2 <= x1 || y2 <= y1) return 0
  const inter = (x2 - x1) * (y2 - y1)
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1])
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  const union = areaA + areaB - inter
  if (union <= 0) return 0
  return inter / union
}

function ctrlToCandidate(c: uia.Ctrl): Candidate {
  const label = (c.name ?? "").trim() || (c.automationId ?? "").trim() || (c.controlType ?? "").trim() || "control"
  const patterns = c.patterns ?? []
  const invokable = patterns.some((p) => ["Invoke", "Toggle", "SelectionItem", "ExpandCollapse"].includes(p))
  return {
    sid: uia.sid({
      rect: c.rect,
      className: c.className,
      name: c.name,
      automationId: c.automationId,
      controlType: c.controlType,
    }),
    source: "uia",
    rect: c.rect,
    label,
    controlType: (c.controlType ?? "").trim() || "control",
    enabled: c.enabled,
    invokable,
    patterns,
    runtimeId: c.runtimeId,
    automationId: c.automationId ?? undefined,
    className: c.className ?? undefined,
  }
}

export type VisualHit = {
  rect: Rect
  label: string
}

export function merge(ctrls: uia.Ctrl[], visual: VisualHit[], threshold = 0.5): Candidate[] {
  const usable = ctrls.filter((c) => c.enabled && !c.offscreen && c.rect[2] > c.rect[0] && c.rect[3] > c.rect[1])
  const base = usable.map(ctrlToCandidate)
  for (const hit of visual) {
    const covered = base.some((b) => iou(b.rect, hit.rect) >= threshold)
    if (covered) continue
    base.push({
      sid: visualSid(hit.rect, hit.label),
      source: "visual",
      rect: hit.rect,
      label: hit.label || "element",
      controlType: "visual",
      enabled: true,
      invokable: true,
      patterns: [],
    })
  }
  return base
}

const visualSchema = "[{\"bbox_2d\":[x1,y1,x2,y2],\"label\":\"short label\"}]"

export async function collectVisual(
  input: { target: "screen" | "window" | "region"; window_title?: string; region?: { x: number; y: number; w: number; h: number } },
  ctx: Tool.Context,
  ui: UIModel,
): Promise<{ shot: string; box: { w: number; h: number }; hits: VisualHit[] }> {
  const shot = await capture(input, ctx.abort)
  const box = size(shot)
  const text = await call({
    ui,
    shot,
    abort: ctx.abort,
    format: "json",
    system: [
      "You are a GUI element enumerator.",
      "List the distinct interactive UI targets visible in the screenshot (buttons, tabs, links, icons, editable fields).",
      `Return JSON array only in this shape: ${visualSchema}.`,
      "Use integer pixel coordinates. Cap the list at 40 items. Omit pure decorations.",
    ].join("\n"),
    prompt: "Enumerate the interactive UI targets in this screenshot.",
  })
  const hits = parseVisual(text)
  return { shot, box, hits }
}

export function parseVisual(text: string): VisualHit[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const match = trimmed.startsWith("[") ? trimmed : trimmed.match(/\[[\s\S]*\]/)?.[0]
  const raw = JSON.parse(match ?? trimmed)
  const list = Array.isArray(raw) ? raw : [raw]
  const out: VisualHit[] = []
  for (const item of list) {
    const bbox = item?.bbox_2d ?? item?.bbox
    if (!Array.isArray(bbox) || bbox.length < 4) continue
    const rect = [
      Math.round(Number(bbox[0])),
      Math.round(Number(bbox[1])),
      Math.round(Number(bbox[2])),
      Math.round(Number(bbox[3])),
    ] as Rect
    if (rect.some((n) => !Number.isFinite(n))) continue
    if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue
    out.push({ rect, label: String(item?.label ?? "").trim() || "element" })
  }
  return out
}

export type DiscoverInput = {
  target: "screen" | "window" | "region"
  window_title?: string
  region?: { x: number; y: number; w: number; h: number }
  limit?: number
  uiaOnly?: boolean
  visualOnly?: boolean
}

export async function discover(input: DiscoverInput, ctx: Tool.Context, ui: UIModel) {
  const ctrls = input.visualOnly ? [] : await uia.enumerate({ title: input.window_title, limit: input.limit ?? 400 }, ctx.abort).catch(() => [] as uia.Ctrl[])
  const visual = input.uiaOnly
    ? { shot: await capture(input, ctx.abort), box: { w: 0, h: 0 }, hits: [] as VisualHit[] }
    : await collectVisual(input, ctx, ui)
  return {
    shot: visual.shot,
    box: visual.box,
    candidates: merge(ctrls, visual.hits),
    ctrls,
  }
}

export function pick(candidates: Candidate[], instruction: string) {
  const query = instruction.trim().toLowerCase()
  if (!candidates.length) return undefined
  const scored = candidates.map((c) => {
    const label = c.label.toLowerCase()
    const auto = (c.automationId ?? "").toLowerCase()
    const type = c.controlType.toLowerCase()
    let text = 0
    if (label && query.includes(label)) text += 3
    if (label && label.includes(query)) text += 3
    if (auto && query.includes(auto)) text += 2
    if (type && query.includes(type)) text += 1
    const bonus = text > 0 && c.source === "uia" && c.invokable ? 0.5 : 0
    return { c, score: text + bonus, text }
  })
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.text === 0) return undefined
  return best.c
}
