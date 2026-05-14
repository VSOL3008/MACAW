import { unlink } from "fs/promises"
import type { Candidate, Rect } from "./discover"
import { capture } from "./screenshot"
import type { Tool } from "./tool"
import { base64, call, type UIModel } from "./ui"
import * as uia from "./uia"
import { prelude, run } from "./win"

export type DiffResult = { local: number; global: number }

export type Decision = {
  decision: "success" | "fail" | "escalate_uia" | "escalate_visual"
  reason: string
}

export type Thresholds = {
  dead: number
  clear: number
  deadGlobal: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  dead: 0.01,
  clear: 0.08,
  deadGlobal: 0.005,
}

export function expand(r: Rect, pad: number): Rect {
  return [
    Math.round(r[0] - pad),
    Math.round(r[1] - pad),
    Math.round(r[2] + pad),
    Math.round(r[3] + pad),
  ] as Rect
}

export function classify(
  d: DiffResult,
  opts: { source: "uia" | "visual"; risk: "low" | "high"; thresholds?: Thresholds },
): Decision {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS
  if (d.local < t.dead && d.global < t.deadGlobal) return { decision: "fail", reason: "no change detected" }
  if (d.local >= t.clear && opts.risk === "low") return { decision: "success", reason: "region changed" }
  if (opts.source === "uia") return { decision: "escalate_uia", reason: "ambiguous diff, query uia state" }
  return { decision: "escalate_visual", reason: "ambiguous diff, ask ui model" }
}

export function diffScript(a: string, b: string, r: Rect) {
  return prelude(`
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class MacawDiff {
  public static double[] Compute(string pa, string pb, int x1, int y1, int x2, int y2) {
    using (var ba = new Bitmap(pa))
    using (var bb = new Bitmap(pb)) {
      int w = Math.Min(ba.Width, bb.Width);
      int h = Math.Min(ba.Height, bb.Height);
      var rect = new Rectangle(0, 0, w, h);
      var la = ba.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      var lb = bb.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      int len = Math.Abs(la.Stride) * h;
      var aa = new byte[len];
      var ab = new byte[len];
      Marshal.Copy(la.Scan0, aa, 0, len);
      Marshal.Copy(lb.Scan0, ab, 0, len);
      ba.UnlockBits(la); bb.UnlockBits(lb);
      int cx1 = Math.Max(0, x1); int cy1 = Math.Max(0, y1);
      int cx2 = Math.Min(w, x2); int cy2 = Math.Min(h, y2);
      long lSum = 0, lN = 0, gSum = 0, gN = 0;
      int stride = la.Stride;
      for (int y = 0; y < h; y++) {
        int row = y * stride;
        for (int x = 0; x < w; x++) {
          int o = row + x * 4;
          int d = Math.Abs(aa[o] - ab[o]) + Math.Abs(aa[o + 1] - ab[o + 1]) + Math.Abs(aa[o + 2] - ab[o + 2]);
          bool inR = (x >= cx1 && x < cx2 && y >= cy1 && y < cy2);
          if (inR) { lSum += d; lN++; } else { gSum += d; gN++; }
        }
      }
      double local = lN > 0 ? (double)lSum / (lN * 3.0 * 255.0) : 0.0;
      double global_ = gN > 0 ? (double)gSum / (gN * 3.0 * 255.0) : 0.0;
      return new double[] { local, global_ };
    }
  }
}
"@
$r = [MacawDiff]::Compute('${a}', '${b}', ${r[0]}, ${r[1]}, ${r[2]}, ${r[3]})
[pscustomobject]@{ local = $r[0]; global = $r[1] } | ConvertTo-Json -Compress
`)
}

async function savePng(url: string) {
  const raw = Buffer.from(base64(url), "base64")
  const path = `${process.env.TEMP ?? process.env.TMP ?? "."}\\macaw-diff-${crypto.randomUUID()}.png`
  await Bun.write(path, raw)
  return path
}

export async function diff(before: string, after: string, rect: Rect, signal?: AbortSignal): Promise<DiffResult> {
  const pa = await savePng(before)
  const pb = await savePng(after)
  try {
    const text = await run(diffScript(pa, pb, rect), signal)
    const parsed = JSON.parse(text.trim())
    return { local: Number(parsed.local) || 0, global: Number(parsed.global) || 0 }
  } finally {
    await Promise.all([unlink(pa).catch(() => undefined), unlink(pb).catch(() => undefined)])
  }
}

function toggled(before: uia.State, now: uia.State) {
  if (before.toggle && now.toggle && before.toggle !== now.toggle) return true
  if ((before.value ?? "") !== (now.value ?? "")) return true
  if (before.selected !== now.selected) return true
  return false
}

async function visualCheck(input: {
  ui: UIModel
  ctx: Tool.Context
  after: string
  label: string
  rect: Rect
  expectation: string
}) {
  const text = await call({
    ui: input.ui,
    shot: input.after,
    abort: input.ctx.abort,
    format: "json",
    system: [
      "You verify whether a UI action succeeded.",
      "Look at the screenshot after the action and decide if the expected change clearly happened.",
      'Return JSON only in this shape: {"success":true,"state":"brief state summary"}.',
      "Set success to true only when the screenshot clearly confirms the expected change.",
    ].join("\n"),
    prompt: [
      `Expectation: ${input.expectation}`,
      `Target: ${input.label}`,
      `Bbox: [${input.rect.join(", ")}]`,
      "Describe the current UI state in one short sentence.",
    ].join("\n"),
  })
  const raw = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text)
  return {
    success: Boolean(raw?.success),
    state: String(raw?.state ?? "").trim(),
  }
}

export type VerifyResult = {
  success: boolean
  reason: string
  rung: Decision["decision"]
  diff: DiffResult
  state?: string
}

export async function verify(input: {
  before: string
  after?: string
  candidate: Candidate
  risk: "low" | "high"
  expectation: string
  ui: UIModel
  ctx: Tool.Context
  windowTitle?: string
  thresholds?: Thresholds
  snapshot?: uia.State
}): Promise<VerifyResult> {
  const after = input.after ?? (await capture({ target: "screen" }, input.ctx.abort))
  const d = await diff(input.before, after, expand(input.candidate.rect, 20), input.ctx.abort)
  const decision = classify(d, { source: input.candidate.source, risk: input.risk, thresholds: input.thresholds })
  if (decision.decision === "fail") return { success: false, reason: decision.reason, rung: decision.decision, diff: d }
  if (decision.decision === "success") return { success: true, reason: decision.reason, rung: decision.decision, diff: d }
  if (decision.decision === "escalate_uia" && input.candidate.source === "uia" && input.candidate.runtimeId) {
    const now = await uia
      .query({ runtimeId: input.candidate.runtimeId, title: input.windowTitle }, input.ctx.abort)
      .catch(() => undefined)
    if (now && input.snapshot && toggled(input.snapshot, now)) {
      return { success: true, reason: "uia state changed", rung: decision.decision, diff: d }
    }
    if (now && !now.enabled) {
      return { success: false, reason: "target no longer enabled", rung: decision.decision, diff: d }
    }
    const vis = await visualCheck({
      ui: input.ui,
      ctx: input.ctx,
      after,
      label: input.candidate.label,
      rect: input.candidate.rect,
      expectation: input.expectation,
    })
    return {
      success: vis.success,
      reason: vis.state || "visual check",
      rung: "escalate_visual",
      diff: d,
      state: vis.state,
    }
  }
  const vis = await visualCheck({
    ui: input.ui,
    ctx: input.ctx,
    after,
    label: input.candidate.label,
    rect: input.candidate.rect,
    expectation: input.expectation,
  })
  return {
    success: vis.success,
    reason: vis.state || "visual check",
    rung: "escalate_visual",
    diff: d,
    state: vis.state,
  }
}
