import z from "zod"
import { capture } from "./screenshot"
import { Tool } from "./tool"
import { call, resolve, size } from "./ui"

const parameters = z.object({
  question: z.string().min(1),
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
})

export function hidden(input: { capabilities: { input: { image: boolean } } }) {
  return input.capabilities.input.image
}

export const UIVisionTool = Tool.define("ui_vision", {
  description:
    "Use the UI model to describe what is visible on screen. Prefer this when the current main model cannot inspect screenshots directly.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "screenshot",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        question: input.question,
        target: input.target,
      },
    })
    const ui = await resolve(ctx.messages)
    const shot = await capture(input, ctx.abort)
    const box = size(shot)
    const text = await call({
      ui,
      shot,
      abort: ctx.abort,
      system: [
        "You inspect desktop screenshots for another model.",
        "Answer the user's question using only what is visible in the screenshot.",
        "Be concise and factual.",
      ].join("\n"),
      prompt: input.question,
    })
    return {
      title: "UI vision",
      output: text,
      metadata: {
        model: `${ui.model.providerID}/${ui.model.id}`,
        width: box.w,
        height: box.h,
      },
    }
  },
})
