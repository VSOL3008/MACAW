import z from "zod"
import { activate, risk as actRisk } from "./act"
import type { Candidate } from "./discover"
import { center, discover, pick } from "./discover"
import { capture } from "./screenshot"
import { Tool } from "./tool"
import { call, resolve, size, type UIModel } from "./ui"
import * as uia from "./uia"
import { verify as verifyStep } from "./verify"

const parameters = z.object({
  instruction: z.string().min(1),
  target: z.enum(["screen", "window", "region"]).default("screen"),
  window_title: z.string().optional(),
  region: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    })
    .optional(),
  click: z.boolean().optional(),
  verify: z.boolean().optional(),
  retries: z.number().int().min(0).max(3).optional(),
})

const output = z.object({
  bbox_2d: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  coordinate: z.tuple([z.number(), z.number()]).optional(),
  label: z.string().optional(),
})

const check = z.object({
  success: z.boolean(),
  state: z.string().optional(),
})

export type GroundInput = z.infer<typeof parameters>

function scan<T>(text: string, schema: z.ZodSchema<T>) {
  const list = [text.trim(), ...(text.match(/\{[\s\S]*\}/g) ?? [])]
  for (const item of list) {
    try {
      const parsed = schema.safeParse(JSON.parse(item))
      if (parsed.success) return parsed.data
    } catch {}
  }
  throw new Error(`Could not parse UI JSON response: ${text}`)
}

function point(coord: [number, number], box: { w: number; h: number }) {
  if (coord[0] <= 1 && coord[1] <= 1) {
    return [Math.round(coord[0] * box.w), Math.round(coord[1] * box.h)] as const
  }
  return [Math.round(coord[0]), Math.round(coord[1])] as const
}

export function parse(input: { text: string; w: number; h: number }) {
  const data = scan(input.text, output)
  if (data.bbox_2d) {
    const bbox = data.bbox_2d.map((item) => Math.round(item)) as [number, number, number, number]
    return {
      bbox,
      point: [Math.round((bbox[0] + bbox[2]) / 2), Math.round((bbox[1] + bbox[3]) / 2)] as const,
      label: data.label?.trim(),
    }
  }
  if (data.coordinate) {
    return {
      point: point(data.coordinate, { w: input.w, h: input.h }),
      label: data.label?.trim(),
    }
  }
  throw new Error(`ui_ground response did not include bbox_2d or coordinate: ${input.text}`)
}

export function verify(input: { text: string }) {
  const data = scan(input.text, check)
  return {
    success: data.success,
    state: data.state?.trim() ?? "",
  }
}

async function locate(input: GroundInput, ctx: Tool.Context, ui: UIModel): Promise<{
  shot: string
  box: { w: number; h: number }
  candidate: Candidate
}> {
  const found = await discover(
    {
      target: input.target,
      window_title: input.window_title,
      region: input.region,
    },
    ctx,
    ui,
  )
  const hit = pick(found.candidates, input.instruction)
  if (hit) return { shot: found.shot, box: found.box, candidate: hit }

  const text = await call({
    ui,
    shot: found.shot,
    abort: ctx.abort,
    format: "json",
    system: [
      "You are a GUI grounding agent.",
      "Given one screenshot and the user's instruction, locate the best matching UI element.",
      'Return JSON only in this shape: {"bbox_2d":[x1,y1,x2,y2],"label":"short label"}.',
      "Use integer pixel coordinates relative to the provided screenshot.",
    ].join("\n"),
    prompt: input.instruction,
  })
  const parsed = parse({ text, w: found.box.w, h: found.box.h })
  const rect = (parsed.bbox ?? [parsed.point[0] - 10, parsed.point[1] - 10, parsed.point[0] + 10, parsed.point[1] + 10]) as Candidate["rect"]
  return {
    shot: found.shot,
    box: found.box,
    candidate: {
      sid: `visual:${rect.join(",")}`,
      source: "visual",
      rect,
      label: parsed.label ?? "target",
      controlType: "visual",
      enabled: true,
      invokable: true,
      patterns: [],
    },
  }
}

export async function ground(input: GroundInput, ctx: Tool.Context) {
  await ctx.ask({
    permission: "screenshot",
    patterns: ["*"],
    always: ["*"],
    metadata: {
      instruction: input.instruction,
      target: input.target,
    },
  })

  const ui = await resolve(ctx.messages)
  const click = input.click === true
  const verifyClick = click && input.verify !== false
  const retries = Math.min(Math.max(input.retries ?? 1, 0), 3)

  if (click) {
    await ctx.ask({
      permission: "mouse",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        action: "click",
        target: input.instruction,
        silent: true,
      },
    })
  }

  let last = ""
  let item: Awaited<ReturnType<typeof locate>> | undefined
  for (let idx = 0; idx <= retries; idx++) {
    item = await locate(input, ctx, ui)
    const hit = item.candidate
    const [cx, cy] = center(hit.rect)
    ctx.metadata({
      title: click ? "UI ground: click" : "UI ground",
      metadata: {
        x: cx,
        y: cy,
        bbox: hit.rect,
        label: hit.label,
        source: hit.source,
        sid: hit.sid,
        attempts: idx + 1,
      },
    })

    if (!click) {
      return {
        title: "UI ground",
        output: `Found ${hit.label || "target"} at (${cx}, ${cy}) with bbox [${hit.rect.join(", ")}] via ${hit.source}.`,
        metadata: {
          x: cx,
          y: cy,
          bbox: hit.rect as readonly number[],
          label: hit.label,
          source: hit.source,
          sid: hit.sid,
          model: `${ui.model.providerID}/${ui.model.id}`,
          width: item.box.w,
          height: item.box.h,
          verified: false,
          attempts: idx + 1,
          state: "",
          rung: undefined as string | undefined,
          diff: undefined as { local: number; global: number } | undefined,
        },
      }
    }

    const before = item.shot
    const snapshot = hit.source === "uia" && hit.runtimeId
      ? await uia.query({ runtimeId: hit.runtimeId, title: input.window_title }, ctx.abort).catch(() => undefined)
      : undefined
    const action = await activate(hit, ctx, { title: input.window_title })
    await Bun.sleep(220)

    if (!verifyClick) {
      return {
        title: "UI ground",
        output: `Clicked ${hit.label || "target"} at (${cx}, ${cy}) via ${action.rung} without visual verification.`,
        metadata: {
          x: cx,
          y: cy,
          bbox: hit.rect as readonly number[],
          label: hit.label,
          source: hit.source,
          sid: hit.sid,
          rung: action.rung as string | undefined,
          model: `${ui.model.providerID}/${ui.model.id}`,
          width: item.box.w,
          height: item.box.h,
          verified: false,
          attempts: idx + 1,
          state: "",
          diff: undefined as { local: number; global: number } | undefined,
        },
      }
    }

    const after = await capture({ target: input.target, window_title: input.window_title, region: input.region }, ctx.abort)
    const v = await verifyStep({
      before,
      after,
      candidate: hit,
      risk: actRisk(hit, "activate"),
      expectation: input.instruction,
      ui,
      ctx,
      windowTitle: input.window_title,
      snapshot,
    })
    last = v.reason
    if (v.success) {
      return {
        title: "UI ground",
        output: `Clicked ${hit.label || "target"} at (${cx}, ${cy}) via ${action.rung}. ${v.reason}`.trim(),
        metadata: {
          x: cx,
          y: cy,
          bbox: hit.rect as readonly number[],
          label: hit.label,
          source: hit.source,
          sid: hit.sid,
          rung: action.rung as string | undefined,
          model: `${ui.model.providerID}/${ui.model.id}`,
          width: item.box.w,
          height: item.box.h,
          verified: true,
          attempts: idx + 1,
          state: v.reason,
          diff: v.diff as { local: number; global: number } | undefined,
        },
      }
    }
  }

  if (!item) throw new Error("ui_ground could not capture the target.")
  const hit = item.candidate
  const [cx, cy] = center(hit.rect)
  return {
    title: "UI ground",
    output: `Clicked ${hit.label || "target"} at (${cx}, ${cy}) but could not verify the result after ${retries + 1} attempt(s). Last state: ${last || "unknown"}.`,
    metadata: {
      x: cx,
      y: cy,
      bbox: hit.rect as readonly number[],
      label: hit.label,
      source: hit.source,
      sid: hit.sid,
      rung: undefined as string | undefined,
      model: `${ui.model.providerID}/${ui.model.id}`,
      width: item.box.w,
      height: item.box.h,
      verified: false,
      attempts: retries + 1,
      state: last,
      diff: undefined as { local: number; global: number } | undefined,
    },
  }
}

export const UIGroundTool = Tool.define("ui_ground", {
  description:
    "Ground a visible UI target and optionally click it. Uses UIA when available (no cursor movement) with silent mouse fallback, plus adaptive verification.",
  parameters,
  async execute(input, ctx) {
    return ground(input, ctx)
  },
})
