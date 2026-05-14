import z from "zod"
import { acquireToken, clearCache, scopesFor } from "../auth/graph"
import { Tool } from "./tool"

const ACTIONS = [
  "list_chats",
  "list_messages",
  "search_chats",
  "list_teams",
  "list_channels",
  "list_channel_messages",
  "list_meetings",
  "presence",
] as const

export const parameters = z.object({
  action: z.enum(ACTIONS),
  chat_id: z.string().optional(),
  team_id: z.string().optional(),
  channel_id: z.string().optional(),
  count: z.number().int().positive().max(50).optional(),
  query: z.string().optional(),
  include_body: z.boolean().optional(),
})

export type TeamsInput = z.infer<typeof parameters>

const GRAPH = "https://graph.microsoft.com/v1.0"

export function htmlToText(html: string | null | undefined) {
  if (!html) return ""
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function buildUrl(input: TeamsInput) {
  const count = input.count ?? 20
  switch (input.action) {
    case "list_chats":
      return `${GRAPH}/me/chats?$top=${count}&$expand=members&$orderby=lastMessagePreview/createdDateTime desc`
    case "list_messages":
      if (!input.chat_id) throw new Error("teams list_messages requires chat_id")
      return `${GRAPH}/me/chats/${encodeURIComponent(input.chat_id)}/messages?$top=${count}`
    case "search_chats":
      return `${GRAPH}/me/chats?$top=50&$expand=members&$orderby=lastMessagePreview/createdDateTime desc`
    case "list_teams":
      return `${GRAPH}/me/joinedTeams`
    case "list_channels":
      if (!input.team_id) throw new Error("teams list_channels requires team_id")
      return `${GRAPH}/teams/${encodeURIComponent(input.team_id)}/channels`
    case "list_channel_messages":
      if (!input.team_id || !input.channel_id)
        throw new Error("teams list_channel_messages requires team_id and channel_id")
      return `${GRAPH}/teams/${encodeURIComponent(input.team_id)}/channels/${encodeURIComponent(input.channel_id)}/messages?$top=${count}`
    case "list_meetings":
      return `${GRAPH}/me/calendar/events?$top=${count}&$orderby=start/dateTime desc&$filter=isOnlineMeeting eq true`
    case "presence":
      return `${GRAPH}/me/presence`
  }
}

type Chat = {
  id: string
  topic?: string | null
  chatType?: string
  lastUpdatedDateTime?: string
  members?: { displayName?: string; email?: string }[]
}

type Message = {
  id: string
  createdDateTime?: string
  from?: { user?: { displayName?: string } } | null
  body?: { contentType?: string; content?: string }
  subject?: string | null
  importance?: string
}

function summarizeChat(c: Chat) {
  const names = (c.members ?? []).map((m) => m.displayName).filter(Boolean).join(", ")
  return {
    id: c.id,
    topic: c.topic ?? null,
    type: c.chatType ?? null,
    updated: c.lastUpdatedDateTime ?? null,
    members: names,
  }
}

function summarizeMessage(m: Message, include: boolean) {
  const body = include ? htmlToText(m.body?.content) : htmlToText(m.body?.content).slice(0, 200)
  return {
    id: m.id,
    from: m.from?.user?.displayName ?? null,
    created: m.createdDateTime ?? null,
    subject: m.subject ?? null,
    importance: m.importance ?? null,
    body,
  }
}

async function graph(url: string, token: string, signal?: AbortSignal) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal,
  })
  return res
}

async function callGraph(url: string, scopes: string[], signal?: AbortSignal) {
  let token = await acquireToken(scopes)
  let res = await graph(url, token, signal)
  if (res.status === 401) {
    await clearCache()
    token = await acquireToken(scopes)
    res = await graph(url, token, signal)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Graph ${res.status}: ${body.slice(0, 500)}`)
  }
  return res.json() as Promise<Record<string, unknown>>
}

export const TeamsTool = Tool.define("teams", {
  description:
    "Read Microsoft Teams via Microsoft Graph (chats, messages, teams, channels, online meetings, presence). Headless, uses your Windows enterprise SSO. Actions: list_chats, list_messages (needs chat_id), search_chats (needs query), list_teams, list_channels (needs team_id), list_channel_messages (needs team_id + channel_id), list_meetings, presence.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "teams",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        action: input.action,
        chat_id: input.chat_id,
        team_id: input.team_id,
        channel_id: input.channel_id,
      },
    })

    const scopes = scopesFor(input.action)
    const url = buildUrl(input)
    const data = (await callGraph(url, scopes, ctx.abort)) as { value?: unknown; [k: string]: unknown }
    const include = input.include_body !== false

    let body: unknown = data
    if (input.action === "list_chats") {
      body = ((data.value as Chat[] | undefined) ?? []).map(summarizeChat)
    } else if (input.action === "list_messages" || input.action === "list_channel_messages") {
      body = ((data.value as Message[] | undefined) ?? []).map((m) => summarizeMessage(m, include))
    } else if (input.action === "search_chats") {
      const q = (input.query ?? "").toLowerCase().trim()
      if (!q) throw new Error("teams search_chats requires query")
      const items = ((data.value as Chat[] | undefined) ?? []).map(summarizeChat)
      body = items.filter((c) => {
        return (
          (c.topic && c.topic.toLowerCase().includes(q)) ||
          (c.members && c.members.toLowerCase().includes(q))
        )
      })
    } else if (input.action === "list_teams") {
      body = ((data.value as { id: string; displayName?: string; description?: string }[] | undefined) ?? []).map((t) => ({
        id: t.id,
        name: t.displayName ?? null,
        description: t.description ?? null,
      }))
    } else if (input.action === "list_channels") {
      body = ((data.value as { id: string; displayName?: string; membershipType?: string }[] | undefined) ?? []).map(
        (c) => ({ id: c.id, name: c.displayName ?? null, membership: c.membershipType ?? null }),
      )
    } else if (input.action === "list_meetings") {
      body = (
        (data.value as {
          id: string
          subject?: string
          organizer?: { emailAddress?: { name?: string } }
          start?: { dateTime?: string }
          end?: { dateTime?: string }
          onlineMeeting?: { joinUrl?: string }
        }[] | undefined) ?? []
      ).map((e) => ({
        id: e.id,
        subject: e.subject ?? null,
        organizer: e.organizer?.emailAddress?.name ?? null,
        start: e.start?.dateTime ?? null,
        end: e.end?.dateTime ?? null,
        join_url: e.onlineMeeting?.joinUrl ?? null,
      }))
    }

    const text = JSON.stringify(body)
    return {
      title: `Teams: ${input.action}`,
      output: text,
      metadata: {
        action: input.action,
        chars: text.length,
      },
    }
  },
})
