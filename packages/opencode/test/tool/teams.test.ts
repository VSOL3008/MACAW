import { describe, expect, test } from "bun:test"
import { buildUrl, htmlToText, parameters, TeamsTool } from "../../src/tool/teams"
import { scopesFor, consentHint, DEFAULT_CLIENT_ID } from "../../src/auth/graph"

describe("teams.parameters", () => {
  test("accepts list_chats with no extras", () => {
    const p = parameters.parse({ action: "list_chats" })
    expect(p.action).toBe("list_chats")
  })

  test("rejects unknown actions", () => {
    expect(() => parameters.parse({ action: "send_message" })).toThrow()
  })

  test("caps count at 50", () => {
    expect(() => parameters.parse({ action: "list_messages", chat_id: "x", count: 200 })).toThrow()
  })
})

describe("teams.buildUrl", () => {
  test("list_chats uses top + expand", () => {
    const url = buildUrl({ action: "list_chats", count: 5 })
    expect(url).toContain("/me/chats?")
    expect(url).toContain("$top=5")
    expect(url).toContain("$expand=members")
  })

  test("list_messages encodes chat_id and requires it", () => {
    const url = buildUrl({ action: "list_messages", chat_id: "19:abc@thread.v2" })
    expect(url).toContain("/me/chats/19%3Aabc%40thread.v2/messages")
    expect(() => buildUrl({ action: "list_messages" })).toThrow("chat_id")
  })

  test("list_channels requires team_id", () => {
    expect(() => buildUrl({ action: "list_channels" })).toThrow("team_id")
    const url = buildUrl({ action: "list_channels", team_id: "t1" })
    expect(url).toContain("/teams/t1/channels")
  })

  test("list_channel_messages needs both ids", () => {
    expect(() => buildUrl({ action: "list_channel_messages", team_id: "t1" })).toThrow("channel_id")
    const url = buildUrl({ action: "list_channel_messages", team_id: "t1", channel_id: "c1", count: 3 })
    expect(url).toContain("/teams/t1/channels/c1/messages")
    expect(url).toContain("$top=3")
  })

  test("list_meetings filters online", () => {
    const url = buildUrl({ action: "list_meetings" })
    expect(url).toContain("isOnlineMeeting eq true")
  })

  test("presence hits /me/presence", () => {
    expect(buildUrl({ action: "presence" })).toBe("https://graph.microsoft.com/v1.0/me/presence")
  })
})

describe("teams.htmlToText", () => {
  test("strips tags and preserves text", () => {
    const out = htmlToText("<div>Hello <b>world</b></div>")
    expect(out).toBe("Hello world")
  })

  test("converts br and p to newlines", () => {
    const out = htmlToText("<p>Line 1</p><p>Line 2</p>")
    expect(out.split("\n").length).toBe(2)
  })

  test("decodes common entities", () => {
    const out = htmlToText("A &amp; B &lt;c&gt; &quot;d&quot;")
    expect(out).toBe('A & B <c> "d"')
  })

  test("collapses excessive blank lines", () => {
    const out = htmlToText("<p>A</p><br/><br/><br/><br/><p>B</p>")
    expect(out).not.toContain("\n\n\n")
  })
})

describe("graph.scopesFor", () => {
  test("chat actions use Chat.Read", () => {
    expect(scopesFor("list_chats")).toContain("Chat.Read")
    expect(scopesFor("list_messages")).toContain("Chat.Read")
  })

  test("team actions map correctly", () => {
    expect(scopesFor("list_teams")).toContain("Team.ReadBasic.All")
    expect(scopesFor("list_channels")).toContain("Channel.ReadBasic.All")
    expect(scopesFor("list_channel_messages")).toContain("ChannelMessage.Read.All")
  })

  test("presence maps to Presence.Read", () => {
    expect(scopesFor("presence")).toEqual(["Presence.Read"])
  })
})

describe("graph.consentHint", () => {
  test("includes client id and scopes", () => {
    const hint = consentHint(["Chat.Read", "Presence.Read"])
    expect(hint).toContain(DEFAULT_CLIENT_ID)
    expect(hint).toContain("Chat.Read")
    expect(hint).toContain("Presence.Read")
    expect(hint).toContain("az login")
  })
})

describe("TeamsTool", () => {
  test("registers as teams", () => {
    expect(TeamsTool.id).toBe("teams")
  })
})
