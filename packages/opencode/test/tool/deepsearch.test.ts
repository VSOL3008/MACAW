import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { DeepSearchTool } from "../../src/tool/deepsearch"
import { Agent } from "../../src/agent/agent"
import { ToolRegistry } from "../../src/tool/registry"

const projectRoot = path.join(import.meta.dir, "../..")

describe("tool.deepsearch", () => {
  test("registers a 'researcher' subagent with websearch + webfetch allowed", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const agents = await Agent.list()
        const researcher = agents.find((a) => a.name === "researcher")
        expect(researcher).toBeDefined()
        expect(researcher?.mode).toBe("subagent")
        const allows = (perm: string) =>
          researcher!.permission.some((r) => r.permission === perm && r.action === "allow")
        expect(allows("websearch")).toBe(true)
        expect(allows("webfetch")).toBe(true)
        expect(allows("todowrite")).toBe(true)
      },
    })
  })

  test("exports a tool with id 'deepsearch'", () => {
    expect(DeepSearchTool.id).toBe("deepsearch")
  })

  test("registers 'deepsearch' and 'websearch' in the tool registry", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("deepsearch")
        expect(ids).toContain("websearch")
        expect(ids).toContain("webfetch")
      },
    })
  })

  test("parameter schema validates required query and rejects out-of-range depth", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const researcher = (await Agent.list()).find((a) => a.name === "researcher")!
        const tools = await ToolRegistry.tools({
          providerID: "anthropic" as never,
          modelID: "test" as never,
          agent: researcher,
        })
        const def = tools.find((t) => t.id === "deepsearch")
        if (!def) throw new Error("deepsearch not registered")

        const parsedOk = def.parameters.safeParse({ query: "what is a quokka?" })
        expect(parsedOk.success).toBe(true)

        const missingQuery = def.parameters.safeParse({})
        expect(missingQuery.success).toBe(false)

        const tooDeep = def.parameters.safeParse({ query: "x", depth: 10 })
        expect(tooDeep.success).toBe(false)

        const goodOptional = def.parameters.safeParse({
          query: "x",
          depth: 3,
          breadth: 8,
          focus: "technical",
          include_domains: ["example.com"],
        })
        expect(goodOptional.success).toBe(true)
      },
    })
  })
})
