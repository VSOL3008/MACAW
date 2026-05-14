import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { graph as buildGraph, page as readPage } from "../../memory/graph"

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

const GraphSchema = z
  .object({
    root: z.string(),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
  })
  .meta({ ref: "MemoryGraph" })

const PageSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .meta({ ref: "MemoryPage" })

export const MemoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/graph",
      describeRoute({
        summary: "Memory knowledge graph",
        description: "Scan the user memory wiki and return nodes (pages) and edges (markdown links between pages).",
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
      async (c) => {
        const data = await buildGraph()
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
