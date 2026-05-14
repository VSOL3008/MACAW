import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"

const projectRoot = path.join(import.meta.dir, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

async function withFetch(fetch: (req: Request) => Response | Promise<Response>, fn: (url: URL) => Promise<void>) {
  using server = Bun.serve({ port: 0, fetch })
  await fn(server.url)
}

describe("tool.webfetch", () => {
  test("returns image responses as file attachments", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await withFetch(
      () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute(
              { url: new URL("/image.png", url).toString(), format: "markdown" },
              ctx,
            )
            expect(result.output).toMatch(/image/i)
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          },
        })
      },
    )
  })

  test("keeps svg as text output", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>'
    await withFetch(
      () =>
        new Response(svg, {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute({ url: new URL("/image.svg", url).toString(), format: "html" }, ctx)
            expect(result.output).toContain("<svg")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("keeps text responses as text output", async () => {
    await withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute({ url: new URL("/file.txt", url).toString(), format: "text" }, ctx)
            expect(result.output).toBe("hello from webfetch")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("extracts readable article content from HTML", async () => {
    const html = `<!doctype html><html><head><title>Test Page</title></head>
      <body>
        <nav>nav should be stripped</nav>
        <header>header chrome</header>
        <main>
          <article>
            <h1>Main Heading</h1>
            <p>${"This is the main article content about WebFetch improvements. ".repeat(20)}</p>
            <p>${"Another relevant paragraph. ".repeat(20)}</p>
          </article>
        </main>
        <footer>footer junk</footer>
      </body></html>`
    await withFetch(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute(
              { url: new URL("/article", url).toString(), mode: "article", format: "markdown" },
              ctx,
            )
            expect(result.output).toContain("Main Heading")
            expect(result.output).toContain("main article content")
            expect(result.output).not.toContain("footer junk")
            expect(result.output).not.toContain("nav should be stripped")
          },
        })
      },
    )
  })

  test("fetches multiple URLs in parallel", async () => {
    await withFetch(
      (req) => {
        const p = new URL(req.url).pathname
        return new Response(`<html><body><main>page ${p}</main></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      },
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute(
              {
                urls: [new URL("/a", url).toString(), new URL("/b", url).toString()],
                mode: "full",
                format: "markdown",
              },
              ctx,
            )
            expect(result.output).toContain("page /a")
            expect(result.output).toContain("page /b")
            expect(result.metadata.results?.length).toBe(2)
          },
        })
      },
    )
  })

  test("paginates with offset and maxChars and reports next_offset", async () => {
    const body = "X".repeat(3000)
    await withFetch(
      () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const page1 = await webfetch.execute(
              { url: new URL("/big.txt", url).toString(), format: "text", maxChars: 1000 },
              ctx,
            )
            expect(page1.output.length).toBe(1000)
            expect(page1.metadata.results?.[0]?.truncated).toBe(true)
            expect(page1.metadata.results?.[0]?.next_offset).toBe(1000)

            const page2 = await webfetch.execute(
              { url: new URL("/big.txt", url).toString(), format: "text", maxChars: 1000, offset: 1000 },
              ctx,
            )
            expect(page2.output.length).toBe(1000)
            expect(page2.metadata.results?.[0]?.truncated).toBe(true)
            expect(page2.metadata.results?.[0]?.next_offset).toBe(2000)
          },
        })
      },
    )
  })

  test("extracts outbound links from HTML", async () => {
    const html = `<html><body>
      <a href="https://example.com/a">A</a>
      <a href="https://example.com/b">B</a>
      <a href="/relative">rel</a>
      <a href="#frag">frag</a>
      <a href="mailto:x@y">mail</a>
    </body></html>`
    await withFetch(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute(
              { url: new URL("/links", url).toString(), mode: "full", format: "markdown" },
              ctx,
            )
            const links = result.metadata.results?.[0]?.links ?? []
            expect(links).toContain("https://example.com/a")
            expect(links).toContain("https://example.com/b")
            expect(links.some((l: string) => l.endsWith("/relative"))).toBe(true)
            expect(links.some((l: string) => l.includes("#frag"))).toBe(false)
            expect(links.some((l: string) => l.startsWith("mailto:"))).toBe(false)
          },
        })
      },
    )
  })

  test("query trims content to relevant sections", async () => {
    const html = `<html><body><main>
      <h2>Irrelevant topic</h2>
      <p>${"banana fruit potassium breakfast smoothie recipes ".repeat(30)}</p>
      <h2>Relevant section</h2>
      <p>${"quantum computing qubits superposition entanglement error correction ".repeat(30)}</p>
    </main></body></html>`
    await withFetch(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute(
              {
                url: new URL("/focused", url).toString(),
                mode: "full",
                format: "markdown",
                query: "quantum computing qubits",
              },
              ctx,
            )
            expect(result.output).toContain("quantum")
            expect(result.output.includes("banana")).toBe(false)
          },
        })
      },
    )
  })

  test("caches repeated fetches for the same URL", async () => {
    let hits = 0
    await withFetch(
      () => {
        hits++
        return new Response("cached body", { status: 200, headers: { "content-type": "text/plain" } })
      },
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const u = new URL("/cache-" + Math.random().toString(36).slice(2), url).toString()
            await webfetch.execute({ url: u, format: "text" }, ctx)
            await webfetch.execute({ url: u, format: "text" }, ctx)
            expect(hits).toBe(1)
          },
        })
      },
    )
  })

  test("crawl follows internal links and stops at maxPages", async () => {
    const pages: Record<string, string> = {
      "/seed": `<html><body><main>
        <h1>Seed</h1>
        <a href="/a">A</a>
        <a href="/b">B</a>
        <a href="/c">C</a>
      </main></body></html>`,
      "/a": `<html><body><main>page A body</main></body></html>`,
      "/b": `<html><body><main>page B body</main></body></html>`,
      "/c": `<html><body><main>page C body</main></body></html>`,
    }
    await withFetch(
      (req) => {
        const p = new URL(req.url).pathname
        return new Response(pages[p] ?? "<html><body>missing</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      },
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute(
              {
                url: new URL("/seed", url).toString(),
                mode: "full",
                format: "markdown",
                crawl: { maxPages: 2, concurrency: 1 },
              },
              ctx,
            )
            expect(result.metadata.results?.length).toBe(2)
            expect(result.metadata.crawl?.visited).toBeGreaterThanOrEqual(2)
            const urls = result.metadata.results.map((r: { url: string }) => r.url)
            expect(urls.some((u: string) => u.endsWith("/seed"))).toBe(true)
            expect(result.output).toContain("# Crawl:")
          },
        })
      },
    )
  })

  test("crawl with sameOrigin skips links to other origins", async () => {
    let hits = 0
    await withFetch(
      (req) => {
        hits++
        const p = new URL(req.url).pathname
        const body =
          p === "/seed"
            ? `<html><body><main>
                <h1>Seed</h1>
                <a href="/inside">inside</a>
                <a href="https://external.invalid/x">outside</a>
              </main></body></html>`
            : `<html><body><main>internal page</main></body></html>`
        return new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      },
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute(
              {
                url: new URL("/seed", url).toString(),
                mode: "full",
                format: "markdown",
                crawl: { maxPages: 5, sameOrigin: true, concurrency: 1 },
              },
              ctx,
            )
            for (const r of result.metadata.results as { url: string }[]) {
              expect(r.url.startsWith(url.origin)).toBe(true)
            }
            expect(hits).toBe(2)
          },
        })
      },
    )
  })

  test("crawl include and exclude filter URLs by pathname pattern", async () => {
    const pages: Record<string, string> = {
      "/seed": `<html><body><main>
        <a href="/docs/a">docs A</a>
        <a href="/docs/b">docs B</a>
        <a href="/blog/c">blog C</a>
        <a href="/api/d">api D</a>
      </main></body></html>`,
      "/docs/a": `<html><body><main>doc A body</main></body></html>`,
      "/docs/b": `<html><body><main>doc B body</main></body></html>`,
      "/blog/c": `<html><body><main>blog body</main></body></html>`,
      "/api/d": `<html><body><main>api body</main></body></html>`,
    }
    await withFetch(
      (req) => {
        const p = new URL(req.url).pathname
        return new Response(pages[p] ?? "<html><body>missing</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      },
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const webfetch = await WebFetchTool.init()
            const result = await webfetch.execute(
              {
                url: new URL("/seed", url).toString(),
                mode: "full",
                format: "markdown",
                crawl: {
                  maxPages: 10,
                  include: ["/docs/**"],
                  exclude: ["/docs/b"],
                  concurrency: 2,
                },
              },
              ctx,
            )
            const urls = (result.metadata.results as { url: string }[]).map((r) => r.url)
            expect(urls.some((u: string) => u.endsWith("/docs/a"))).toBe(true)
            expect(urls.some((u: string) => u.endsWith("/docs/b"))).toBe(false)
            expect(urls.some((u: string) => u.endsWith("/blog/c"))).toBe(false)
            expect(urls.some((u: string) => u.endsWith("/api/d"))).toBe(false)
          },
        })
      },
    )
  })
})
