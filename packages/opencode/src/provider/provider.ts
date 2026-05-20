import { Auth } from "../auth"
import { Config } from "../config/config"
import { Env } from "../env"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import * as Ollama from "../util/ollama"
import { ProviderTransform } from "./transform"
import { ModelID, ProviderID } from "./schema"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import { NoSuchModelError } from "ai"
import { Effect, Layer, ServiceMap } from "effect"
import { NamedError } from "@macaw/util/error"
import fuzzysort from "fuzzysort"
import path from "path"
import z from "zod"

type CompatibleSDK = {
  languageModel?: (model: string) => LanguageModelV3
  chatModel?: (model: string) => LanguageModelV3
}

type Tag = {
  name: string
  modified_at?: string
  details?: {
    family?: string
    families?: string[]
  }
  capabilities?: string[]
}

type ModelCfg = z.infer<typeof Config.Model>

type State = {
  providers: Record<ProviderID, Provider.Info>
  models: Map<string, LanguageModelV3>
  sdk: Map<string, CompatibleSDK>
}

const OLLAMA_PROVIDER = ProviderID.ollama
const OLLAMA_NPM = "@ai-sdk/openai-compatible"
const OLLAMA_URL = Ollama.DEFAULT_URL
const OLLAMA_ENV = ["OLLAMA_API_KEY", "OLLAMA_BASE_URL", "OLLAMA_HOST"]
const MODEL_FALLBACK = "qwen3:latest"
const SMALL_HINTS = ["1.5b", "3b", "mini", "small"]
const PRIORITY = ["qwen3", "qwen2.5", "phi4", "llama3.2", "llama3.1", "mistral", "deepseek-r1"]

function pick<T>(...list: Array<T | undefined>) {
  for (const item of list) {
    if (item !== undefined) return item
  }
}

function root(url: string) {
  return Ollama.root(url)
}

function truthy(list?: string[], value?: string) {
  if (!value) return false
  return list?.includes(value) ?? false
}

function keyword(id: string, list: string[]) {
  const lower = id.toLowerCase()
  return list.some((item) => lower.includes(item))
}

function vision(id: string, tag?: Tag) {
  if (tag?.capabilities?.includes("vision")) return true
  const list = [id, tag?.details?.family, ...(tag?.details?.families ?? [])].filter((item): item is string =>
    Boolean(item),
  )
  return list.some((item) =>
    keyword(item, [
      "vision",
      "vl",
      "llava",
      "moondream",
      "minicpm",
      "qwen2.5vl",
      "qwen2.5-vl",
      "qwen3vl",
      "qwen3-vl",
      "qwen3_vl",
      "mai-ui",
      "mai_ui",
    ]),
  )
}

function reasoning(id: string) {
  return keyword(id, ["r1", "reason", "think", "qwen3", "deepseek"])
}

function ctx(id: string) {
  if (vision(id)) return 32_768
  if (keyword(id, ["qwen3", "qwen2.5", "llama3", "phi4"])) return 131_072
  if (keyword(id, ["deepseek", "mistral"])) return 65_536
  return 32_768
}

function score(id: string) {
  const lower = id.toLowerCase()
  const idx = PRIORITY.findIndex((item) => lower.includes(item))
  return idx === -1 ? PRIORITY.length : idx
}

function sortVariants(model: Provider.Model, cfg?: ModelCfg) {
  const base = ProviderTransform.variants(model)
  const extra = cfg?.variants ?? {}
  return Object.fromEntries(
    Object.entries({ ...base, ...extra }).filter(([, value]) => !("disabled" in value) || value.disabled !== true),
  )
}

function baseModel(id: string, url: string, tag?: Tag): Provider.Model {
  const hasVision = vision(id, tag)
  const hasReasoning = reasoning(id)
  const family = tag?.details?.family ?? tag?.details?.families?.[0]
  const model: Provider.Model = {
    id: ModelID.make(id),
    providerID: OLLAMA_PROVIDER,
    api: {
      id,
      url,
      npm: OLLAMA_NPM,
    },
    name: id,
    family,
    capabilities: {
      temperature: true,
      reasoning: hasReasoning,
      attachment: hasVision,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: hasVision,
        video: false,
        pdf: hasVision,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: ctx(id),
      output: 8_192,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: tag?.modified_at ?? new Date().toISOString(),
    variants: {},
  }
  model.variants = sortVariants(model)
  return model
}

function mergeModel(base: Provider.Model, cfg?: ModelCfg) {
  if (!cfg) return base
  const textIn = cfg.modalities?.input
  const textOut = cfg.modalities?.output
  const model: Provider.Model = {
    ...base,
    name: cfg.name ?? base.name,
    family: cfg.family ?? base.family,
    api: {
      id: cfg.id ?? base.api.id,
      url: cfg.provider?.api ?? base.api.url,
      npm: cfg.provider?.npm ?? base.api.npm,
    },
    capabilities: {
      temperature: cfg.temperature ?? base.capabilities.temperature,
      reasoning: cfg.reasoning ?? base.capabilities.reasoning,
      attachment: cfg.attachment ?? base.capabilities.attachment,
      toolcall: cfg.tool_call ?? base.capabilities.toolcall,
      input: {
        text: truthy(textIn, "text") || base.capabilities.input.text,
        audio: truthy(textIn, "audio") || base.capabilities.input.audio,
        image: truthy(textIn, "image") || base.capabilities.input.image,
        video: truthy(textIn, "video") || base.capabilities.input.video,
        pdf: truthy(textIn, "pdf") || base.capabilities.input.pdf,
      },
      output: {
        text: truthy(textOut, "text") || base.capabilities.output.text,
        audio: truthy(textOut, "audio") || base.capabilities.output.audio,
        image: truthy(textOut, "image") || base.capabilities.output.image,
        video: truthy(textOut, "video") || base.capabilities.output.video,
        pdf: truthy(textOut, "pdf") || base.capabilities.output.pdf,
      },
      interleaved: cfg.interleaved ?? base.capabilities.interleaved,
    },
    cost: {
      input: cfg.cost?.input ?? base.cost.input,
      output: cfg.cost?.output ?? base.cost.output,
      cache: {
        read: cfg.cost?.cache_read ?? base.cost.cache.read,
        write: cfg.cost?.cache_write ?? base.cost.cache.write,
      },
      experimentalOver200K: base.cost.experimentalOver200K,
    },
    limit: {
      context: cfg.limit?.context ?? base.limit.context,
      input: cfg.limit?.input ?? base.limit.input,
      output: cfg.limit?.output ?? base.limit.output,
    },
    status: cfg.status ?? base.status,
    options: {
      ...base.options,
      ...(cfg.options ?? {}),
    },
    headers: {
      ...base.headers,
      ...(cfg.headers ?? {}),
    },
    release_date: cfg.release_date ?? base.release_date,
  }
  model.capabilities.attachment =
    model.capabilities.attachment || model.capabilities.input.image || model.capabilities.input.pdf
  model.variants = sortVariants(model, cfg)
  return model
}

const SHOW_CACHE = new Map<string, { modified_at?: string; capabilities: string[] }>()

async function showCapabilities(url: string, tag: Tag, headers?: HeadersInit): Promise<string[]> {
  const key = `${root(url)}::${tag.name}`
  const cached = SHOW_CACHE.get(key)
  if (cached && cached.modified_at === tag.modified_at) return cached.capabilities
  const res = await fetch(`${root(url)}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify({ model: tag.name }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined)
  if (!res?.ok) return cached?.capabilities ?? []
  const json = (await res.json().catch(() => undefined)) as { capabilities?: unknown } | undefined
  const caps = Array.isArray(json?.capabilities) ? (json.capabilities.filter((c) => typeof c === "string") as string[]) : []
  SHOW_CACHE.set(key, { modified_at: tag.modified_at, capabilities: caps })
  return caps
}

async function discover(url: string, key?: string) {
  const headers = key ? { Authorization: `Bearer ${key}` } : undefined
  const res = await fetch(`${root(url)}/api/tags`, {
    headers,
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined)
  if (!res?.ok) return [] as Tag[]
  const json = await res.json().catch(() => undefined)
  const tags = z
    .object({
      models: z
        .array(
          z.object({
            name: z.string(),
            modified_at: z.string().optional(),
            details: z
              .object({
                family: z.string().optional(),
                families: z.array(z.string()).optional(),
              })
              .optional(),
          }),
        )
        .default([]),
    })
    .safeParse(json)
  if (!tags.success) return [] as Tag[]
  const enriched = await Promise.all(
    tags.data.models.map(async (tag) => ({
      ...tag,
      capabilities: await showCapabilities(url, tag, headers),
    })),
  )
  return enriched
}

async function build(cfg: Config.Info, saved?: string) {
  const providerCfg = cfg.provider?.[OLLAMA_PROVIDER]
  const key = pick(providerCfg?.options?.apiKey, saved, Ollama.envKey())
  const baseURL = pick(providerCfg?.options?.baseURL, Ollama.envURL(), OLLAMA_URL)!
  const models: Record<string, Provider.Model> = {}
  const tags = await discover(baseURL, key)
  for (const tag of tags) {
    models[tag.name] = baseModel(tag.name, baseURL, tag)
  }
  for (const [id, item] of Object.entries(providerCfg?.models ?? {})) {
    models[id] = mergeModel(models[id] ?? baseModel(item.id ?? id, item.provider?.api ?? baseURL), item)
  }
  if (Object.keys(models).length === 0) {
    const fallback = providerCfg?.models?.[MODEL_FALLBACK]
    models[MODEL_FALLBACK] = mergeModel(baseModel(fallback?.id ?? MODEL_FALLBACK, fallback?.provider?.api ?? baseURL), fallback)
  }
  return {
    [OLLAMA_PROVIDER]: {
      id: OLLAMA_PROVIDER,
      name: providerCfg?.name ?? "Ollama",
      source: providerCfg ? "config" : key ? "env" : "custom",
      env: providerCfg?.env ?? OLLAMA_ENV,
      key,
      options: {
        includeUsage: true,
        ...(providerCfg?.options ?? {}),
        baseURL,
      },
      models,
    },
  } satisfies Record<ProviderID, Provider.Info>
}

function modelKey(model: Provider.Model) {
  return `${model.providerID}/${model.id}`
}

export namespace Provider {
  export const Model = z
    .object({
      id: ModelID.zod,
      providerID: ProviderID.zod,
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: ProviderID.zod,
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  export interface Interface {
    readonly list: () => Effect.Effect<Record<ProviderID, Info>>
    readonly getProvider: (providerID: ProviderID) => Effect.Effect<Info>
    readonly getModel: (providerID: ProviderID, modelID: ModelID) => Effect.Effect<Model>
    readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV3>
    readonly closest: (
      providerID: ProviderID,
      query: string[],
    ) => Effect.Effect<{ providerID: ProviderID; modelID: string } | undefined>
    readonly getSmallModel: (providerID: ProviderID) => Effect.Effect<Model | undefined>
    readonly defaultModel: () => Effect.Effect<{ providerID: ProviderID; modelID: ModelID }>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@macaw/Provider") {}

  const layer: Layer.Layer<Service, never, Config.Service | Auth.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const auth = yield* Auth.Service

      const state = yield* InstanceState.make<State>(() =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const saved = yield* auth.get(OLLAMA_PROVIDER).pipe(Effect.orDie)
          const providers = yield* Effect.promise(() =>
            build(cfg, saved?.type === "api" ? saved.key : undefined),
          )
          return {
            providers,
            models: new Map<string, LanguageModelV3>(),
            sdk: new Map<string, CompatibleSDK>(),
          }
        }),
      )

      const list = Effect.fn("Provider.list")(() => InstanceState.use(state, (s) => s.providers))

      const getProvider = Effect.fn("Provider.getProvider")(function* (providerID: ProviderID) {
        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (provider) return provider
        throw new Error(`Provider not found: ${providerID}`)
      })

      const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderID, modelID: ModelID) {
        const provider = yield* getProvider(providerID)
        const info = provider.models[modelID]
        if (info) return info
        const suggestions = fuzzysort.go(modelID, Object.keys(provider.models), { limit: 3 }).map((item) => item.target)
        throw new ModelNotFoundError({ providerID, modelID, suggestions })
      })

      const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
        const s = yield* InstanceState.get(state)
        const existing = s.models.get(modelKey(model))
        if (existing) return existing
        return yield* Effect.promise(async () => {
          const provider = s.providers[model.providerID]
          const url = String(provider.options.baseURL ?? OLLAMA_URL)
          const cacheKey = JSON.stringify({
            url,
            key: provider.key,
            headers: model.headers,
          })
          let sdk = s.sdk.get(cacheKey)
          if (!sdk) {
            sdk = createOpenAICompatible({
              name: model.providerID,
              baseURL: url,
              ...(provider.options ?? {}),
              apiKey: provider.key,
              headers: {
                ...provider.options.headers,
                ...model.headers,
              },
            }) as CompatibleSDK
            s.sdk.set(cacheKey, sdk)
          }
          try {
            const language = sdk.languageModel?.(model.api.id) ?? sdk.chatModel?.(model.api.id)
            if (!language) throw new Error("Ollama client did not expose a chat model")
            s.models.set(modelKey(model), language)
            return language
          } catch (err) {
            if (err instanceof NoSuchModelError) {
              throw new ModelNotFoundError({ providerID: model.providerID, modelID: model.id })
            }
            throw new InitError({ providerID: model.providerID }, { cause: err })
          }
        })
      })

      const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderID, query: string[]) {
        const provider = yield* getProvider(providerID)
        const ids = Object.keys(provider.models)
        for (const item of query) {
          const match = fuzzysort.go(item, ids, { limit: 1 })[0]
          if (match) return { providerID, modelID: match.target }
        }
      })

      const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (providerID: ProviderID) {
        const provider = yield* getProvider(providerID)
        const match = sort(Object.values(provider.models)).find((item) => keyword(item.id, SMALL_HINTS))
        return match ?? sort(Object.values(provider.models))[0]
      })

      const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
        const cfg = yield* config.get()
        if (cfg.model) return parseModel(cfg.model)
        const provider = yield* getProvider(OLLAMA_PROVIDER)
        const recent = yield* Effect.promise(() =>
          Filesystem.readJson<{
            recent?: { providerID: ProviderID; modelID: ModelID }[]
          }>(path.join(Global.Path.state, "model.json"))
            .then((item) => item.recent ?? [])
            .catch(() => []),
        )
        for (const item of recent) {
          if (item.providerID !== provider.id) continue
          if (provider.models[item.modelID]) return item
        }
        const [model] = sort(Object.values(provider.models))
        if (!model) throw new Error("No Ollama models available")
        return { providerID: provider.id, modelID: model.id }
      })

      return Service.of({ list, getProvider, getModel, getLanguage, closest, getSmallModel, defaultModel })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Auth.defaultLayer)),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function getProvider(providerID: ProviderID) {
    return runPromise((svc) => svc.getProvider(providerID))
  }

  export async function getModel(providerID: ProviderID, modelID: ModelID) {
    return runPromise((svc) => svc.getModel(providerID, modelID))
  }

  export async function getLanguage(model: Model) {
    return runPromise((svc) => svc.getLanguage(model))
  }

  export async function closest(providerID: ProviderID, query: string[]) {
    return runPromise((svc) => svc.closest(providerID, query))
  }

  export async function getSmallModel(providerID: ProviderID) {
    return runPromise((svc) => svc.getSmallModel(providerID))
  }

  export async function defaultModel() {
    return runPromise((svc) => svc.defaultModel())
  }

  export function sort<T extends { id: string }>(models: T[]) {
    return models.toSorted((a, b) => {
      const left = score(a.id)
      const right = score(b.id)
      if (left !== right) return left - right
      return a.id.localeCompare(b.id)
    })
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: ProviderID.make(providerID),
      modelID: ModelID.make(rest.join("/")),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: ProviderID.zod,
    }),
  )
}
