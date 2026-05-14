import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Proxy } from "../../src/util/proxy"

const envKeys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "MACAW_PAC_URL",
  "MACAW_PROXY_PAC",
  "MACAW_PROXY_AUTH",
  "MACAW_PROXY_INTEGRATED",
]

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const k of envKeys) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  Proxy.reset()
})

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  Proxy.reset()
})

describe("Proxy.resolve", () => {
  test("returns undefined with no env configured", async () => {
    expect(await Proxy.resolve("https://example.com/")).toBeUndefined()
  })

  test("uses HTTPS_PROXY for https URLs", async () => {
    process.env.HTTPS_PROXY = "http://proxy.local:8080"
    expect(await Proxy.resolve("https://example.com/")).toBe("http://proxy.local:8080")
  })

  test("uses HTTP_PROXY for http URLs", async () => {
    process.env.HTTP_PROXY = "http://proxy.local:8080"
    expect(await Proxy.resolve("http://example.com/")).toBe("http://proxy.local:8080")
  })

  test("NO_PROXY forces direct", async () => {
    process.env.HTTPS_PROXY = "http://proxy.local:8080"
    process.env.NO_PROXY = "example.com"
    expect(await Proxy.resolve("https://api.example.com/")).toBeNull()
    expect(await Proxy.resolve("https://other.test/")).toBe("http://proxy.local:8080")
  })

  test("injects MACAW_PROXY_AUTH into env proxy", async () => {
    process.env.HTTPS_PROXY = "http://proxy.local:8080"
    process.env.MACAW_PROXY_AUTH = "alice:s3cret"
    const out = await Proxy.resolve("https://example.com/")
    expect(out).toBe("http://alice:s3cret@proxy.local:8080/")
  })

  test("does not overwrite existing auth in env proxy", async () => {
    process.env.HTTPS_PROXY = "http://bob:x@proxy.local:8080"
    process.env.MACAW_PROXY_AUTH = "alice:s3cret"
    const out = await Proxy.resolve("https://example.com/")
    expect(out).toBe("http://bob:x@proxy.local:8080")
  })

  test("Proxy.fetch uses Bun fetch for direct connections", async () => {
    using srv = Bun.serve({ port: 0, fetch: () => new Response("ok", { status: 200 }) })
    const url = srv.url.toString()
    process.env.NO_PROXY = "*"
    const r = await Proxy.fetch(url)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe("ok")
  })

  test("Proxy.fetch routes through curl when forced (windows)", async () => {
    if (process.platform !== "win32") return
    using origin = Bun.serve({
      port: 0,
      fetch: (req) => {
        const hadAuth = req.headers.get("proxy-authorization")
        return new Response("auth=" + (hadAuth ? "yes" : "no") + " path=" + new URL(req.url).pathname)
      },
    })
    // curl doesn't talk to a "real" proxy here; it still gets to make the
    // request because Bun.serve() responds to everything. What we verify is
    // that curl was the transport (response comes back through our parser).
    process.env.HTTP_PROXY = "http://" + origin.hostname + ":" + origin.port
    process.env.MACAW_PROXY_INTEGRATED = "1"
    const url = "http://" + origin.hostname + ":" + origin.port + "/hello"
    const r = await Proxy.fetch(url)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain("path=/hello")
  })

  test("PAC: DIRECT for matching hosts, PROXY for others", async () => {
    const pac = `
      function FindProxyForURL(url, host) {
        if (shExpMatch(host, "*.bosch.com") || isPlainHostName(host)) return "DIRECT";
        return "PROXY policy-detection.bosch.com:80";
      }
    `
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pac-"))
    const file = path.join(dir, "test.pac")
    await fs.writeFile(file, pac, "utf8")
    process.env.MACAW_PAC_URL = file
    process.env.HTTPS_PROXY = "http://env-proxy.local:8080"

    expect(await Proxy.resolve("https://intranet.bosch.com/x")).toBeNull()
    expect(await Proxy.resolve("https://plainhost/x")).toBeNull()
    expect(await Proxy.resolve("https://github.com/x")).toBe("http://policy-detection.bosch.com:80")

    await fs.rm(dir, { recursive: true, force: true })
  })
})
