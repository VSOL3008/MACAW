import z from "zod"
import { Tool } from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { abortAfterAny } from "../util/abort"
import { iife } from "@/util/iife"
import { Proxy } from "../util/proxy"
import { Glob } from "../util/glob"
import { extractPdfText } from "@/util/pdf"

const MAX_RESPONSE_SIZE = 20 * 1024 * 1024 // 20MB hard cap
const DEFAULT_TIMEOUT = 30 * 1000
const MAX_TIMEOUT = 120 * 1000
const DEFAULT_MAX_CHARS = 50_000
const MAX_URLS = 5
const CACHE_TTL_MS = 60_000
const CACHE_MAX = 50
const EXA_MCP_URL = "https://mcp.exa.ai/mcp"

type Fetched = {
  title: string
  output: string
  links: string[]
  mime: string
  status: number
  truncated: boolean
  total: number
  next_offset?: number
  attachments?: NonNullable<Awaited<ReturnType<Tool.Def["execute"]>>["attachments"]>
}

type WebFetchMeta = {
  urls: string[]
  results: Array<{
    url: string
    title: string
    mime: string
    status: number
    truncated: boolean
    total: number
    next_offset?: number
    links?: string[]
  }>
  errors: Array<{ url: string; error: string }>
  crawl?: {
    seed: string
    visited: number
    depth_reached: number
    errors: number
  }
}

type CacheEntry = { at: number; value: Fetched }
const cache = new Map<string, CacheEntry>()

function cacheGet(key: string): Fetched | undefined {
  const hit = cache.get(key)
  if (!hit) return
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return
  }
  cache.delete(key)
  cache.set(key, hit)
  return hit.value
}

function cacheSet(key: string, value: Fetched) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), value })
}

export const WebFetchTool = Tool.define("webfetch", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("Single URL to fetch (use this OR urls)").optional(),
    urls: z.array(z.string()).max(MAX_URLS).describe(`Up to ${MAX_URLS} URLs to fetch in parallel`).optional(),
    format: z
      .enum(["markdown", "text", "html", "raw"])
      .optional()
      .describe("Output format. 'raw' returns untransformed response body. Default markdown."),
    mode: z
      .enum(["article", "full"])
      .optional()
      .describe("'article' extracts main readable content; 'full' keeps the whole page. Default article."),
    query: z
      .string()
      .describe("Optional focus query; only sections relevant to the query are kept")
      .optional(),
    offset: z.number().int().min(0).optional().describe("Character offset for pagination (default 0)"),
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(500_000)
      .optional()
      .describe(`Max chars per URL (default ${DEFAULT_MAX_CHARS})`),
    includeLinks: z.boolean().optional().describe("Include extracted outbound links in metadata (default true)"),
    livecrawl: z
      .enum(["auto", "never", "force"])
      .optional()
      .describe("JS-rendered fallback via Exa crawl: 'auto' (fallback if empty, default), 'never', 'force'"),
    timeout: z.number().describe("Optional timeout in seconds (max 120)").optional(),
    crawl: z
      .object({
        maxPages: z.number().int().min(1).max(25).optional().describe("Max pages to fetch (cap 25, default 10)"),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Max link-follow depth from the seed (cap 5, default 2)"),
        sameOrigin: z.boolean().optional().describe("Only follow links on the seed's origin (default true)"),
        include: z.array(z.string()).optional().describe("Glob patterns over URL pathname; only follow matches"),
        exclude: z.array(z.string()).optional().describe("Glob patterns over URL pathname; skip matches"),
        concurrency: z.number().int().min(1).max(8).optional().describe("Parallel fetches (cap 8, default 4)"),
      })
      .optional()
      .describe("If set, BFS-follows internal links from the seed URL up to maxPages/maxDepth"),
  }),
  async execute(params, ctx) {
    const urls = resolveUrls(params)
    if (!urls.length) throw new Error("Provide 'url' or a non-empty 'urls' array")
    for (const u of urls) {
      if (!u.startsWith("http://") && !u.startsWith("https://")) {
        throw new Error(`URL must start with http:// or https:// (got: ${u})`)
      }
    }

    const opts = {
      format: params.format ?? "markdown",
      mode: params.mode ?? "article",
      query: params.query,
      offset: params.offset ?? 0,
      maxChars: params.maxChars ?? DEFAULT_MAX_CHARS,
      includeLinks: params.includeLinks ?? true,
      livecrawl: params.livecrawl ?? "auto",
    } as const

    const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

    if (params.crawl) {
      if (urls.length !== 1) throw new Error("crawl mode requires exactly one URL")
      const seed = urls[0]!
      const cfg: CrawlOpts = {
        maxPages: params.crawl.maxPages ?? 10,
        maxDepth: params.crawl.maxDepth ?? 2,
        sameOrigin: params.crawl.sameOrigin ?? true,
        include: params.crawl.include,
        exclude: params.crawl.exclude,
        concurrency: params.crawl.concurrency ?? 4,
      }

      await ctx.ask({
        permission: "webfetch",
        patterns: [seed],
        always: ["*"],
        metadata: {
          urls: [seed],
          crawl: cfg,
          format: opts.format,
          mode: opts.mode,
          query: opts.query,
        },
      })

      const crawled = await crawlSite(seed, opts, cfg, timeout, ctx.abort)
      const perPageMax = Math.max(2000, Math.floor(opts.maxChars / Math.max(1, crawled.ok.length)))
      const sliced = crawled.ok.map((p) => ({ url: p.url, result: sliceResult(p.result, 0, perPageMax) }))
      const attachments = sliced.flatMap((p) => p.result.attachments ?? [])
      const host = new URL(seed).host

      const meta: WebFetchMeta = {
        urls: sliced.map((p) => p.url),
        crawl: {
          seed,
          visited: crawled.visited.size,
          depth_reached: crawled.depth,
          errors: crawled.errs.length,
        },
        results: sliced.map((p) => ({
          url: p.url,
          title: p.result.title,
          mime: p.result.mime,
          status: p.result.status,
          truncated: p.result.truncated,
          total: p.result.total,
          next_offset: p.result.next_offset,
          links: opts.includeLinks ? p.result.links : undefined,
        })),
        errors: crawled.errs,
      }

      const output = [
        `# Crawl: ${host} (${sliced.length} page${sliced.length === 1 ? "" : "s"}${
          crawled.depth > 0 ? `, depth ${crawled.depth}` : ""
        })`,
        "",
        ...sliced.map((p, i) =>
          [
            `## [${i + 1}] ${p.result.title}`,
            `*${p.url}*`,
            p.result.truncated
              ? `*(truncated: ${p.result.total} chars total, next_offset=${p.result.next_offset})*`
              : "",
            "",
            p.result.output,
            p.result.links.length
              ? ["", "### Links", ...p.result.links.slice(0, 20).map((l) => `- ${l}`)].join("\n")
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        ...(crawled.errs.length
          ? ["", "## Errors", ...crawled.errs.map((e) => `- ${e.url}: ${e.error}`)]
          : []),
      ].join("\n\n")

      return {
        title: `Crawled ${host}: ${sliced.length} page${sliced.length === 1 ? "" : "s"}`,
        output,
        metadata: meta,
        ...(attachments.length ? { attachments } : {}),
      }
    }

    await ctx.ask({
      permission: "webfetch",
      patterns: urls,
      always: ["*"],
      metadata: {
        urls,
        format: opts.format,
        mode: opts.mode,
        query: opts.query,
      },
    })

    const results = await Promise.allSettled(urls.map((u) => fetchOne(u, opts, timeout, ctx.abort)))

    const ok: { url: string; result: Fetched }[] = []
    const errs: { url: string; error: string }[] = []
    results.forEach((r, i) => {
      const u = urls[i]!
      if (r.status === "fulfilled") ok.push({ url: u, result: r.value })
      else errs.push({ url: u, error: r.reason?.message ?? String(r.reason) })
    })

    const attachments = ok.flatMap((p) => p.result.attachments ?? [])
    const imgOnly = ok.length > 0 && ok.every((p) => (p.result.attachments?.length ?? 0) > 0)

    const meta: WebFetchMeta = {
      urls,
      results: ok.map((p) => ({
        url: p.url,
        title: p.result.title,
        mime: p.result.mime,
        status: p.result.status,
        truncated: p.result.truncated,
        total: p.result.total,
        next_offset: p.result.next_offset,
        links: opts.includeLinks ? p.result.links : undefined,
      })),
      errors: errs,
    }

    if (imgOnly && attachments.length) {
      return {
        title: urls.length === 1 ? urls[0]! : `${urls.length} images fetched`,
        output: `Fetched ${attachments.length} image${attachments.length === 1 ? "" : "s"}`,
        metadata: meta,
        attachments,
      }
    }

    const output =
      ok.length === 1 && errs.length === 0
        ? ok[0]!.result.output
        : [
            ...ok.map((p, i) =>
              [
                `## [${i + 1}] ${p.result.title}`,
                p.result.truncated
                  ? `*(truncated: ${p.result.total} chars total, next_offset=${p.result.next_offset})*`
                  : "",
                "",
                p.result.output,
                p.result.links.length
                  ? ["", "### Links", ...p.result.links.slice(0, 20).map((l) => `- ${l}`)].join("\n")
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            ),
            ...(errs.length ? ["", "## Errors", ...errs.map((e) => `- ${e.url}: ${e.error}`)] : []),
          ].join("\n\n")

    return {
      title: urls.length === 1 ? urls[0]! : `${urls.length} pages fetched`,
      output,
      metadata: meta,
      ...(attachments.length ? { attachments } : {}),
    }
  },
})

function resolveUrls(params: { url?: string; urls?: string[] }): string[] {
  const out: string[] = []
  if (params.url) out.push(params.url)
  if (params.urls) out.push(...params.urls)
  return [...new Set(out)].slice(0, MAX_URLS)
}

type FetchOpts = {
  format: "markdown" | "text" | "html" | "raw"
  mode: "article" | "full"
  query?: string
  offset: number
  maxChars: number
  includeLinks: boolean
  livecrawl: "auto" | "never" | "force"
}

type CrawlOpts = {
  maxPages: number
  maxDepth: number
  sameOrigin: boolean
  include?: string[]
  exclude?: string[]
  concurrency: number
}

type CrawlPage = { url: string; result: Fetched }

type CrawlResult = {
  ok: CrawlPage[]
  errs: { url: string; error: string }[]
  depth: number
  visited: Set<string>
}

async function crawlSite(
  seed: string,
  opts: FetchOpts,
  cfg: CrawlOpts,
  timeoutMs: number,
  parentAbort: AbortSignal,
): Promise<CrawlResult> {
  const origin = new URL(seed).origin
  const visited = new Set<string>([seed])
  const ok: CrawlPage[] = []
  const errs: { url: string; error: string }[] = []
  let depth = 0
  const queue: { url: string; depth: number }[] = [{ url: seed, depth: 0 }]

  while (queue.length && ok.length < cfg.maxPages) {
    const room = cfg.maxPages - ok.length
    const batch = queue.splice(0, Math.min(cfg.concurrency, room))
    const settled = await Promise.allSettled(
      batch.map(async (item) => ({
        depth: item.depth,
        url: item.url,
        result: await fetchOne(item.url, opts, timeoutMs, parentAbort),
      })),
    )
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]!
      const item = batch[i]!
      if (s.status !== "fulfilled") {
        errs.push({ url: item.url, error: (s.reason as Error)?.message ?? String(s.reason) })
        continue
      }
      ok.push({ url: s.value.url, result: s.value.result })
      if (s.value.depth > depth) depth = s.value.depth
      if (ok.length >= cfg.maxPages) break
      if (s.value.depth >= cfg.maxDepth) continue
      for (const link of s.value.result.links) {
        if (visited.has(link)) continue
        if (!matchPath(link, origin, cfg)) continue
        visited.add(link)
        queue.push({ url: link, depth: s.value.depth + 1 })
      }
    }
  }
  return { ok, errs, depth, visited }
}

function matchPath(url: string, origin: string, cfg: CrawlOpts): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (cfg.sameOrigin && parsed.origin !== origin) return false
  const p = parsed.pathname || "/"
  if (cfg.exclude?.length && cfg.exclude.some((g) => Glob.match(g, p))) return false
  if (cfg.include?.length && !cfg.include.some((g) => Glob.match(g, p))) return false
  return true
}

async function fetchOne(url: string, params: FetchOpts, timeoutMs: number, parentAbort: AbortSignal): Promise<Fetched> {
  const key = `${url}|${params.format}|${params.mode}|${params.query ?? ""}`
  const cached = cacheGet(key)
  if (cached && params.livecrawl !== "force") {
    return sliceResult(cached, params.offset, params.maxChars)
  }

  if (params.livecrawl === "force") {
    const crawled = await exaCrawl(url, parentAbort)
    const processed = processText(crawled, url, params)
    cacheSet(key, processed)
    return sliceResult(processed, params.offset, params.maxChars)
  }

  const { signal, clearTimeout } = abortAfterAny(timeoutMs, parentAbort)
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Accept: acceptFor(params.format),
    "Accept-Language": "en-US,en;q=0.9",
  }
  const init: RequestInit = { signal, headers }
  const proxy = await Proxy.resolve(url)

  const response = await iife(async () => {
    try {
      const initial = await Proxy.fetch(url, init)
      return initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
        ? await Proxy.fetch(url, { ...init, headers: { ...headers, "User-Agent": "opencode" } })
        : initial
    } finally {
      clearTimeout()
    }
  })

  if (!response.ok) {
    if (response.status === 407) {
      const via = typeof proxy === "string" ? ` via ${Proxy.describe(proxy)}` : ""
      throw new Error(`Proxy authentication required (407)${via}. Set MACAW_PROXY_AUTH or MACAW_PAC_URL.`)
    }
    if (params.livecrawl === "auto") {
      const crawled = await exaCrawl(url, parentAbort).catch(() => null)
      if (crawled) {
        const processed = processText(crawled, url, params)
        cacheSet(key, processed)
        return sliceResult(processed, params.offset, params.maxChars)
      }
    }
    throw new Error(`Request failed with status code: ${response.status}`)
  }

  const contentType = response.headers.get("content-type") || ""
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
    throw new Error(`Response too large (${arrayBuffer.byteLength} bytes, exceeds ${MAX_RESPONSE_SIZE} cap)`)
  }

  if (mime.startsWith("image/") && mime !== "image/svg+xml") {
    const b64 = Buffer.from(arrayBuffer).toString("base64")
    return {
      title: `${url} (${mime})`,
      output: "Image fetched successfully",
      links: [],
      mime,
      status: response.status,
      truncated: false,
      total: arrayBuffer.byteLength,
      attachments: [{ type: "file", mime, url: `data:${mime};base64,${b64}` }],
    }
  }

  // PDF handling
  if (mime === "application/pdf" || url.toLowerCase().endsWith(".pdf")) {
    const text = await extractPdfText(new Uint8Array(arrayBuffer))
    const processed = processText(
      { title: url, mime: "application/pdf", status: response.status, html: "", text, url },
      url,
      params,
    )
    cacheSet(key, processed)
    return sliceResult(processed, params.offset, params.maxChars)
  }

  const raw = new TextDecoder().decode(arrayBuffer)
  const isHtml = mime.includes("html") || /^\s*<(!doctype html|html\b)/i.test(raw)

  let processed: Fetched
  if (isHtml) {
    processed = processHtml({ html: raw, url, mime, status: response.status }, params)
    if (
      params.livecrawl === "auto" &&
      params.mode === "article" &&
      processed.output.trim().length < 300 &&
      /<div[^>]*id=["'](?:root|app|__next)["']/i.test(raw)
    ) {
      const crawled = await exaCrawl(url, parentAbort).catch(() => null)
      if (crawled && crawled.text.length > processed.output.length) {
        processed = processText(crawled, url, params)
      }
    }
  } else {
    processed = processText(
      { title: url, mime, status: response.status, html: "", text: raw, url },
      url,
      params,
    )
  }

  cacheSet(key, processed)
  return sliceResult(processed, params.offset, params.maxChars)
}

function acceptFor(format: "markdown" | "text" | "html" | "raw") {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, application/pdf;q=0.5, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, application/pdf;q=0.5, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1"
    default:
      return "*/*"
  }
}

function processHtml(
  input: { html: string; url: string; mime: string; status: number },
  params: { format: "markdown" | "text" | "html" | "raw"; mode: "article" | "full"; query?: string },
): Fetched {
  if (params.format === "raw" || params.format === "html") {
    return {
      title: extractTitle(input.html) ?? input.url,
      output: input.html,
      links: extractLinks(input.html, input.url),
      mime: input.mime,
      status: input.status,
      truncated: false,
      total: input.html.length,
    }
  }

  const links = extractLinks(input.html, input.url)
  const { title, content } = params.mode === "article" ? readable(input.html, input.url) : fullHtml(input.html)
  const body =
    params.format === "text"
      ? htmlToText(content)
      : htmlToMarkdown(content)
  const focused = params.query ? focus(body, params.query) : body

  return {
    title: title ?? input.url,
    output: focused,
    links,
    mime: input.mime,
    status: input.status,
    truncated: false,
    total: focused.length,
  }
}

function processText(
  input: { title?: string; text: string; mime: string; status: number; html?: string; url: string },
  url: string,
  params: { format: "markdown" | "text" | "html" | "raw"; query?: string },
): Fetched {
  const body = input.text
  const focused = params.query ? focus(body, params.query) : body
  return {
    title: input.title ?? url,
    output: focused,
    links: input.html ? extractLinks(input.html, url) : [],
    mime: input.mime,
    status: input.status,
    truncated: false,
    total: focused.length,
  }
}

function sliceResult(result: Fetched, offset: number, maxChars: number): Fetched {
  if (result.attachments?.length) return result
  const total = result.output.length
  if (offset >= total && total > 0) {
    return { ...result, output: "", total, truncated: false, next_offset: undefined }
  }
  const sliced = result.output.slice(offset, offset + maxChars)
  const truncated = offset + maxChars < total
  return {
    ...result,
    output: sliced,
    total,
    truncated,
    next_offset: truncated ? offset + maxChars : undefined,
  }
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m?.[1]?.trim().replace(/\s+/g, " ")
}

function extractLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>()
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = m[1]!.trim()
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue
    const abs = safeResolve(href, baseUrl)
    if (abs) out.add(abs)
    if (out.size >= 50) break
  }
  return [...out]
}

function safeResolve(href: string, base: string): string | undefined {
  try {
    const u = new URL(href, base)
    if (u.protocol !== "http:" && u.protocol !== "https:") return
    u.hash = ""
    return u.toString()
  } catch {
    return
  }
}

function readable(html: string, url: string): { title?: string; content: string } {
  // Gated dynamic import so cold paths don't pay the cost / so typecheck still works if missing.
  // jsdom + Readability are heavy but robust.
  // Falls back to heuristic extraction on failure.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JSDOM } = require("jsdom") as typeof import("jsdom")
    const { Readability } = require("@mozilla/readability") as typeof import("@mozilla/readability")
    const dom = new JSDOM(html, { url })
    const article = new Readability(dom.window.document as unknown as Document).parse()
    if (article && article.content) {
      return { title: article.title ?? undefined, content: article.content }
    }
  } catch {
    // fall through
  }
  return fullHtml(stripChrome(html))
}

function fullHtml(html: string): { title?: string; content: string } {
  return { title: extractTitle(html), content: html }
}

function stripChrome(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, "")
    .replace(/<header\b[\s\S]*?<\/header>/gi, "")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, "")
    .replace(/<form\b[\s\S]*?<\/form>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
}

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  td.remove(["script", "style", "meta", "link"])
  return td.turndown(html).trim()
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// Keyword-overlap scoring of chunks against the query; retains most relevant.
function focus(body: string, query: string): string {
  const terms = tokens(query)
  if (!terms.length) return body
  const chunks = splitChunks(body)
  if (chunks.length <= 1) return body
  const df = new Map<string, number>()
  const tfs = chunks.map((c) => {
    const tf = new Map<string, number>()
    for (const t of tokens(c)) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    return tf
  })
  const N = chunks.length
  const scored = chunks.map((c, i) => {
    let s = 0
    for (const t of terms) {
      const f = tfs[i]!.get(t) ?? 0
      if (!f) continue
      const idf = Math.log((N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5) + 1)
      s += (f / (f + 1)) * idf
    }
    return { i, c, s }
  })
  const relevant = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
  if (!relevant.length) return body
  const keep = new Set(relevant.slice(0, Math.max(3, Math.ceil(N * 0.4))).map((x) => x.i))
  return chunks
    .map((c, i) => (keep.has(i) ? c : null))
    .filter((x): x is string => x !== null)
    .join("\n\n")
}

function splitChunks(body: string): string[] {
  const lines = body.split(/\n/)
  const chunks: string[] = []
  let buf: string[] = []
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && buf.length) {
      chunks.push(buf.join("\n").trim())
      buf = [line]
      continue
    }
    buf.push(line)
    if (buf.join("\n").length > 1500) {
      chunks.push(buf.join("\n").trim())
      buf = []
    }
  }
  if (buf.length) chunks.push(buf.join("\n").trim())
  return chunks.filter(Boolean)
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

const STOPWORDS = new Set(
  "the a an and or but of for to in on at by is are was were be been being this that these those with from as it its it's if then than so not no do does did have has had i you he she we they my your our their them his her about into over after before above below".split(
    /\s+/,
  ),
)


async function exaCrawl(
  url: string,
  parentAbort: AbortSignal,
): Promise<{ title?: string; text: string; html: string; mime: string; status: number; url: string }> {
  const { signal, clearTimeout } = abortAfterAny(30_000, parentAbort)
  try {
    const res = await Proxy.fetch(EXA_MCP_URL, {
      method: "POST",
      signal,
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_fetch_exa",
          arguments: { urls: [url], maxCharacters: 200_000 },
        },
      }),
    })
    if (!res.ok) throw new Error(`Exa crawl ${res.status}`)
    const body = await res.text()
    const line = body.split("\n").find((l) => l.startsWith("data: "))
    if (!line) throw new Error("Exa crawl: empty response")
    const payload = JSON.parse(line.slice(6))
    const text: string = payload?.result?.content?.[0]?.text ?? ""
    if (!text) throw new Error("Exa crawl: no content")
    return { title: url, text, html: "", mime: "text/plain", status: 200, url }
  } finally {
    clearTimeout()
  }
}
