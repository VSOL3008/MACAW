import { Tool } from "./tool"
import DESCRIPTION from "./deepsearch.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { Effect } from "effect"

const id = "deepsearch"
const AGENT_NAME = "researcher"

const parameters = z.object({
  query: z.string().describe("The research question / topic to investigate"),
  depth: z.number().int().min(1).max(3).optional().describe("Iteration rounds (1-3, default 2)"),
  breadth: z.number().int().min(1).max(8).optional().describe("Sources to inspect per round (1-8, default 5)"),
  focus: z
    .enum(["general", "technical", "news", "academic"])
    .optional()
    .describe("Search bias: general (default), technical, news, academic"),
  include_domains: z.array(z.string()).optional().describe("Restrict searches to these domains"),
  exclude_domains: z.array(z.string()).optional().describe("Exclude these domains from searches"),
  cite: z.boolean().optional().describe("Require inline citations + Sources section (default true)"),
  task_id: z
    .string()
    .optional()
    .describe("Pass a prior task_id to resume the same research session instead of starting fresh"),
})

export const DeepSearchTool = Tool.defineEffect(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service

    const run = Effect.fn("DeepSearchTool.execute")(function* (
      params: z.infer<typeof parameters>,
      ctx: Tool.Context,
    ) {
      const opts = {
        query: params.query,
        depth: params.depth ?? 2,
        breadth: params.breadth ?? 5,
        focus: params.focus ?? ("general" as const),
        include_domains: params.include_domains,
        exclude_domains: params.exclude_domains,
        cite: params.cite ?? true,
      }

      yield* Effect.promise(() =>
        ctx.ask({
          permission: id,
          patterns: [opts.query],
          always: ["*"],
          metadata: {
            query: opts.query,
            depth: opts.depth,
            breadth: opts.breadth,
            focus: opts.focus,
          },
        }),
      )

      const next = yield* agent.get(AGENT_NAME)
      if (!next) {
        return yield* Effect.fail(
          new Error(`researcher agent not available - deepsearch requires the built-in researcher subagent`),
        )
      }

      const taskID = params.task_id
      const session = taskID
        ? yield* Effect.promise(() => {
            const sid = SessionID.make(taskID)
            return Session.get(sid).catch(() => undefined)
          })
        : undefined

      const nextSession =
        session ??
        (yield* Effect.promise(() =>
          Session.create({
            parentID: ctx.sessionID,
            title: `Deep research: ${params.query.slice(0, 80)}`,
          }),
        ))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID }

      ctx.metadata({
        title: `Deep research: ${opts.query}`,
        metadata: { sessionId: nextSession.id, model, agent: AGENT_NAME },
      })

      const messageID = MessageID.ascending()

      function cancel() {
        SessionPrompt.cancel(nextSession.id)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            const userPrompt = buildPrompt(opts)
            const parts = yield* Effect.promise(() => SessionPrompt.resolvePromptParts(userPrompt))
            const result = yield* Effect.promise(() =>
              SessionPrompt.prompt({
                messageID,
                sessionID: nextSession.id,
                model,
                agent: AGENT_NAME,
                tools: {
                  task: false,
                  bash: false,
                  read: false,
                  list: false,
                  glob: false,
                  grep: false,
                  edit: false,
                  write: false,
                  multiedit: false,
                  apply_patch: false,
                  codesearch: false,
                  lsp: false,
                  skill: false,
                  skill_create: false,
                },
                parts,
              }),
            )

            const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
            return {
              title: `Deep research: ${opts.query}`,
              metadata: {
                sessionId: nextSession.id,
                model,
                agent: AGENT_NAME,
                depth: opts.depth,
                breadth: opts.breadth,
              },
              output: [
                `task_id: ${nextSession.id} (pass as task_id to continue this research)`,
                "",
                "<deep_research_report>",
                text,
                "</deep_research_report>",
              ].join("\n"),
            }
          }),
        () =>
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters,
      async execute(params: z.infer<typeof parameters>, ctx) {
        return Effect.runPromise(run(params, ctx))
      },
    }
  }),
)

function buildPrompt(p: {
  query: string
  depth: number
  breadth: number
  focus: "general" | "technical" | "news" | "academic"
  include_domains?: string[]
  exclude_domains?: string[]
  cite: boolean
}): string {
  const focusHint = {
    general: "Prioritize authoritative primary sources and reputable news/docs.",
    technical: "Prioritize official docs, specs, RFCs, vendor blogs, and source code.",
    news: "Prioritize recent news coverage from reputable outlets; include publication dates.",
    academic: "Prioritize peer-reviewed papers, preprints, and academic institutions.",
  }[p.focus]

  const domainRules = [
    p.include_domains?.length
      ? `Only use sources from these domains when possible: ${p.include_domains.join(", ")}`
      : "",
    p.exclude_domains?.length ? `Never cite sources from these domains: ${p.exclude_domains.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  return [
    `# Research request`,
    "",
    `**Question**: ${p.query}`,
    "",
    `**Depth**: up to ${p.depth} research round${p.depth === 1 ? "" : "s"}`,
    `**Breadth**: up to ${p.breadth} sources per sub-question`,
    `**Focus**: ${p.focus} — ${focusHint}`,
    domainRules ? `\n${domainRules}` : "",
    p.cite
      ? "\nCitations are REQUIRED: every factual claim must carry an inline [n] that resolves to a URL in the final Sources section."
      : "",
    "",
    "Follow the research protocol in your system prompt. Return only the final markdown report as your last message.",
  ]
    .filter((l) => l !== null && l !== undefined)
    .join("\n")
}
