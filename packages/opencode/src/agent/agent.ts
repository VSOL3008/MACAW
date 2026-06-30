import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_RESEARCHER from "./prompt/researcher.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_MACAW from "../session/prompt/macaw.txt"
import PROMPT_ZERO_TRUST from "../session/prompt/zero-trust.txt"
import PROMPT_CORPORATE_SEARCH from "../session/prompt/corporate-search.txt"
import { Permission } from "@/permission"
import { CorporatePermission } from "@/corporate/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, ServiceMap, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: Permission.Ruleset,
      model: z
        .object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  export interface Interface {
    readonly get: (agent: string) => Effect.Effect<Agent.Info>
    readonly list: () => Effect.Effect<Agent.Info[]>
    readonly defaultAgent: () => Effect.Effect<string>
    readonly generate: (input: {
      description: string
      model?: { providerID: ProviderID; modelID: ModelID }
    }) => Effect.Effect<{
      identifier: string
      whenToUse: string
      systemPrompt: string
    }>
  }

  type State = Omit<Interface, "generate">

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Agent") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const auth = yield* Auth.Service
      const skill = yield* Skill.Service
      const provider = yield* Provider.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("Agent.state")(function* (ctx) {
          const cfg = yield* config.get()
          const skillDirs = yield* skill.dirs()
          const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]

          const defaults = Permission.fromConfig({
            "*": "allow",
            doom_loop: "ask",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
            question: "deny",
            plan_enter: "deny",
            plan_exit: "deny",
            task_cron: "deny",
            // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
            read: {
              "*": "allow",
              "*.env": "ask",
              "*.env.*": "ask",
              "*.env.example": "allow",
            },
          })
          const desk = Permission.fromConfig({
            edit: "deny",
            write: "deny",
            multiedit: "deny",
            apply_patch: "deny",
            grep: "deny",
            codesearch: "deny",
            websearch: "deny",
            deepsearch: "deny",
            skill: "deny",
            lsp: "deny",
          })

          const user = Permission.fromConfig(cfg.permission ?? {})

          const agents: Record<string, Info> = {
            build: {
              name: "build",
              description: "Desktop automation agent for apps, windows, screenshots, files, and shell tasks.",
              options: {},
              permission: Permission.merge(
                defaults,
                desk,
                Permission.fromConfig({
                  question: "allow",
                  plan_enter: "allow",
                  task_cron: "allow",
                }),
                user,
              ),
              mode: "primary",
              native: true,
              prompt: PROMPT_MACAW,
            },
            file_shell: {
              name: "file_shell",
              description: "File and shell agent. Focuses on local files and terminal work without desktop UI control.",
              options: {},
              permission: Permission.merge(
                defaults,
                desk,
                Permission.fromConfig({
                  question: "allow",
                  plan_enter: "allow",
                  screenshot: "deny",
                  ui_vision: "deny",
                  ui_ground: "deny",
                  ui_navigate: "deny",
                  ui_tree: "deny",
                  ui_act: "deny",
                  powershell: "deny",
                  outlook: "deny",
                  excel: "deny",
                  excel_macro: "deny",
                  mouse: "deny",
                  keyboard: "deny",
                  window: "deny",
                  clipboard: "deny",
                  app: "deny",
                }),
                user,
              ),
              mode: "primary",
              native: true,
              prompt: PROMPT_MACAW,
            },
            zero_trust: {
              name: "zero_trust",
              description: "Zero-trust desktop agent. Confirms every assumption with the user before acting.",
              options: {},
              permission: Permission.merge(
                defaults,
                desk,
                Permission.fromConfig({
                  question: "allow",
                  plan_enter: "allow",
                  task_cron: "ask",
                  bash: "ask",
                  powershell: "ask",
                  mouse: "ask",
                  keyboard: "ask",
                  window: "ask",
                  clipboard: "ask",
                  app: "ask",
                  ui_act: "ask",
                  excel: "ask",
                  excel_macro: "ask",
                  outlook: "ask",
                  memory_write: "ask",
                  memory_append: "ask",
                  skill_create: "ask",
                }),
                user,
              ),
              mode: "primary",
              native: true,
              prompt: PROMPT_MACAW + "\n\n" + PROMPT_ZERO_TRUST,
            },
            corporate_search: {
              name: "corporate_search",
              description:
                "Read-only corporate shared-drive search agent. Uses the local corporate mirror, then targeted read-only file analysis.",
              options: {},
              permission: Permission.merge(
                defaults,
                CorporatePermission.rules(),
                user,
              ),
              mode: "primary",
              native: true,
              prompt: PROMPT_MACAW + "\n\n" + PROMPT_CORPORATE_SEARCH,
            },
            plan: {
              name: "plan",
              description: "Plan mode. Disallows all edit tools.",
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  question: "allow",
                  plan_exit: "allow",
                  external_directory: {
                    [path.join(Global.Path.data, "plans", "*")]: "allow",
                  },
                  edit: {
                    "*": "deny",
                    [path.join(".opencode", "plans", "*.md")]: "allow",
                    [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]:
                      "allow",
                  },
                }),
                user,
              ),
              mode: "primary",
              native: true,
            },
            general: {
              name: "general",
              description: `General-purpose agent for researching complex questions and executing multi-step local tasks in parallel.`,
              permission: Permission.merge(
                defaults,
                desk,
                Permission.fromConfig({
                  todowrite: "deny",
                }),
                user,
              ),
              options: {},
              mode: "subagent",
              native: true,
              prompt: PROMPT_MACAW,
            },
            explore: {
              name: "explore",
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                  glob: "allow",
                  list: "allow",
                  fetch: "allow",
                  read: "allow",
                  external_directory: {
                    "*": "ask",
                    ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
                  },
                }),
                user,
              ),
              description: `Fast read-only agent specialized for inspecting the workspace and gathering local context. Use this when you need file listings, targeted reads, or lightweight web fetches without making changes.`,
              prompt: PROMPT_EXPLORE,
              options: {},
              mode: "subagent",
              native: true,
            },
            researcher: {
              name: "researcher",
              description: `Deep web research subagent: plans sub-queries, runs websearch + webfetch in parallel, verifies, and returns a cited markdown report.`,
              permission: Permission.merge(
                defaults,
                desk,
                Permission.fromConfig({
                  "*": "deny",
                  websearch: "allow",
                  webfetch: "allow",
                  todowrite: "allow",
                  question: "allow",
                }),
                user,
              ),
              prompt: PROMPT_RESEARCHER,
              options: {},
              mode: "subagent",
              native: true,
            },
            compaction: {
              name: "compaction",
              mode: "primary",
              native: true,
              hidden: true,
              prompt: PROMPT_COMPACTION,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              options: {},
            },
            title: {
              name: "title",
              mode: "primary",
              options: {},
              native: true,
              hidden: true,
              temperature: 0.5,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              prompt: PROMPT_TITLE,
            },
            summary: {
              name: "summary",
              mode: "primary",
              options: {},
              native: true,
              hidden: true,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              prompt: PROMPT_SUMMARY,
            },
          }

          for (const [key, value] of Object.entries(cfg.agent ?? {})) {
            if (value.disable) {
              delete agents[key]
              continue
            }
            let item = agents[key]
            if (!item)
              item = agents[key] = {
                name: key,
                mode: "all",
                permission: Permission.merge(defaults, user),
                options: {},
                native: false,
              }
            if (value.model) item.model = Provider.parseModel(value.model)
            item.variant = value.variant ?? item.variant
            item.prompt = value.prompt ?? item.prompt
            item.description = value.description ?? item.description
            item.temperature = value.temperature ?? item.temperature
            item.topP = value.top_p ?? item.topP
            item.mode = value.mode ?? item.mode
            item.color = value.color ?? item.color
            item.hidden = value.hidden ?? item.hidden
            item.name = value.name ?? item.name
            item.steps = value.steps ?? item.steps
            item.options = mergeDeep(item.options, value.options ?? {})
            item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
          }

          // Ensure Truncate.GLOB is allowed unless explicitly configured
          for (const name in agents) {
            const agent = agents[name]
            const explicit = agent.permission.some((r) => {
              if (r.permission !== "external_directory") return false
              if (r.action !== "deny") return false
              return r.pattern === Truncate.GLOB
            })
            if (explicit) continue

            agents[name].permission = Permission.merge(
              agents[name].permission,
              Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
            )
          }

          const get = Effect.fnUntraced(function* (agent: string) {
            return agents[agent]
          })

          const list = Effect.fnUntraced(function* () {
            const cfg = yield* config.get()
            return pipe(
              agents,
              values(),
              sortBy(
                [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
                [(x) => x.name, "asc"],
              ),
            )
          })

          const defaultAgent = Effect.fnUntraced(function* () {
            const c = yield* config.get()
            if (c.default_agent) {
              const agent = agents[c.default_agent]
              if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
              if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
              if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
              return agent.name
            }
            const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
            if (!visible) throw new Error("no primary visible agent found")
            return visible.name
          })

          return {
            get,
            list,
            defaultAgent,
          } satisfies State
        }),
      )

      return Service.of({
        get: Effect.fn("Agent.get")(function* (agent: string) {
          return yield* InstanceState.useEffect(state, (s) => s.get(agent))
        }),
        list: Effect.fn("Agent.list")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.list())
        }),
        defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
        }),
        generate: Effect.fn("Agent.generate")(function* (input: {
          description: string
          model?: { providerID: ProviderID; modelID: ModelID }
        }) {
          const cfg = yield* config.get()
          const model = input.model ?? (yield* provider.defaultModel())
          const resolved = yield* provider.getModel(model.providerID, model.modelID)
          const language = yield* provider.getLanguage(resolved)

          const system = [PROMPT_GENERATE]
          yield* Effect.promise(() =>
            Plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system }),
          )
          const existing = yield* InstanceState.useEffect(state, (s) => s.list())

          // TODO: clean this up so provider specific logic doesnt bleed over
          const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
          const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

          const params = {
            experimental_telemetry: {
              isEnabled: cfg.experimental?.openTelemetry,
              metadata: {
                userId: cfg.username ?? "unknown",
              },
            },
            temperature: 0.3,
            messages: [
              ...(isOpenaiOauth
                ? []
                : system.map(
                    (item): ModelMessage => ({
                      role: "system",
                      content: item,
                    }),
                  )),
              {
                role: "user",
                content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
              },
            ],
            model: language,
            schema: z.object({
              identifier: z.string(),
              whenToUse: z.string(),
              systemPrompt: z.string(),
            }),
          } satisfies Parameters<typeof generateObject>[0]

          if (isOpenaiOauth) {
            return yield* Effect.promise(async () => {
              const result = streamObject({
                ...params,
                providerOptions: ProviderTransform.providerOptions(resolved, {
                  instructions: system.join("\n"),
                  store: false,
                }),
                onError: () => {},
              })
              for await (const part of result.fullStream) {
                if (part.type === "error") throw part.error
              }
              return result.object
            })
          }

          return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
        }),
      })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Auth.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Skill.defaultLayer),
    ),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(agent: string) {
    return runPromise((svc) => svc.get(agent))
  }

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function defaultAgent() {
    return runPromise((svc) => svc.defaultAgent())
  }

  export async function generate(input: { description: string; model?: { providerID: ProviderID; modelID: ModelID } }) {
    return runPromise((svc) => svc.generate(input))
  }
}
