import { describe, expect, test } from "bun:test"
import { build, OutlookTool, parameters } from "../../src/tool/outlook"

describe("outlook.parameters", () => {
  test("accepts last_email with no extras", () => {
    expect(parameters.parse({ action: "last_email" }).action).toBe("last_email")
  })

  test("caps count at 50", () => {
    expect(() => parameters.parse({ action: "list_emails", count: 100 })).toThrow()
  })

  test("rejects unknown actions", () => {
    expect(() => parameters.parse({ action: "delete_email" })).toThrow()
  })
})

describe("outlook.build", () => {
  test("last_email uses olFolderInbox by default", () => {
    const s = build({ action: "last_email" })
    expect(s).toContain("$root = $ns.GetDefaultFolder(6)")
    expect(s).toContain("$items.Sort('[ReceivedTime]', $true)")
    expect(s).toContain("$msg = $items.GetFirst()")
  })

  test("maps folder name to constant", () => {
    const s = build({ action: "last_email", folder: "Sent" })
    expect(s).toContain("$root = $ns.GetDefaultFolder(5)")
  })

  test("falls back to folder walk for unknown names", () => {
    const s = build({ action: "last_email", folder: "Archive" })
    expect(s).toContain("foreach ($sub in $top.Folders)")
    expect(s).toContain("$sub.Name -ieq 'Archive'")
  })

  test("search requires a query", () => {
    expect(() => build({ action: "search" })).toThrow("query")
  })

  test("search includes needle", () => {
    const s = build({ action: "search", query: "invoice" })
    expect(s).toContain("$needle = 'invoice'.ToLower()")
  })

  test("list_emails respects count", () => {
    const s = build({ action: "list_emails", count: 5 })
    expect(s).toContain("$i -lt 5")
  })

  test("folders lists subfolders", () => {
    const s = build({ action: "folders" })
    expect(s).toContain("foreach ($acc in $ns.Folders)")
    expect(s).toContain("foreach ($sub in $acc.Folders)")
  })
})

describe("OutlookTool", () => {
  test("registers as outlook", () => {
    expect(OutlookTool.id).toBe("outlook")
  })
})
