import z from "zod"
import { activate, focus, risk as actRisk, write } from "./act"
import * as board from "./blackboard"
import type { Candidate } from "./discover"
import { discover } from "./discover"
import { script as keyScript } from "./keyboard"
import { capture } from "./screenshot"
import { annotate, describe as describeIndex } from "./som"
import { Tool } from "./tool"
import { call, resolve, type UIModel } from "./ui"
import * as uia from "./uia"
import { verify as verifyStep } from "./verify"
import { run } from "./win"

import PROMPT_DECOMPOSE from "../session/prompt/ui_decompose.txt"
import PROMPT_STEP from "../session/prompt/ui_step.txt"
import PROMPT_CHECK from "../session/prompt/ui_subgoal_check.txt"

const parameters = z.object({
  goal: z.string().min(1),
  max_steps: z.number().int().positive().optional(),
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

const decomposed = z.object({
  subgoals: z
    .array(
      z.object({
        text: z.string().min(1),
        cue: z.string().min(1),
      }),
    )
    .min(1)
    .max(6),
})

const step = z.object({
  done: z.boolean(),
  action: z.enum(["click", "type", "press", "wait"]).optional(),
  target: z.number().int().positive().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  reason: z.string(),
})

const satisfied = z.object({
  satisfied: z.boolean(),
  state: z.string().optional(),
})

export type NavigateInput = z.infer<typeof parameters>

function scan<T>(text: string, schema: z.ZodSchema<T>) {
  const trimmed = text.trim()
  const candidates: string[] = [trimmed]
  const obj = trimmed.match(/\{[\s\S]*\}/)
  if (obj) candidates.push(obj[0])
  for (const item of candidates) {
    try {
      const parsed = schema.safeParse(JSON.parse(item))
      if (parsed.success) return parsed.data
    } catch {}
  }
  throw new Error(`Could not parse response: ${text}`)
}

export function parseDecompose(input: { text: string }) {
  return scan(input.text, decomposed)
}

export function parseStep(input: { text: string }) {
  const data = scan(input.text, step)
  if (data.done) return data
  if (!data.action) throw new Error("step response did not include action.")
  if (data.action === "click" && !data.target) throw new Error("click requires target number.")
  if (data.action === "type" && (!data.text || !data.target)) throw new Error("type requires text and target.")
  if (data.action === "press" && !data.key) throw new Error("press requires key.")
  return data
}

export function parseCheck(input: { text: string }) {
  return scan(input.text, satisfied)
}

// legacy export kept to avoid breaking older tests / callers
export function parse(input: { text: string }) {
  const legacy = z.object({
    done: z.boolean(),
    action: z.enum(["click", "type", "press", "scroll", "wait"]).optional(),
    target: z.string().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    reason: z.string(),
  })
  const data = scan(input.text, legacy)
  if (data.done) return data
  if (!data.action) throw new Error("response did not include action.")
  if (data.action === "click" && !data.target) throw new Error("click requires a target.")
  if (data.action === "type" && !data.text) throw new Error("type requires text.")
  if ((data.action === "press" || data.action === "scroll") && !data.key) {
    throw new Error("press and scroll actions require key.")
  }
  return data
}

async function decomposeGoal(input: { goal: string; ui: UIModel; ctx: Tool.Context; target: NavigateInput["target"]; window_title?: string; region?: NavigateInput["region"] }) {
  const shot = await capture({ target: input.target, window_title: input.window_title, region: input.region }, input.ctx.abort)
  const text = await call({
    ui: input.ui,
    shot,
    abort: input.ctx.abort,
    format: "json",
    system: PROMPT_DECOMPOSE,
    prompt: `Goal: ${input.goal}`,
  })
  return parseDecompose({ text })
}

function history(steps: board.Step[]) {
  if (!steps.length) return "none"
  return steps.map((s) => `${s.step}. ${s.action} sid=${s.sid ?? "-"} verified=${s.verified} state=${s.state}`).join("\n")
}

function filterCandidates(list: Candidate[], stale: Set<string>) {
  return list.filter((c) => !stale.has(c.sid))
}

async function planStep(input: {
  subgoal: board.Subgoal
  board: board.Board
  ui: UIModel
  ctx: Tool.Context
  shot: string
  index: Map<number, Candidate>
}) {
  const text = await call({
    ui: input.ui,
    shot: input.shot,
    abort: input.ctx.abort,
    format: "json",
    system: PROMPT_STEP,
    prompt: [
      `Subgoal: ${input.subgoal.text}`,
      `Cue: ${input.subgoal.cue}`,
      `Goal: ${input.board.goal}`,
      `Stale numbers: ${Array.from(input.index.entries()).filter(([, c]) => input.board.stale.has(c.sid)).map(([n]) => n).join(", ") || "none"}`,
      `Candidates:\n${describeIndex(input.index)}`,
      `Recent steps:\n${history(board.tail(input.board, 5))}`,
    ].join("\n\n"),
  })
  return parseStep({ text })
}

async function checkSubgoal(input: { subgoal: board.Subgoal; ui: UIModel; ctx: Tool.Context; shot: string; board: board.Board }) {
  const text = await call({
    ui: input.ui,
    shot: input.shot,
    abort: input.ctx.abort,
    format: "json",
    system: PROMPT_CHECK,
    prompt: [
      `Goal: ${input.board.goal}`,
      `Subgoal: ${input.subgoal.text}`,
      `Cue: ${input.subgoal.cue}`,
    ].join("\n"),
  })
  return parseCheck({ text })
}

export const UINavigateTool = Tool.define("ui_navigate", {
  description:
    "Navigate a visible desktop UI toward a goal. Decomposes the goal into subgoals, uses UIA + vision fusion per step, prefers silent UIA activation, and verifies with region diff before escalating to the UI model.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "screenshot",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        goal: input.goal,
        target: input.target,
      },
    })
    await ctx.ask({
      permission: "mouse",
      patterns: ["*"],
      always: ["*"],
      metadata: { action: "click", target: input.goal, silent: true },
    })
    await ctx.ask({
      permission: "keyboard",
      patterns: ["*"],
      always: ["*"],
      metadata: { action: "type", goal: input.goal },
    })

    const ui = await resolve(ctx.messages)
    const max = input.max_steps ?? 10
    const existing = board.get(ctx.sessionID)
    const state =
      existing && existing.goal === input.goal
        ? existing
        : board.create(
            ctx.sessionID,
            input.goal,
            (
              await decomposeGoal({
                goal: input.goal,
                ui,
                ctx,
                target: input.target,
                window_title: input.window_title,
                region: input.region,
              })
            ).subgoals.map((s) => ({ ...s, done: false })),
          )

    await focus(input.window_title, ctx.abort)

    let used = 0
    while (used < max && !board.done(state)) {
      const sub = board.current(state)
      if (!sub) break
      used += 1

      const pre = await capture({ target: input.target, window_title: input.window_title, region: input.region }, ctx.abort)
      const found = await discover(
        {
          target: input.target,
          window_title: input.window_title,
          region: input.region,
        },
        ctx,
        ui,
      )
      const live = filterCandidates(found.candidates, state.stale)
      const marked = await annotate(found.shot, live, ctx.abort)

      const plan = await planStep({
        subgoal: sub,
        board: state,
        ui,
        ctx,
        shot: marked.shot,
        index: marked.index,
      })

      ctx.metadata({
        title: "UI navigate",
        metadata: {
          step: used,
          subgoal: sub.text,
          cue: sub.cue,
          action: plan.action ?? (plan.done ? "done" : "?"),
          target: plan.target,
          stuck: state.stuck,
        },
      })

      if (plan.done) {
        const check = await checkSubgoal({ subgoal: sub, ui, ctx, shot: marked.shot, board: state })
        if (check.satisfied) {
          board.record(state, { action: "check", verified: true, state: check.state ?? "" })
          board.advance(state)
          continue
        }
        board.record(state, { action: "check", verified: false, state: check.state ?? "unsatisfied" })
        state.stuck += 1
        if (state.stuck >= 2) await run(keyScript({ action: "press", key: "esc" }), ctx.abort).catch(() => undefined)
        continue
      }

      const cand = plan.target ? marked.index.get(plan.target) : undefined
      if (!cand) {
        board.record(state, { action: plan.action ?? "wait", verified: false, state: "target missing" })
        state.stuck += 1
        continue
      }

      if (plan.action === "click") {
        const snap = cand.source === "uia" && cand.runtimeId
          ? await uia.query({ runtimeId: cand.runtimeId, title: input.window_title }, ctx.abort).catch(() => undefined)
          : undefined
        const act = await activate(cand, ctx, { title: input.window_title })
        await Bun.sleep(220)
        const after = await capture({ target: input.target, window_title: input.window_title, region: input.region }, ctx.abort)
        const v = await verifyStep({
          before: pre,
          after,
          candidate: cand,
          risk: actRisk(cand, "activate"),
          expectation: sub.cue,
          ui,
          ctx,
          windowTitle: input.window_title,
          snapshot: snap,
        })
        board.record(state, {
          action: `click:${act.rung}`,
          sid: cand.sid,
          label: cand.label,
          verified: v.success,
          state: v.reason,
        })
        if (!v.success) {
          if (state.stuck >= 2) {
            board.markStale(state, cand.sid)
            await run(keyScript({ action: "press", key: "esc" }), ctx.abort).catch(() => undefined)
            state.stuck = 0
          }
          continue
        }
        const check = await checkSubgoal({ subgoal: sub, ui, ctx, shot: after, board: state })
        if (check.satisfied) board.advance(state)
        continue
      }

      if (plan.action === "type") {
        const act = await write(cand, plan.text!, ctx, { title: input.window_title })
        await Bun.sleep(180)
        const after = await capture({ target: input.target, window_title: input.window_title, region: input.region }, ctx.abort)
        const v = await verifyStep({
          before: pre,
          after,
          candidate: cand,
          risk: actRisk(cand, "type", plan.text),
          expectation: `field contains: ${plan.text}`,
          ui,
          ctx,
          windowTitle: input.window_title,
        })
        board.record(state, {
          action: `type:${act.rung}`,
          sid: cand.sid,
          label: cand.label,
          verified: v.success,
          state: v.reason,
        })
        if (!v.success && state.stuck >= 2) {
          board.markStale(state, cand.sid)
          state.stuck = 0
        }
        if (v.success) {
          const check = await checkSubgoal({ subgoal: sub, ui, ctx, shot: after, board: state })
          if (check.satisfied) board.advance(state)
        }
        continue
      }

      if (plan.action === "press") {
        await run(keyScript({ action: "press", key: plan.key! }), ctx.abort)
        await Bun.sleep(180)
        const after = await capture({ target: input.target, window_title: input.window_title, region: input.region }, ctx.abort)
        const check = await checkSubgoal({ subgoal: sub, ui, ctx, shot: after, board: state })
        board.record(state, {
          action: `press:${plan.key}`,
          verified: check.satisfied,
          state: check.state ?? "",
        })
        if (check.satisfied) board.advance(state)
        continue
      }

      await Bun.sleep(400)
      const after = await capture({ target: input.target, window_title: input.window_title, region: input.region }, ctx.abort)
      const check = await checkSubgoal({ subgoal: sub, ui, ctx, shot: after, board: state })
      board.record(state, { action: "wait", verified: check.satisfied, state: check.state ?? "" })
      if (check.satisfied) board.advance(state)
    }

    const success = board.done(state)
    const tail = board.tail(state, 8).map((s) => `${s.step}. ${s.action} -> ${s.verified ? "ok" : "?"} ${s.state}`)
    return {
      title: "UI navigate",
      output: success
        ? `Completed "${input.goal}" across ${state.subgoals.length} subgoal(s) in ${used} step(s).`
        : `Stopped after ${used} step(s) without completing "${input.goal}". Progress: ${state.active}/${state.subgoals.length}.`,
      metadata: {
        success,
        steps: used,
        subgoals: state.subgoals,
        active: state.active,
        stuck: state.stuck,
        stale: Array.from(state.stale),
        tail,
        model: `${ui.model.providerID}/${ui.model.id}`,
      },
    }
  },
})
