import z from "zod"
import { Provider } from "../provider/provider"
import { Tool } from "./tool"

const reply = z.object({
  message: z
    .object({
      content: z.string().optional(),
    })
    .optional(),
})

export type UIModel = {
  model: Provider.Model
  prov: Provider.Info
}

function root(url: string) {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "")
}

export function pick(msgs: Tool.Context["messages"]) {
  const msg = msgs.findLast((item) => item.info.role === "user")
  if (!msg || msg.info.role !== "user") throw new Error("No user message available for UI tool.")
  return msg.info.uiModel ?? msg.info.model
}

export function base64(url: string) {
  const idx = url.indexOf(",")
  if (idx === -1) throw new Error("Invalid screenshot data.")
  return url.slice(idx + 1)
}

export function size(url: string) {
  const buf = Buffer.from(base64(url), "base64")
  if (buf.toString("ascii", 1, 4) !== "PNG") throw new Error("UI tools expect PNG screenshots.")
  return {
    w: buf.readUInt32BE(16),
    h: buf.readUInt32BE(20),
  }
}

export async function resolve(msgs: Tool.Context["messages"]) {
  const ref = pick(msgs)
  const model = await Provider.getModel(ref.providerID, ref.modelID)
  if (!model.capabilities.input.image) {
    throw new Error(`Selected UI Agent does not support image input: ${model.providerID}/${model.id}`)
  }
  return {
    model,
    prov: await Provider.getProvider(model.providerID),
  } satisfies UIModel
}

export async function call(input: {
  ui: UIModel
  shot: string
  system: string
  prompt: string
  abort?: AbortSignal
  format?: "json"
}) {
  const res = await fetch(`${root(String(input.ui.prov.options.baseURL ?? input.ui.model.api.url))}/api/chat`, {
    method: "POST",
    signal: input.abort,
    headers: {
      "Content-Type": "application/json",
      ...(input.ui.prov.key ? { Authorization: `Bearer ${input.ui.prov.key}` } : {}),
      ...(input.ui.prov.options.headers ?? {}),
      ...input.ui.model.headers,
    },
    body: JSON.stringify({
      model: input.ui.model.api.id,
      stream: false,
      ...(input.format ? { format: input.format } : {}),
      messages: [
        {
          role: "system",
          content: input.system,
        },
        {
          role: "user",
          content: input.prompt,
          images: [base64(input.shot)],
        },
      ],
    }),
  })
  if (!res.ok) {
    throw new Error((await res.text()).trim() || `UI tool failed with status ${res.status}`)
  }
  const body = reply.parse(await res.json())
  const text = body.message?.content?.trim()
  if (!text) throw new Error("UI tool returned an empty response.")
  return text
}
