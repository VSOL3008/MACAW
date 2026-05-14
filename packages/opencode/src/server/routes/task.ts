import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { Task } from "../../task/task"

const ScheduleInput = z.object({
  kind: z.enum(["cron", "interval", "iso", "delay"]),
  expr: z.string().min(1),
})

const CreateBody = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1),
  schedule: ScheduleInput,
  model: z.string().optional(),
  agent: z.string().optional(),
  workdir: z.string().optional(),
  repeat: z.number().int().positive().optional(),
  silent_marker: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_retries: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "paused"]).optional(),
})

const UpdateBody = CreateBody.partial()

const Detail = z
  .object({
    info: Task.Info,
    runs: z.array(Task.Run),
  })
  .meta({ ref: "TaskDetail" })

const idParam = z.object({ id: z.string().min(1) })
const stepsParam = z.object({ id: z.string().min(1), runID: z.string().min(1) })

export const TaskRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List tasks",
        operationId: "global.task.list",
        responses: {
          200: {
            description: "Task list",
            content: { "application/json": { schema: resolver(z.array(Task.Info)) } },
          },
        },
      }),
      async (c) => {
        return c.json(Task.list())
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create a task",
        operationId: "global.task.create",
        responses: {
          200: {
            description: "Created task",
            content: { "application/json": { schema: resolver(Task.Info) } },
          },
        },
      }),
      validator("json", CreateBody),
      async (c) => {
        const body = c.req.valid("json")
        const info = Task.create(body)
        return c.json(info)
      },
    )
    .get(
      "/:id",
      describeRoute({
        summary: "Get task with run history",
        operationId: "global.task.get",
        responses: {
          200: {
            description: "Task with runs",
            content: { "application/json": { schema: resolver(Detail) } },
          },
          404: {
            description: "Not found",
            content: { "application/json": { schema: resolver(z.object({ error: z.string() })) } },
          },
        },
      }),
      validator("param", idParam),
      async (c) => {
        const id = c.req.valid("param").id
        try {
          const info = Task.get(id)
          const runs = Task.runs(id, 50)
          return c.json({ info, runs })
        } catch {
          return c.json({ error: "Task not found" }, 404)
        }
      },
    )
    .patch(
      "/:id",
      describeRoute({
        summary: "Update a task",
        operationId: "global.task.update",
        responses: {
          200: {
            description: "Updated task",
            content: { "application/json": { schema: resolver(Task.Info) } },
          },
        },
      }),
      validator("param", idParam),
      validator("json", UpdateBody),
      async (c) => {
        const id = c.req.valid("param").id
        const body = c.req.valid("json")
        const info = Task.update(id, body)
        return c.json(info)
      },
    )
    .delete(
      "/:id",
      describeRoute({
        summary: "Remove a task",
        operationId: "global.task.remove",
        responses: {
          200: {
            description: "Removed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      validator("param", idParam),
      async (c) => {
        Task.remove(c.req.valid("param").id)
        return c.json(true)
      },
    )
    .post(
      "/:id/pause",
      describeRoute({
        summary: "Pause a task",
        operationId: "global.task.pause",
        responses: {
          200: {
            description: "Paused task",
            content: { "application/json": { schema: resolver(Task.Info) } },
          },
        },
      }),
      validator("param", idParam),
      async (c) => c.json(Task.pause(c.req.valid("param").id)),
    )
    .post(
      "/:id/resume",
      describeRoute({
        summary: "Resume a task",
        operationId: "global.task.resume",
        responses: {
          200: {
            description: "Resumed task",
            content: { "application/json": { schema: resolver(Task.Info) } },
          },
        },
      }),
      validator("param", idParam),
      async (c) => c.json(Task.resume(c.req.valid("param").id)),
    )
    .post(
      "/:id/run",
      describeRoute({
        summary: "Run a task on the next tick",
        operationId: "global.task.run",
        responses: {
          200: {
            description: "Task queued",
            content: { "application/json": { schema: resolver(Task.Info) } },
          },
        },
      }),
      validator("param", idParam),
      async (c) => c.json(Task.queueImmediate(c.req.valid("param").id)),
    )
    .get(
      "/:id/runs",
      describeRoute({
        summary: "Run history for a task",
        operationId: "global.task.runs",
        responses: {
          200: {
            description: "Run history",
            content: { "application/json": { schema: resolver(z.array(Task.Run)) } },
          },
        },
      }),
      validator("param", idParam),
      validator("query", z.object({ limit: z.coerce.number().int().positive().max(500).optional() })),
      async (c) => {
        const id = c.req.valid("param").id
        const limit = c.req.valid("query").limit ?? 50
        return c.json(Task.runs(id, limit))
      },
    )
    .post(
      "/:id/cancel",
      describeRoute({
        summary: "Cancel the active run for a task",
        operationId: "global.task.cancel",
        responses: {
          200: {
            description: "Cancelled run (or null if none was active)",
            content: { "application/json": { schema: resolver(Task.Run.nullable()) } },
          },
        },
      }),
      validator("param", idParam),
      async (c) => {
        const run = Task.cancel(c.req.valid("param").id)
        return c.json(run)
      },
    )
    .get(
      "/:id/runs/:runID/steps",
      describeRoute({
        summary: "Step timeline for a task run",
        operationId: "global.task.steps",
        responses: {
          200: {
            description: "Step list",
            content: { "application/json": { schema: resolver(z.array(Task.Step)) } },
          },
        },
      }),
      validator("param", stepsParam),
      validator("query", z.object({ limit: z.coerce.number().int().positive().max(2000).optional() })),
      async (c) => {
        const limit = c.req.valid("query").limit ?? 500
        return c.json(Task.steps(c.req.valid("param").runID, limit))
      },
    ),
)
