import { Env } from "../env"

export const DEFAULT_URL = "http://10.77.168.115:11434/v1"

export function root(url: string) {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "")
}

export function normalize(url: string | undefined) {
  const value = url?.trim()
  if (!value) return
  const next = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
  return `${root(next)}/v1`
}

const cache = new Map<string, string | undefined>()

const TREES = [
  "HKCU\\Environment",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
]

function winReg(key: string) {
  if (process.platform !== "win32") return
  if (cache.has(key)) return cache.get(key)
  for (const tree of TREES) {
    try {
      const res = Bun.spawnSync({ cmd: ["reg", "query", tree, "/v", key], stdout: "pipe", stderr: "ignore" })
      if (res.exitCode !== 0) continue
      const out = new TextDecoder().decode(res.stdout)
      const match = out.match(new RegExp(`${key}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+?)\\s*$`, "im"))
      const value = match?.[1]?.trim()
      if (value) {
        cache.set(key, value)
        return value
      }
    } catch {}
  }
  cache.set(key, undefined)
}

function read(key: string) {
  return Env.get(key) ?? winReg(key)
}

export function envURL() {
  return normalize(read("OLLAMA_BASE_URL")) ?? normalize(read("OLLAMA_HOST"))
}

export function envKey() {
  return read("OLLAMA_API_KEY")
}
