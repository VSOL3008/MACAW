import z from "zod"
import { Tool } from "./tool"
import { recall } from "./ui_tree"
import * as uia from "./uia"

const selector = z.object({
  name: z.string().optional(),
  automation_id: z.string().optional(),
  control_type: z.string().optional(),
  class_name: z.string().optional(),
})

export type Selector = z.infer<typeof selector>

const parameters = z.object({
  target: z.union([z.number().int().positive(), selector]),
  action: z.enum(["invoke", "toggle", "select", "expand", "collapse", "set_value", "focus"]),
  value: z.string().optional(),
  window_title: z.string().optional(),
})

export type ActInput = z.infer<typeof parameters>

export function score(c: uia.Ctrl, sel: Selector) {
  let s = 0
  const name = (c.name ?? "").toLowerCase().trim()
  const aid = (c.automationId ?? "").toLowerCase().trim()
  const cls = (c.className ?? "").toLowerCase().trim()
  const ctype = (c.controlType ?? "").toLowerCase().trim()
  if (sel.name) {
    const q = sel.name.toLowerCase().trim()
    if (name === q) s += 10
    else if (name.includes(q)) s += 5
    else if (q.includes(name) && name.length > 2) s += 3
    else return 0
  }
  if (sel.automation_id) {
    const q = sel.automation_id.toLowerCase().trim()
    if (aid === q) s += 8
    else return 0
  }
  if (sel.control_type) {
    const q = sel.control_type.toLowerCase().trim()
    if (ctype === q) s += 2
    else if (ctype.includes(q)) s += 1
    else return 0
  }
  if (sel.class_name) {
    const q = sel.class_name.toLowerCase().trim()
    if (cls === q) s += 2
    else if (cls.includes(q)) s += 1
    else return 0
  }
  return s
}

export function resolve(ctrls: uia.Ctrl[], sel: Selector) {
  const scored = ctrls
    .map((c) => ({ c, s: score(c, sel) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  return scored[0]?.c
}

function required(input: ActInput) {
  if (input.action === "set_value" && input.value === undefined) {
    throw new Error("ui_act set_value requires `value`.")
  }
  if (typeof input.target !== "number") {
    const sel = input.target
    if (!sel.name && !sel.automation_id && !sel.class_name && !sel.control_type) {
      throw new Error("ui_act selector needs at least one of name/automation_id/class_name/control_type.")
    }
  }
}

async function locate(input: ActInput, sessionID: string, signal?: AbortSignal) {
  if (typeof input.target === "number") {
    const cache = recall(sessionID)
    const hit = cache?.index.get(input.target)
    if (!hit) {
      throw new Error(
        `ui_act target #${input.target} is not known. Call ui_tree first so the index is fresh.`,
      )
    }
    return { ctrl: hit, title: cache?.title ?? input.window_title }
  }
  const ctrls = await uia.enumerate({ title: input.window_title, limit: 600 }, signal)
  const hit = resolve(ctrls, input.target)
  if (!hit) {
    throw new Error("ui_act could not find a control matching the selector.")
  }
  return { ctrl: hit, title: input.window_title }
}

async function snapshot(rid: string, title: string | undefined, signal?: AbortSignal) {
  return uia.query({ runtimeId: rid, title }, signal).catch(() => undefined)
}

function summary(input: { rung: string; label: string; kind: string; before?: uia.State; after?: uia.State }) {
  const bits = [`${input.rung} ${input.kind || "control"} "${input.label || ""}".`]
  if (input.before && input.after) {
    if (input.before.toggle !== input.after.toggle) bits.push(`toggle ${input.before.toggle ?? "-"} -> ${input.after.toggle ?? "-"}.`)
    if ((input.before.value ?? "") !== (input.after.value ?? ""))
      bits.push(`value "${input.before.value ?? ""}" -> "${input.after.value ?? ""}".`)
    if (input.before.selected !== input.after.selected)
      bits.push(`selected ${String(input.before.selected)} -> ${String(input.after.selected)}.`)
  }
  return bits.join(" ")
}

export const UIActTool = Tool.define("ui_act", {
  description:
    "Act on a Windows UI Automation control by #N (from ui_tree) or by selector. Actions: invoke, toggle, select, expand, collapse, set_value, focus. No cursor movement, no screenshots.",
  parameters,
  async execute(input, ctx) {
    required(input)
    await ctx.ask({
      permission: "mouse",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        action: input.action,
        target: input.target,
        window: input.window_title,
        silent: true,
      },
    })
    if (input.action === "set_value") {
      await ctx.ask({
        permission: "keyboard",
        patterns: ["*"],
        always: ["*"],
        metadata: { action: "set_value", value: input.value },
      })
    }

    const found = await locate(input, ctx.sessionID, ctx.abort)
    const title = found.title
    const c = found.ctrl
    const before = await snapshot(c.runtimeId, title, ctx.abort)

    if (input.action === "invoke") {
      if (!c.patterns.includes("Invoke")) {
        throw new Error(`Control "${c.name ?? c.automationId ?? c.runtimeId}" does not support invoke.`)
      }
      await uia.invoke({ runtimeId: c.runtimeId, title }, ctx.abort)
    } else if (input.action === "toggle") {
      if (!c.patterns.includes("Toggle")) {
        throw new Error("Control does not support toggle.")
      }
      await uia.toggle({ runtimeId: c.runtimeId, title }, ctx.abort)
    } else if (input.action === "select") {
      if (!c.patterns.includes("SelectionItem")) {
        throw new Error("Control does not support select.")
      }
      await uia.select({ runtimeId: c.runtimeId, title }, ctx.abort)
    } else if (input.action === "expand" || input.action === "collapse") {
      if (!c.patterns.includes("ExpandCollapse")) {
        throw new Error("Control does not support expand/collapse.")
      }
      await uia.expand({ runtimeId: c.runtimeId, title, collapse: input.action === "collapse" }, ctx.abort)
    } else if (input.action === "set_value") {
      if (!c.patterns.includes("Value")) {
        throw new Error("Control does not support set_value.")
      }
      await uia.setValue({ runtimeId: c.runtimeId, value: input.value!, title }, ctx.abort)
    } else if (input.action === "focus") {
      await uia.focus({ runtimeId: c.runtimeId, title }, ctx.abort)
    }

    const after = await snapshot(c.runtimeId, title, ctx.abort)
    const rung = input.action === "invoke" ? "Invoked" : input.action === "set_value" ? "Set" : capitalize(input.action)
    const out = summary({
      rung,
      label: c.name ?? c.automationId ?? "",
      kind: c.controlType ?? "",
      before,
      after,
    })
    return {
      title: "UI act",
      output: out,
      metadata: {
        action: input.action,
        runtime_id: c.runtimeId,
        control_type: c.controlType ?? "",
        name: c.name ?? "",
        automation_id: c.automationId ?? "",
        window: title ?? "",
        before_toggle: before?.toggle ?? null,
        after_toggle: after?.toggle ?? null,
        before_value: before?.value ?? null,
        after_value: after?.value ?? null,
        before_selected: before?.selected ?? null,
        after_selected: after?.selected ?? null,
      },
    }
  },
})

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
