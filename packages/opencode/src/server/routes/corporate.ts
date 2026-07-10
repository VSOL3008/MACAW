import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { Memory } from "@/memory/memory"
import * as Corporate from "@/corporate"

const SourceSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    root: z.string(),
    tree: z.string().optional(),
    entries: z.number(),
    stale: z.number(),
    imported: z.number().optional(),
  })
  .meta({ ref: "CorporateSourceStatus" })

const LimitSchema = z
  .object({
    results: z.number(),
    entries: z.number(),
    bytes: z.number(),
    text: z.number(),
  })
  .meta({ ref: "CorporateLimits" })

const StatusSchema = z
  .object({
    root: z.string(),
    sources: z.array(SourceSchema),
    totals: z.object({
      sources: z.number(),
      entries: z.number(),
      stale: z.number(),
    }),
    limits: LimitSchema,
  })
  .meta({ ref: "CorporateStatus" })

const EntrySchema = z
  .object({
    source: z.string(),
    path: z.string(),
    name: z.string(),
    ext: z.string(),
    type: z.enum(["file", "directory"]),
    parent: z.string(),
    depth: z.number(),
    size: z.number().optional(),
    modified: z.number().optional(),
    discovered: z.number(),
    stale: z.boolean(),
    notes: z.string(),
    aliases: z.string(),
  })
  .meta({ ref: "CorporateEntry" })

const SearchSchema = z
  .object({
    items: z.array(EntrySchema.extend({ score: z.number() })),
    next_cursor: z.string().optional(),
    stats: z.object({
      total_matches: z.number(),
      limit: z.number(),
    }),
  })
  .meta({ ref: "CorporateSearch" })

const ImportSchema = z
  .object({
    source: z.string(),
    imported: z.number(),
    stale: z.number(),
  })
  .meta({ ref: "CorporateImport" })

const ListSchema = z
  .object({
    source: z.string(),
    path: z.string(),
    items: z.array(EntrySchema),
    truncated: z.boolean(),
    mode: z.enum(["disk", "index"]),
    reason: z.string().optional(),
  })
  .meta({ ref: "CorporateList" })

const ReadSchema = z
  .object({
    source: z.string(),
    path: z.string(),
    type: z.string(),
    text: z.string(),
    truncated: z.boolean(),
    bytes: z.number(),
    available: z.boolean(),
    reason: z.string().optional(),
  })
  .meta({ ref: "CorporateRead" })

const ErrorSchema = z.object({ error: z.string() }).meta({ ref: "CorporateError" })

export const CorporateRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "TEF Search index status",
        description: "Return corporate mirror source counts, index location, and limits.",
        operationId: "global.corporate.status",
        responses: {
          200: {
            description: "TEF Search status",
            content: { "application/json": { schema: resolver(StatusSchema) } },
          },
        },
      }),
      async (c) => c.json(await Corporate.status()),
    )
    .get(
      "/search",
      describeRoute({
        summary: "TEF Search mirror search",
        description: "Search the metadata-only shared-drive mirror without scanning the real drive.",
        operationId: "global.corporate.search",
        responses: {
          200: {
            description: "Search results",
            content: { "application/json": { schema: resolver(SearchSchema) } },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string().min(1),
          source: z.string().optional(),
          limit: z.coerce.number().int().positive().max(250).optional(),
          cursor: z.string().optional(),
        }),
      ),
      async (c) => c.json(await Corporate.search(c.req.valid("query"))),
    )
    .post(
      "/import",
      describeRoute({
        summary: "Import corporate tree",
        description: "Import tree command output or a memory page into the corporate sidecar mirror.",
        operationId: "global.corporate.import",
        responses: {
          200: {
            description: "Import result",
            content: { "application/json": { schema: resolver(ImportSchema) } },
          },
          400: {
            description: "Bad request",
            content: { "application/json": { schema: resolver(ErrorSchema) } },
          },
        },
      }),
      validator(
        "json",
        z.object({
          source: z.string().min(1),
          root: z.string().optional(),
          label: z.string().optional(),
          tree: z.string().optional(),
          content: z.string().optional(),
          memory_path: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        if (!body.content && !body.memory_path) return c.json({ error: "content or memory_path is required" }, 400)
        const content = body.content ?? (await Memory.read(body.memory_path!))
        return c.json(await Corporate.importTree({ ...body, content }))
      },
    )
    .post(
      "/import/file",
      describeRoute({
        summary: "Import corporate tree file",
        description: "Stream a local tree command output file into the corporate sidecar mirror.",
        operationId: "global.corporate.importFile",
        responses: {
          200: {
            description: "Import result",
            content: { "application/json": { schema: resolver(ImportSchema) } },
          },
          400: {
            description: "Bad request",
            content: { "application/json": { schema: resolver(ErrorSchema) } },
          },
        },
      }),
      validator(
        "json",
        z.object({
          source: z.string().min(1),
          root: z.string().optional(),
          label: z.string().optional(),
          tree: z.string().optional(),
          file: z.string().min(1),
        }),
      ),
      async (c) => c.json(await Corporate.importFile(c.req.valid("json"))),
    )
    .post(
      "/list",
      describeRoute({
        summary: "List one corporate directory",
        description: "Read-only list for one allowlisted source directory. Uses indexed metadata by default; refresh=true updates one real directory in the mirror.",
        operationId: "global.corporate.list",
        responses: {
          200: {
            description: "Directory entries",
            content: { "application/json": { schema: resolver(ListSchema) } },
          },
        },
      }),
      validator(
        "json",
        z.object({
          source: z.string().min(1),
          path: z.string().optional(),
          limit: z.number().int().positive().max(1000).optional(),
          refresh: z.boolean().optional(),
        }),
      ),
      async (c) => c.json(await Corporate.list(c.req.valid("json"))),
    )
    .post(
      "/read",
      describeRoute({
        summary: "Read one corporate file",
        description: "Read-only capped extraction for one file under an allowlisted corporate source.",
        operationId: "global.corporate.read",
        responses: {
          200: {
            description: "Extracted content",
            content: { "application/json": { schema: resolver(ReadSchema) } },
          },
        },
      }),
      validator(
        "json",
        z.object({
          source: z.string().min(1),
          path: z.string().min(1),
          offset: z.number().int().positive().optional(),
          limit: z.number().int().positive().max(2000).optional(),
        }),
      ),
      async (c) => c.json(await Corporate.read(c.req.valid("json"))),
    )
    .post(
      "/note",
      describeRoute({
        summary: "Annotate corporate mirror entry",
        description: "Update local sidecar notes or aliases for one mirror entry only.",
        operationId: "global.corporate.note",
        responses: {
          200: {
            description: "Updated entry",
            content: { "application/json": { schema: resolver(EntrySchema) } },
          },
        },
      }),
      validator(
        "json",
        z.object({
          source: z.string().min(1),
          path: z.string().min(1),
          notes: z.string().optional(),
          aliases: z.string().optional(),
        }),
      ),
      async (c) => c.json(await Corporate.note(c.req.valid("json"))),
    ),
)
