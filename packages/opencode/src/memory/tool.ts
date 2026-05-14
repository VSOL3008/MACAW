import z from "zod"
import { Tool } from "../tool/tool"
import { Memory } from "./memory"

const pathArg = z
  .string()
  .min(1)
  .describe("Path relative to the memory wiki root, e.g. 'user.md' or 'preferences/editor.md'. No absolute paths, no '..'.")

export const MemoryReadTool = Tool.define("memory_read", {
  description:
    "Read a page from the long-term user memory wiki. Paths are relative to the memory root. The wiki always contains user.md, index.md, log.md, and SCHEMA.md, plus any topic pages the agent has created.",
  parameters: z.object({
    path: pathArg,
  }),
  async execute(input) {
    const text = await Memory.read(input.path).catch((err) => {
      throw new Error(`memory_read failed for "${input.path}": ${err instanceof Error ? err.message : String(err)}`)
    })
    return {
      title: input.path,
      output: text || "(empty)",
      metadata: { bytes: Buffer.byteLength(text, "utf8") },
    }
  },
})

export const MemoryWriteTool = Tool.define("memory_write", {
  description:
    "Create or overwrite a memory wiki page. The content replaces the whole file. Prefer updating existing pages over creating duplicates. Keep pages compact and factual. Never write secrets. New pages are automatically registered in index.md, but you should still include at least one outbound markdown link to a related existing page so the new node is connected in the memory graph.",
  parameters: z.object({
    path: pathArg,
    content: z.string().describe("Full markdown content of the page. Must include an H1 header."),
  }),
  async execute(input) {
    const max = Memory.maxFile()
    if (Buffer.byteLength(input.content, "utf8") > max) {
      throw new Error(`memory_write refused: content exceeds ${max} bytes`)
    }
    const fresh = !(await Memory.has(input.path))
    await Memory.write(input.path, input.content)
    await Memory.logEntry("write", input.path)
    const notes: string[] = []
    if (fresh) {
      const label = Memory.title(input.content, input.path)
      const linked = await Memory.register(input.path, label).catch(() => false)
      if (linked) notes.push("auto-registered in index.md")
      if (!Memory.isHub(input.path) && Memory.links(input.content).length === 0) {
        notes.push("page has no outbound wiki link; add one so the graph stays connected")
      }
    }
    const tail = notes.length > 0 ? ` (${notes.join("; ")})` : ""
    return {
      title: input.path,
      output: `Wrote ${input.path}.${tail}`,
      metadata: { bytes: Buffer.byteLength(input.content, "utf8"), created: fresh },
    }
  },
})

export const MemoryAppendTool = Tool.define("memory_append", {
  description:
    "Append content to an existing memory wiki page (creates it if missing). Use this for journal-style pages or running lists. A trailing newline is added automatically. If the file does not exist yet, it is created and auto-registered in index.md.",
  parameters: z.object({
    path: pathArg,
    content: z.string().describe("Markdown snippet to append."),
  }),
  async execute(input) {
    const max = Memory.maxFile()
    if (Buffer.byteLength(input.content, "utf8") > max) {
      throw new Error(`memory_append refused: content exceeds ${max} bytes`)
    }
    const fresh = !(await Memory.has(input.path))
    await Memory.append(input.path, input.content)
    await Memory.logEntry("append", input.path)
    let tail = ""
    if (fresh) {
      const body = await Memory.read(input.path).catch(() => input.content)
      const label = Memory.title(body, input.path)
      const linked = await Memory.register(input.path, label).catch(() => false)
      if (linked) tail = " (auto-registered in index.md)"
    }
    return {
      title: input.path,
      output: `Appended to ${input.path}.${tail}`,
      metadata: { bytes: Buffer.byteLength(input.content, "utf8"), created: fresh },
    }
  },
})

export const MemoryListTool = Tool.define("memory_list", {
  description: "List every page in the memory wiki as relative paths, sizes, and last-modified times.",
  parameters: z.object({}),
  async execute() {
    const entries = await Memory.list()
    if (entries.length === 0) {
      return { title: "memory", output: "(empty)", metadata: { count: 0 } }
    }
    const lines = entries.map(
      (entry) => `- ${entry.path} (${entry.size} bytes, ${new Date(entry.modified).toISOString()})`,
    )
    return {
      title: "memory",
      output: lines.join("\n"),
      metadata: { count: entries.length },
    }
  },
})

export const MemorySearchTool = Tool.define("memory_search", {
  description: "Case-insensitive substring search across every memory wiki page. Returns matching lines with path and line number.",
  parameters: z.object({
    query: z.string().min(1).describe("Substring to search for."),
    limit: z.number().int().positive().max(100).optional().describe("Max matches to return (default 20)."),
  }),
  async execute(input) {
    const hits = await Memory.search(input.query, input.limit ?? 20)
    if (hits.length === 0) {
      return { title: input.query, output: "(no matches)", metadata: { hits: 0 } }
    }
    const lines = hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`)
    return {
      title: input.query,
      output: lines.join("\n"),
      metadata: { hits: hits.length },
    }
  },
})
