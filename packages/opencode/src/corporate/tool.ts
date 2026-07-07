import z from "zod"
import { Tool } from "@/tool/tool"
import { Memory } from "@/memory/memory"
import * as Corporate from "./index"

const source = z.string().min(1).describe("Corporate source id from corporate_search.sources or a previously imported source.")
const rel = z.string().min(1).describe("Path relative to the corporate source root. Absolute paths and '..' are rejected.")

export const CorporateStatusTool = Tool.define("corp_status", {
  description: "Show corporate search source counts, sidecar index location, limits, and stale-entry status.",
  parameters: z.object({}),
  async execute(_input, ctx) {
    await ctx.ask({ permission: "corp_status", patterns: ["*"], always: ["*"], metadata: {} })
    const data = await Corporate.status()
    return {
      title: "corporate search",
      metadata: data,
      output: [
        `<index>${data.root}</index>`,
        `<totals sources="${data.totals.sources}" entries="${data.totals.entries}" stale="${data.totals.stale}" />`,
        "",
        data.sources
          .map((item) => `- ${item.id}: ${item.entries} entries, ${item.stale} stale, root=${item.root}`)
          .join("\n") || "(no corporate sources configured or imported)",
      ].join("\n"),
    }
  },
})

export const CorporateSearchTool = Tool.define("corp_search", {
  description:
    "Search the corporate shared-drive mirror by filename, path, extension, folder context, aliases, and local notes. Does not scan the real drive.",
  parameters: z.object({
    query: z.string().min(1).describe("Search terms, filename, extension, folder, or topic."),
    source: source.optional(),
    limit: z.number().int().positive().max(250).optional(),
    cursor: z.string().optional(),
  }),
  async execute(input, ctx) {
    await ctx.ask({ permission: "corp_search", patterns: [input.query], always: ["*"], metadata: input })
    const data = await Corporate.search(input)
    return {
      title: input.query,
      metadata: data,
      output:
        data.items
          .map((item) => {
            const note = item.notes ? `\n  notes: ${item.notes.replace(/\s+/g, " ").slice(0, 240)}` : ""
            return `- ${item.source}:${item.path} (${item.type}${item.ext ? `, .${item.ext}` : ""}, score ${Math.round(item.score)})${note}`
          })
          .join("\n") || "(no matches)",
    }
  },
})

export const CorporateListTool = Tool.define("corp_list", {
  description:
    "List one directory under an allowlisted corporate source, read-only, and refresh only that directory in the mirror.",
  parameters: z.object({
    source,
    path: z.string().optional().describe("Relative directory path. Defaults to the source root."),
    limit: z.number().int().positive().max(1000).optional(),
  }),
  async execute(input, ctx) {
    await ctx.ask({
      permission: "corp_list",
      patterns: [`${input.source}:${input.path ?? "."}`],
      always: ["*"],
      metadata: input,
    })
    const data = await Corporate.list(input)
    return {
      title: `${data.source}:${data.path || "."}`,
      metadata: data,
      output: [
        `<source>${data.source}</source>`,
        `<path>${data.path || "."}</path>`,
        `<mode>${data.mode}</mode>`,
        data.reason ? `<reason>${data.reason}</reason>` : "",
        `<entries>`,
        data.items.map((item) => `${item.type === "directory" ? "dir " : "file"} ${item.path}`).join("\n"),
        data.truncated ? "\n(results truncated by corporate_search.limits.entries)" : "",
        `</entries>`,
      ].join("\n"),
    }
  },
})

export const CorporateReadTool = Tool.define("corp_read", {
  description:
    "Read or extract one file under an allowlisted corporate source, read-only, with strict byte and text caps. Supports text, CSV, JSON, XML, logs, Markdown, PDF, DOCX, XLSX, and PPTX.",
  parameters: z.object({
    source,
    path: rel,
    offset: z.number().int().positive().optional().describe("Line offset for text-like files."),
    limit: z.number().int().positive().max(2000).optional().describe("Line limit for text-like files."),
  }),
  async execute(input, ctx) {
    await ctx.ask({
      permission: "corp_read",
      patterns: [`${input.source}:${input.path}`],
      always: ["*"],
      metadata: input,
    })
    const data = await Corporate.read(input)
    return {
      title: `${data.source}:${data.path}`,
      metadata: data,
      output: [
        `<source>${data.source}</source>`,
        `<path>${data.path}</path>`,
        `<type>${data.type}</type>`,
        `<available>${data.available}</available>`,
        data.reason ? `<reason>${data.reason}</reason>` : "",
        `<content>`,
        data.text,
        data.truncated ? "\n(output truncated by corporate_search limits)" : "",
        `</content>`,
      ].join("\n"),
    }
  },
})

export const CorporateNoteTool = Tool.define("corp_note", {
  description:
    "Add local notes or aliases to one corporate mirror entry after analysis. This updates only the sidecar index, never the real shared drive.",
  parameters: z.object({
    source,
    path: rel,
    notes: z.string().optional(),
    aliases: z.string().optional(),
  }),
  async execute(input, ctx) {
    await ctx.ask({
      permission: "corp_note",
      patterns: [`${input.source}:${input.path}`],
      always: ["*"],
      metadata: input,
    })
    const data = await Corporate.note(input)
    return {
      title: `${data.source}:${data.path}`,
      metadata: data,
      output: `Updated local corporate mirror notes for ${data.source}:${data.path}`,
    }
  },
})

export const CorporateImportTreeTool = Tool.define("corp_import_tree", {
  description:
    "Import tree command output into the corporate sidecar mirror. If root is not configured, asks before trusting it as a future read-only source root.",
  parameters: z.object({
    source,
    root: z.string().optional().describe("Absolute source root represented by the tree output."),
    label: z.string().optional(),
    tree: z.string().optional().describe("Optional path or description of the tree snapshot."),
    content: z.string().optional().describe("Raw tree command output."),
    memory_path: z.string().optional().describe("Memory wiki page containing tree command output."),
  }),
  async execute(input, ctx) {
    if (!input.content && !input.memory_path) throw new Error("corp_import_tree requires content or memory_path")
    if (input.root) {
      await ctx.ask({
        permission: "corp_source",
        patterns: [input.root],
        always: [input.root],
        metadata: { source: input.source, root: input.root },
      })
    }
    await ctx.ask({
      permission: "corp_import_tree",
      patterns: [input.source],
      always: ["*"],
      metadata: { source: input.source, memory_path: input.memory_path, tree: input.tree },
    })
    const content = input.content ?? (await Memory.read(input.memory_path!))
    const data = await Corporate.importTree({ ...input, content })
    return {
      title: input.source,
      metadata: data,
      output: `Imported ${data.imported} corporate mirror entries for ${data.source}; ${data.stale} stale entries remain.`,
    }
  },
})

export const CorporateImportFileTool = Tool.define("corp_import_file", {
  description:
    "Import a local tree command output file into the corporate sidecar mirror without passing large tree content through the agent context.",
  parameters: z.object({
    source,
    root: z.string().optional().describe("Absolute source root represented by the tree output."),
    label: z.string().optional(),
    file: z.string().min(1).describe("Local path to a tree command output file."),
    tree: z.string().optional().describe("Optional path or description of the tree snapshot."),
  }),
  async execute(input, ctx) {
    if (input.root) {
      await ctx.ask({
        permission: "corp_source",
        patterns: [input.root],
        always: [input.root],
        metadata: { source: input.source, root: input.root },
      })
    }
    await ctx.ask({
      permission: "corp_import_file",
      patterns: [input.file],
      always: ["*"],
      metadata: { source: input.source, file: input.file, tree: input.tree },
    })
    const data = await Corporate.importFile(input)
    return {
      title: input.source,
      metadata: data,
      output: `Imported ${data.imported} corporate mirror entries for ${data.source}; ${data.stale} stale entries remain.`,
    }
  },
})
