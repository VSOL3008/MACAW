import { Log } from "../util/log"
import * as Ollama from "../util/ollama"

const log = Log.create({ service: "task.ollama" })

export function baseURL(): string {
  return Ollama.envURL() ?? Ollama.DEFAULT_URL
}

function root(url: string): string {
  return Ollama.root(url)
}

export async function loaded(url: string = baseURL()): Promise<string[]> {
  try {
    const res = await fetch(`${root(url)}/api/ps`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> }
    return (data.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean)
  } catch (err) {
    log.warn("loaded check failed", { err })
    return []
  }
}

export async function warm(modelID: string, url: string = baseURL(), keepAlive: string = "10m"): Promise<boolean> {
  try {
    const res = await fetch(`${root(url)}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelID, prompt: "", keep_alive: keepAlive, stream: false }),
      signal: AbortSignal.timeout(90_000),
    })
    return res.ok
  } catch (err) {
    log.warn("warm-up failed", { modelID, err })
    return false
  }
}

export async function unload(modelID: string, url: string = baseURL()): Promise<boolean> {
  try {
    const res = await fetch(`${root(url)}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelID, prompt: "", keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok
  } catch (err) {
    log.warn("unload failed", { modelID, err })
    return false
  }
}

export async function ensureReady(modelID: string, url: string = baseURL()): Promise<"already" | "warmed" | "skipped"> {
  const list = await loaded(url)
  const hit = list.some((name) => name === modelID || name.startsWith(modelID + ":") || modelID.startsWith(name + ":"))
  if (hit) return "already"
  const ok = await warm(modelID, url)
  return ok ? "warmed" : "skipped"
}
