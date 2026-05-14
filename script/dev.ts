#!/usr/bin/env bun

import { spawn } from "bun"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

const PORT = { server: 4096, app: 4444 }
const bun = process.execPath
const pure = process.env.MACAW_DEV_PLUGINS !== "1"
const slim = process.env.MACAW_DEV_FULL_CLI !== "1"

// Bun-on-Windows bug: some env vars are reachable via `process.env.NAME` but not enumerated
// by `Object.keys(process.env)` / spread, so they silently vanish from a spawned child.
// Force-include the ones we care about (proxies, corp settings, MACAW_* tunables).
const PASSTHROUGH = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "MACAW_PROXY_AUTH",
  "MACAW_PROXY_INTEGRATED",
  "MACAW_PAC_URL",
  "MACAW_PROXY_PAC",
  "MACAW_MEMORY_DIR",
  "MACAW_INSTALL_URL",
]

const env: Record<string, string> = { ...(process.env as Record<string, string>) }
for (const k of PASSTHROUGH) {
  const v = process.env[k]
  if (v != null && env[k] == null) env[k] = v
}
env.FORCE_COLOR = "1"
env.OPENCODE_DISABLE_MODELS_FETCH = "1"
if (pure) env.OPENCODE_PURE = "1"

const serve = slim
  ? [bun, "run", "--conditions=browser", "src/serve-fast.ts", "--port", String(PORT.server)]
  : [bun, "run", "--conditions=browser", "src/index.ts", "serve", "--port", String(PORT.server), ...(pure ? ["--pure"] : [])]

const jobs = [
  {
    name: "server",
    color: "\x1b[36m",
    cmd: serve,
    cwd: "packages/opencode",
    ready: /listening on http:\/\//i,
  },
  {
    name: "app",
    color: "\x1b[35m",
    cmd: [bun, "run", "dev", "--", "--port", String(PORT.app)],
    cwd: "packages/app",
    ready: /(ready in|Local:)/i,
  },
]

async function pipe(stream: ReadableStream<Uint8Array>, tag: string, hit: (line: string) => void) {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true })
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ""
    for (const line of lines) {
      process.stdout.write(`${tag} ${line}\n`)
      hit(line)
    }
  }
  if (buf) {
    process.stdout.write(`${tag} ${buf}\n`)
    hit(buf)
  }
}

const procs = jobs.map((job) => {
  const tag = `${job.color}${BOLD}[${job.name}]${RESET}`
  const spawnedAt = Date.now()
  process.stdout.write(`${tag} ${DIM}starting in ${job.cwd}${RESET}\n`)
  const proc = spawn({ cmd: job.cmd, cwd: job.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env })
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((r) => (resolveReady = r))
  let done = false
  let firstLine = 0
  const hit = (line: string) => {
    if (!firstLine && line.trim()) {
      firstLine = Date.now() - spawnedAt
      process.stdout.write(`${tag} ${DIM}first output after ${firstLine}ms (bun loaded)${RESET}\n`)
    }
    if (done || !job.ready.test(line)) return
    done = true
    resolveReady()
  }
  pipe(proc.stdout, tag, hit)
  pipe(proc.stderr, tag, hit)
  return { tag, proc, ready, name: job.name, color: job.color }
})

let down = false
function shutdown(code: number) {
  if (down) return
  down = true
  for (const p of procs) if (p.proc.exitCode === null) p.proc.kill()
  process.exit(code)
}
process.on("SIGINT", () => shutdown(130))
process.on("SIGTERM", () => shutdown(143))

const t0 = Date.now()
const entry = slim ? "slim (serve-fast)" : "full CLI (index.ts)"
const mode = pure ? "pure (no external plugins)" : "with plugins"
process.stdout.write(
  `\n${BOLD}macaw dev:web${RESET} ${DIM}— server http://localhost:${PORT.server} · app http://localhost:${PORT.app}${RESET}\n${DIM}entry: ${entry} · mode: ${mode}${RESET}\n${DIM}set MACAW_DEV_FULL_CLI=1 for full CLI · MACAW_DEV_PLUGINS=1 to enable plugin loading${RESET}\n${DIM}press Ctrl+C to stop both${RESET}\n\n`,
)

void Promise.race(
  procs.map(async (p) => {
    const code = await p.proc.exited
    process.stdout.write(`${p.tag} ${DIM}exited (${code})${RESET}\n`)
    shutdown(code ?? 0)
  }),
)

const server = procs.find((p) => p.name === "server")!
await server.ready
process.stdout.write(`${server.tag} ${DIM}listening (${Date.now() - t0}ms) — warming up...${RESET}\n`)

const base = `http://127.0.0.1:${PORT.server}`
const warm = async (url: string, label: string, show?: boolean) => {
  const start = Date.now()
  const res = await fetch(url).catch((e) => ({ ok: false, status: 0, err: e }) as const)
  const ms = Date.now() - start
  const ok = "ok" in res && res.ok
  const status = "status" in res ? res.status : 0
  let extra = ""
  if (ok && show && "json" in res) {
    const data = await (res as Response).json().catch(() => undefined)
    if (data && typeof data === "object" && "directory" in data) extra = ` dir=${(data as { directory: string }).directory}`
  }
  process.stdout.write(
    `${server.tag} ${DIM}warm ${label.padEnd(10)} ${ok ? "ok" : "fail"} ${status} in ${ms}ms${extra}${RESET}\n`,
  )
}

void (async () => {
  await warm(`${base}/path`, "path", true)
  await warm(`${base}/provider`, "provider")
  await warm(`${base}/session`, "session")
  process.stdout.write(`${server.tag} ${DIM}warmed in ${Date.now() - t0}ms total${RESET}\n`)
})()
