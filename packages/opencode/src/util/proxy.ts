import { iife } from "./iife"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

export namespace Proxy {
  type Pac = { source: string; url: string }

  /**
   * Resolution result for a target URL:
   * - `string`: use this proxy URL
   * - `null`: force direct connection (override any env-var proxy)
   * - `undefined`: no opinion — let the runtime use defaults (env vars, etc.)
   */
  export type Resolution = string | null | undefined

  let cached: Pac | undefined
  let loader: Promise<Pac | undefined> | undefined

  /**
   * Proxies known to require integrated (NTLM/Negotiate) authentication, keyed
   * by origin. Once a proxy returns 407 without embedded credentials, we skip
   * the Bun fetch attempt and go straight to curl for subsequent requests.
   */
  const integrated = new Set<string>()

  function env(key: string) {
    return process.env[key] || process.env[key.toLowerCase()]
  }

  function injectAuth(url: string) {
    const auth = env("MACAW_PROXY_AUTH")
    if (!auth) return url
    try {
      const u = new URL(url)
      if (u.username) return url
      const [user, ...rest] = auth.split(":")
      u.username = encodeURIComponent(user)
      u.password = encodeURIComponent(rest.join(":"))
      return u.toString()
    } catch {
      return url
    }
  }

  function noProxy(host: string, port: number, value: string | undefined) {
    if (!value) return false
    for (const raw of value.split(/[\s,]+/)) {
      if (!raw) continue
      if (raw === "*") return true
      let pat = raw.toLowerCase()
      let pport: number | undefined
      const colon = pat.lastIndexOf(":")
      if (colon > 0 && /^\d+$/.test(pat.slice(colon + 1))) {
        pport = Number(pat.slice(colon + 1))
        pat = pat.slice(0, colon)
      }
      if (pport !== undefined && pport !== port) continue
      if (pat.startsWith(".")) {
        const suffix = pat.slice(1)
        if (host === suffix || host.endsWith(pat)) return true
        continue
      }
      if (host === pat || host.endsWith("." + pat)) return true
    }
    return false
  }

  async function loadPac(): Promise<Pac | undefined> {
    if (cached) return cached
    if (loader) return loader
    const src = env("MACAW_PAC_URL") || env("MACAW_PROXY_PAC")
    if (!src) return undefined
    loader = iife(async () => {
      const source = await (/^https?:\/\//i.test(src)
        ? fetch(src).then((r) => {
            if (!r.ok) throw new Error(`Failed to fetch PAC file ${src}: ${r.status}`)
            return r.text()
          })
        : Bun.file(src).text())
      cached = { source, url: src }
      return cached
    })
    return loader
  }

  function evalPac(pac: Pac, url: string, host: string): string {
    const helpers = {
      isPlainHostName: (h: string) => !h.includes("."),
      dnsDomainIs: (h: string, d: string) => h.toLowerCase().endsWith(d.toLowerCase()),
      localHostOrDomainIs: (h: string, d: string) => {
        const hl = h.toLowerCase()
        const dl = d.toLowerCase()
        return hl === dl || dl.startsWith(hl + ".")
      },
      isResolvable: () => true,
      isInNet: () => false,
      dnsResolve: (h: string) => h,
      myIpAddress: () => "127.0.0.1",
      dnsDomainLevels: (h: string) => (h.match(/\./g) || []).length,
      shExpMatch: (str: string, pat: string) => {
        const re =
          "^" +
          pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") +
          "$"
        return new RegExp(re).test(str)
      },
      weekdayRange: () => true,
      dateRange: () => true,
      timeRange: () => true,
      alert: () => {},
    }
    const keys = Object.keys(helpers) as (keyof typeof helpers)[]
    const body =
      keys.map((k, i) => `var ${k} = __h[${i}];`).join("\n") +
      "\n" +
      pac.source +
      "\nreturn FindProxyForURL(url, host);"
    const fn = new Function("__h", "url", "host", body)
    return String(fn(keys.map((k) => helpers[k]), url, host) || "")
  }

  function parsePacResult(result: string): Resolution {
    for (const entry of result.split(";")) {
      const parts = entry.trim().split(/\s+/)
      const kind = parts[0]?.toUpperCase()
      if (!kind) continue
      if (kind === "DIRECT") return null
      if (!parts[1]) continue
      if (kind === "PROXY" || kind === "HTTP") return `http://${parts[1]}`
      if (kind === "HTTPS") return `https://${parts[1]}`
      if (kind === "SOCKS" || kind === "SOCKS4" || kind === "SOCKS5") return `socks://${parts[1]}`
    }
    return null
  }

  /**
   * Resolve the proxy to use for a given target URL. Resolution order:
   *
   * 1. NO_PROXY env var — if it matches, force direct (`null`).
   * 2. MACAW_PAC_URL / MACAW_PROXY_PAC env var — evaluate PAC for the URL.
   * 3. HTTPS_PROXY (for https://) or HTTP_PROXY (for http://).
   *
   * If MACAW_PROXY_AUTH (`user:pass`) is set, credentials are injected into
   * the resolved proxy URL when not already present. A non-http(s) target or
   * unparsable URL yields `undefined` (no opinion).
   */
  export async function resolve(url: string): Promise<Resolution> {
    const target = iife(() => {
      try {
        return new URL(url)
      } catch {
        return undefined
      }
    })
    if (!target) return undefined
    if (target.protocol !== "http:" && target.protocol !== "https:") return undefined

    const host = target.hostname.toLowerCase()
    const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80)

    if (noProxy(host, port, env("NO_PROXY"))) return null

    const pac = await loadPac().catch(() => undefined)
    if (pac) {
      const picked = parsePacResult(evalPac(pac, url, host))
      if (typeof picked === "string") return injectAuth(picked)
      return null
    }

    const fromEnv = target.protocol === "https:" ? env("HTTPS_PROXY") : env("HTTP_PROXY")
    if (fromEnv) return injectAuth(fromEnv)
    return undefined
  }

  function hasAuth(url: string) {
    try {
      const u = new URL(url)
      return !!(u.username || u.password)
    } catch {
      return false
    }
  }

  function origin(url: string) {
    try {
      return new URL(url).origin
    } catch {
      return url
    }
  }

  function sanitize(url: string) {
    try {
      const u = new URL(url)
      if (u.username || u.password) {
        u.username = "***"
        u.password = ""
      }
      return u.toString()
    } catch {
      return url
    }
  }

  /**
   * Perform an HTTP(S) fetch honoring the resolved proxy, with an automatic
   * curl fallback for NTLM/Negotiate-authenticated proxies on Windows.
   *
   * The fallback uses the current Windows session credentials via SSPI
   * (`curl --proxy-anyauth -U :`), so no password needs to be stored.
   *
   * Set `MACAW_PROXY_INTEGRATED=1` to force the curl path even before a 407
   * is seen. Set `MACAW_PROXY_INTEGRATED=0` to disable the fallback.
   */
  export async function fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const proxy = await resolve(url)
    const proxyOpt = proxy === null ? "" : proxy
    const forceCurl =
      process.platform === "win32" &&
      typeof proxy === "string" &&
      !hasAuth(proxy) &&
      (env("MACAW_PROXY_INTEGRATED") === "1" || integrated.has(origin(proxy)))
    const integratedEnabled = env("MACAW_PROXY_INTEGRATED") !== "0"

    if (forceCurl) return viaCurl(url, init, proxy as string)

    const bunInit: RequestInit & { proxy?: string } = { ...init }
    if (proxyOpt !== undefined) bunInit.proxy = proxyOpt

    const response = await globalThis.fetch(url, bunInit)
    if (
      response.status === 407 &&
      process.platform === "win32" &&
      typeof proxy === "string" &&
      !hasAuth(proxy) &&
      integratedEnabled
    ) {
      integrated.add(origin(proxy))
      // Drain the original body to release the connection.
      await response.arrayBuffer().catch(() => {})
      return viaCurl(url, init, proxy)
    }
    return response
  }

  export function isIntegrated(proxy: string) {
    return integrated.has(origin(proxy))
  }

  export function describe(proxy: string | null | undefined) {
    if (proxy === null) return "direct (no proxy)"
    if (!proxy) return "default (no proxy)"
    return `proxy ${sanitize(proxy)}`
  }

  async function viaCurl(url: string, init: RequestInit, proxy: string): Promise<Response> {
    const headersFile = path.join(os.tmpdir(), `macaw-curl-${randomUUID()}.txt`)
    try {
      const args = [
        "-sSL",
        "--max-time", "120",
        "-D", headersFile,
        "--proxy", proxy,
        "--proxy-anyauth",
        "-U", ":",
      ]
      const headers = new Headers(init.headers)
      headers.forEach((value, key) => {
        args.push("-H", `${key}: ${value}`)
      })
      if (init.method && init.method.toUpperCase() !== "GET") {
        args.push("-X", init.method.toUpperCase())
      }
      if (init.body) {
        args.push("--data-binary", "@-")
      }
      args.push("--", url)

      const proc = Bun.spawn({
        cmd: ["curl.exe", ...args],
        stdout: "pipe",
        stderr: "pipe",
        stdin: init.body ? "pipe" : "ignore",
      })

      const aborter = () => proc.kill()
      init.signal?.addEventListener("abort", aborter, { once: true })

      if (init.body && proc.stdin) {
        const writer = (proc.stdin as any).getWriter?.() ?? proc.stdin
        try {
          if (typeof init.body === "string") await (writer as WritableStreamDefaultWriter).write(new TextEncoder().encode(init.body))
          else if (init.body instanceof Uint8Array) await (writer as WritableStreamDefaultWriter).write(init.body)
          await (writer as WritableStreamDefaultWriter).close?.()
        } catch {}
      }

      const [body, stderr] = await Promise.all([
        new Response(proc.stdout as ReadableStream).arrayBuffer(),
        new Response(proc.stderr as ReadableStream).text(),
      ])
      const code = await proc.exited
      init.signal?.removeEventListener("abort", aborter)

      if (code !== 0) {
        throw new Error(`curl (exit ${code}): ${stderr.trim() || "proxy request failed"}`)
      }

      const raw = await fs.readFile(headersFile, "utf8").catch(() => "")
      const blocks = raw.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean)
      const last = blocks[blocks.length - 1] ?? ""
      const lines = last.split(/\r?\n/)
      const status = Number(lines[0]?.match(/^HTTP\/[\d.]+\s+(\d+)/)?.[1] ?? 0)
      const respHeaders = new Headers()
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(":")
        if (idx <= 0) continue
        respHeaders.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
      }
      return new Response(body, { status: status || 200, headers: respHeaders })
    } finally {
      await fs.unlink(headersFile).catch(() => {})
    }
  }

  /** For tests. */
  export function reset() {
    cached = undefined
    loader = undefined
    integrated.clear()
  }
}
