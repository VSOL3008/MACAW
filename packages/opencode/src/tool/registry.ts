import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { GlobTool } from "./glob"
import { ListTool } from "./ls"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { DeepSearchTool } from "./deepsearch"
import { InvalidTool } from "./invalid"
import { Tool } from "./tool"
import { Config } from "../config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { ProviderID, type ModelID } from "../provider/schema"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { Truncate } from "./truncate"
import { Glob } from "../util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Env } from "../env"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "../filesystem"
import { Agent } from "../agent/agent"
import { Permission } from "@/permission"
import { ScreenshotTool } from "./screenshot"
import { MouseTool } from "./mouse"
import { KeyboardTool } from "./keyboard"
import { WindowTool } from "./window"
import { ClipboardTool } from "./clipboard"
import { AppTool } from "./app"
// hidden: vision UI path (ui_ground/ui_navigate/ui_vision) left in the tree so
// it can be re-enabled later. Active path is the tree-only ui_tree + ui_act.
import { UIGroundTool as _UIGroundTool } from "./ui_ground"
import { UINavigateTool as _UINavigateTool } from "./ui_navigate"
import { UIVisionTool as _UIVisionTool } from "./ui_vision"
import { UITreeTool } from "./ui_tree"
import { UIActTool } from "./ui_act"
import { PowerShellTool } from "./powershell"
import { OutlookTool } from "./outlook"
import { ExcelTool } from "./excel"
import { MemoryReadTool, MemoryWriteTool, MemoryAppendTool, MemoryListTool, MemorySearchTool } from "../memory/tool"
import { SkillTool, SkillCreateTool } from "./skill"
import { TaskCronTool } from "../task/tool"
void _UIGroundTool
void _UINavigateTool
void _UIVisionTool

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  type TaskDef = Tool.InferDef<typeof TaskTool>
  type ReadDef = Tool.InferDef<typeof ReadTool>

  type State = {
    custom: Tool.Def[]
    builtin: Tool.Def[]
    task: TaskDef
    read: ReadDef
  }

  export interface Interface {
    readonly ids: () => Effect.Effect<string[]>
    readonly all: () => Effect.Effect<Tool.Def[]>
    readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
    readonly tools: (model: {
      providerID: ProviderID
      modelID: ModelID
      agent: Agent.Info
    }) => Effect.Effect<Tool.Def[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/ToolRegistry") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Config.Service
    | Plugin.Service
    | Question.Service
    | Todo.Service
    | Agent.Service
    | LSP.Service
    | FileTime.Service
    | Instruction.Service
    | AppFileSystem.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const plugin = yield* Plugin.Service
      const agents = yield* Agent.Service

      const task = yield* TaskTool
      const read = yield* ReadTool
      const question = yield* QuestionTool
      const todo = yield* TodoWriteTool
      const deepsearch = yield* DeepSearchTool

      const state = yield* InstanceState.make<State>(
        Effect.fn("ToolRegistry.state")(function* (ctx) {
          const custom: Tool.Def[] = []

          function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
            return {
              id,
              parameters: z.object(def.args),
              description: def.description,
              execute: async (args, toolCtx) => {
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = await def.execute(args as any, pluginCtx)
                const out = await Truncate.output(result, {}, await Agent.get(toolCtx.agent))
                return {
                  title: "",
                  output: out.truncated ? out.content : result,
                  metadata: {
                    truncated: out.truncated,
                    outputPath: out.truncated ? out.outputPath : undefined,
                  },
                }
              },
            }
          }

          const dirs = yield* config.directories()
          const matches = dirs.flatMap((dir) =>
            Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
          )
          if (matches.length) yield* config.waitForDependencies()
          for (const match of matches) {
            const namespace = path.basename(match, path.extname(match))
            const mod = yield* Effect.promise(
              () => import(process.platform === "win32" ? match : pathToFileURL(match).href),
            )
            for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
              custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
            }
          }

          const plugins = yield* plugin.list()
          for (const p of plugins) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
              custom.push(fromPlugin(id, def))
            }
          }

          const cfg = yield* config.get()
          const questionEnabled =
            ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

          const tool = yield* Effect.all({
            invalid: Tool.init(InvalidTool),
            bash: Tool.init(BashTool),
            read: Tool.init(read),
            list: Tool.init(ListTool),
            glob: Tool.init(GlobTool),
            task: Tool.init(task),
            fetch: Tool.init(WebFetchTool),
            websearch: Tool.init(WebSearchTool),
            deepsearch: Tool.init(deepsearch),
            todo: Tool.init(todo),
            question: Tool.init(question),
            screenshot: Tool.init(ScreenshotTool),
            mouse: Tool.init(MouseTool),
            keyboard: Tool.init(KeyboardTool),
            window: Tool.init(WindowTool),
            clipboard: Tool.init(ClipboardTool),
            app: Tool.init(AppTool),
            ui_tree: Tool.init(UITreeTool),
            ui_act: Tool.init(UIActTool),
            powershell: Tool.init(PowerShellTool),
            outlook: Tool.init(OutlookTool),
            excel: Tool.init(ExcelTool),
            memory_read: Tool.init(MemoryReadTool),
            memory_write: Tool.init(MemoryWriteTool),
            memory_append: Tool.init(MemoryAppendTool),
            memory_list: Tool.init(MemoryListTool),
            memory_search: Tool.init(MemorySearchTool),
            skill: Tool.init(SkillTool),
            skill_create: Tool.init(SkillCreateTool),
            task_cron: Tool.init(TaskCronTool),
          })

          return {
            custom,
            builtin: [
              tool.invalid,
              ...(questionEnabled ? [tool.question] : []),
              tool.bash,
              tool.read,
              tool.list,
              tool.glob,
              tool.task,
              tool.fetch,
              tool.websearch,
              tool.deepsearch,
              tool.todo,
              tool.screenshot,
              tool.mouse,
              tool.keyboard,
              tool.window,
              tool.clipboard,
              tool.app,
              tool.ui_tree,
              tool.ui_act,
              tool.powershell,
              tool.outlook,
              tool.excel,
              tool.memory_read,
              tool.memory_write,
              tool.memory_append,
              tool.memory_list,
              tool.memory_search,
              tool.skill,
              tool.skill_create,
              tool.task_cron,
            ],
            task: tool.task,
            read: tool.read,
          }
        }),
      )

      const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
        const s = yield* InstanceState.get(state)
        return [...s.builtin, ...s.custom] as Tool.Def[]
      })

      const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
        return (yield* all()).map((tool) => tool.id)
      })

      const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
        const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
        const filtered = items.filter(
          (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
        )
        const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
        const description = list
          .map(
            (item) =>
              `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
          )
          .join("\n")
        return ["Available agent types and the tools they have access to:", description].join("\n")
      })

      const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
        const filtered = yield* all()
        return yield* Effect.forEach(
          filtered,
          Effect.fnUntraced(function* (tool: Tool.Def) {
            using _ = log.time(tool.id)
            const output = {
              description: tool.description,
              parameters: tool.parameters,
            }
            yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
            return {
              id: tool.id,
              description: [output.description, tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined]
                .filter(Boolean)
                .join("\n"),
              parameters: output.parameters,
              execute: tool.execute,
              formatValidationError: tool.formatValidationError,
            }
          }),
          { concurrency: "unbounded" },
        )
      })

      const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
        const s = yield* InstanceState.get(state)
        return { task: s.task, read: s.read }
      })

      return Service.of({ ids, all, named, tools })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Question.defaultLayer),
      Layer.provide(Todo.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(FileTime.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
    ),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function ids() {
    return runPromise((svc) => svc.ids())
  }

  export async function tools(input: {
    providerID: ProviderID
    modelID: ModelID
    agent: Agent.Info
  }): Promise<(Tool.Def & { id: string })[]> {
    return runPromise((svc) => svc.tools(input))
  }
}
