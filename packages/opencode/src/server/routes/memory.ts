import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { graph as buildGraph, page as readPage, pages as listPages, status as readStatus } from "../../memory/graph"

const NodeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    category: z.string(),
    size: z.number(),
    indegree: z.number(),
    outdegree: z.number(),
  })
  .meta({ ref: "MemoryGraphNode" })

const EdgeSchema = z
  .object({
    source: z.string(),
    target: z.string(),
  })
  .meta({ ref: "MemoryGraphEdge" })

const StatsSchema = z
  .object({
    total_nodes: z.number(),
    total_edges: z.number(),
    visible_nodes: z.number(),
    visible_edges: z.number(),
    query_nodes: z.number(),
    sampled: z.boolean(),
    indexing: z.boolean(),
    indexed_nodes: z.number(),
    index_total: z.number(),
    cache_age: z.number(),
    last_error: z.string().optional(),
  })
  .meta({ ref: "MemoryGraphStats" })

const GraphSchema = z
  .object({
    root: z.string(),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
    stats: StatsSchema,
  })
  .meta({ ref: "MemoryGraph" })

const PageSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .meta({ ref: "MemoryPage" })

const StatusSchema = z
  .object({
    root: z.string(),
    indexing: z.boolean(),
    indexed: z.number(),
    total: z.number(),
    pages: z.number(),
    links: z.number(),
    cache: z.boolean(),
    cache_age: z.number(),
    last_error: z.string().optional(),
  })
  .meta({ ref: "MemoryStatus" })

const ItemSchema = NodeSchema.extend({
  modified: z.number(),
}).meta({ ref: "MemoryPageItem" })

const PagesSchema = z
  .object({
    root: z.string(),
    items: z.array(ItemSchema),
    next_cursor: z.string().optional(),
    stats: StatusSchema.extend({
      total_matches: z.number(),
    }),
  })
  .meta({ ref: "MemoryPages" })

export const MemoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Memory wiki index status",
        description: "Return current memory wiki index counts and background indexing state.",
        operationId: "global.memory.status",
        responses: {
          200: {
            description: "Index status",
            content: {
              "application/json": {
                schema: resolver(StatusSchema),
              },
            },
          },
        },
      }),
      async (c) => {
        const data = await readStatus()
        return c.json(data)
      },
    )
    .get(
      "/pages",
      describeRoute({
        summary: "Memory wiki pages",
        description: "Return a bounded, cursor-paged list of memory wiki pages from the derived index.",
        operationId: "global.memory.pages",
        responses: {
          200: {
            description: "Page list",
            content: {
              "application/json": {
                schema: resolver(PagesSchema),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z
            .string()
            .optional()
            .meta({ description: "Optional search query for page title, path, and indexed text." }),
          limit: z.coerce.number().int().positive().max(250).optional().meta({ description: "Max pages to include." }),
          cursor: z.string().optional().meta({ description: "Cursor from the previous response." }),
        }),
      ),
      async (c) => {
        const q = c.req.valid("query")
        const data = await listPages(q)
        return c.json(data)
      },
    )
    .get(
      "/graph",
      describeRoute({
        summary: "Memory knowledge graph",
        description: "Return a bounded graph view plus summary stats from the memory wiki index.",
        operationId: "global.memory.graph",
        responses: {
          200: {
            description: "Graph data",
            content: {
              "application/json": {
                schema: resolver(GraphSchema),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string().optional().meta({ description: "Optional search query used to focus the graph." }),
          limit: z.coerce
            .number()
            .int()
            .positive()
            .max(4000)
            .optional()
            .meta({ description: "Max nodes to include in the returned graph view." }),
        }),
      ),
      async (c) => {
        const q = c.req.valid("query")
        const data = await buildGraph(q)
        return c.json(data)
      },
    )
    .get(
      "/page",
      describeRoute({
        summary: "Read a memory wiki page",
        description: "Return the raw markdown contents of a page in the user memory wiki.",
        operationId: "global.memory.page",
        responses: {
          200: {
            description: "Page contents",
            content: {
              "application/json": {
                schema: resolver(PageSchema),
              },
            },
          },
          404: {
            description: "Page not found",
            content: {
              "application/json": {
                schema: resolver(z.object({ error: z.string() })),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string().min(1).meta({ description: "Relative page path, e.g. 'user.md'" }),
        }),
      ),
      async (c) => {
        const q = c.req.valid("query")
        const result = await readPage(q.path).catch(() => undefined)
        if (!result) return c.json({ error: "Page not found" }, 404)
        return c.json(result)
      },
    ),
)
