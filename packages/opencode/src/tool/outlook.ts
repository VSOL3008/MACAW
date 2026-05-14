import z from "zod"
import { Tool } from "./tool"
import { ps, run } from "./win"

export const parameters = z.object({
  action: z.enum(["last_email", "list_emails", "search", "folders"]),
  folder: z.string().optional(),
  count: z.number().int().positive().max(50).optional(),
  query: z.string().optional(),
  include_body: z.boolean().optional(),
  body_limit: z.number().int().positive().max(10_000).optional(),
})

export type OutlookInput = z.infer<typeof parameters>

const FOLDER: Record<string, number> = {
  inbox: 6,
  sent: 5,
  "sent items": 5,
  drafts: 16,
  deleted: 3,
  "deleted items": 3,
  trash: 3,
  outbox: 4,
  junk: 23,
  "junk email": 23,
  spam: 23,
}

function folderPrelude(folder?: string) {
  if (!folder) return `$root = $ns.GetDefaultFolder(6)`
  const constant = FOLDER[folder.toLowerCase().trim()]
  if (constant !== undefined) return `$root = $ns.GetDefaultFolder(${constant})`
  return `
$root = $null
$acc = $ns.Folders
for ($i = 1; $i -le $acc.Count; $i++) {
  $top = $acc.Item($i)
  foreach ($sub in $top.Folders) {
    if ($sub.Name -ieq '${ps(folder)}') { $root = $sub; break }
  }
  if ($root) { break }
}
if (-not $root) {
  try { $root = $ns.GetDefaultFolder(6).Folders.Item('${ps(folder)}') } catch {}
}
if (-not $root) { throw 'Folder not found: ${ps(folder)}' }
`.trim()
}

const HEAD = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName Microsoft.Office.Interop.Outlook | Out-Null
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace('MAPI')
`.trim()

function emitOne(includeBody: boolean, limit: number) {
  const bodyLine = includeBody
    ? `$b = [string]$msg.Body
    if ($b.Length -gt ${limit}) { $b = $b.Substring(0, ${limit}) + '...' }`
    : `$b = $null`
  return `
    $b = $null
    ${bodyLine}
    [pscustomobject]@{
      sender = [string]$msg.SenderName
      sender_email = [string]$msg.SenderEmailAddress
      subject = [string]$msg.Subject
      received = if ($msg.ReceivedTime) { $msg.ReceivedTime.ToString('o') } else { $null }
      unread = [bool]$msg.UnRead
      has_attachments = ($msg.Attachments.Count -gt 0)
      attachments = ($msg.Attachments | ForEach-Object { $_.FileName })
      body = $b
      entry_id = [string]$msg.EntryID
    }
  `.trim()
}

function scriptLastEmail(input: OutlookInput) {
  const include = input.include_body !== false
  const limit = input.body_limit ?? 2000
  return `
${HEAD}
${folderPrelude(input.folder)}
$items = $root.Items
$items.Sort('[ReceivedTime]', $true)
$msg = $items.GetFirst()
if (-not $msg) { '{}' ; exit 0 }
${emitOne(include, limit)} | ConvertTo-Json -Compress -Depth 4
`
}

function scriptListEmails(input: OutlookInput) {
  const count = input.count ?? 10
  const include = input.include_body === true
  const limit = input.body_limit ?? 500
  return `
${HEAD}
${folderPrelude(input.folder)}
$items = $root.Items
$items.Sort('[ReceivedTime]', $true)
$out = New-Object System.Collections.Generic.List[object]
$msg = $items.GetFirst()
$i = 0
while ($msg -and $i -lt ${count}) {
  $entry = ${emitOne(include, limit)}
  [void]$out.Add($entry)
  $msg = $items.GetNext()
  $i++
}
$arr = $out.ToArray()
if ($arr.Length -eq 0) { '[]' } else { ConvertTo-Json -InputObject ([object[]]$arr) -Depth 4 -Compress }
`
}

function scriptSearch(input: OutlookInput) {
  if (!input.query) throw new Error("outlook search requires a query.")
  const count = input.count ?? 10
  const include = input.include_body !== false
  const limit = input.body_limit ?? 2000
  const q = ps(input.query)
  return `
${HEAD}
${folderPrelude(input.folder)}
$items = $root.Items
$items.Sort('[ReceivedTime]', $true)
$needle = '${q}'.ToLower()
$out = New-Object System.Collections.Generic.List[object]
$msg = $items.GetFirst()
$i = 0
while ($msg -and $out.Count -lt ${count} -and $i -lt 500) {
  $i++
  $hay = ('{0} {1} {2}' -f $msg.Subject, $msg.SenderName, $msg.SenderEmailAddress).ToLower()
  if ($hay.Contains($needle)) {
    $entry = ${emitOne(include, limit)}
    [void]$out.Add($entry)
  }
  $msg = $items.GetNext()
}
$arr = $out.ToArray()
if ($arr.Length -eq 0) { '[]' } else { ConvertTo-Json -InputObject ([object[]]$arr) -Depth 4 -Compress }
`
}

function scriptFolders() {
  return `
${HEAD}
$out = New-Object System.Collections.Generic.List[string]
foreach ($acc in $ns.Folders) {
  foreach ($sub in $acc.Folders) {
    [void]$out.Add($sub.Name)
  }
}
$arr = $out.ToArray()
if ($arr.Length -eq 0) { '[]' } else { ConvertTo-Json -InputObject ([object[]]$arr) -Compress }
`
}

export function build(input: OutlookInput) {
  if (input.action === "last_email") return scriptLastEmail(input)
  if (input.action === "list_emails") return scriptListEmails(input)
  if (input.action === "search") return scriptSearch(input)
  return scriptFolders()
}

export const OutlookTool = Tool.define("outlook", {
  description:
    "Read Microsoft Outlook mail via COM Interop. Actions: `last_email` (latest message), `list_emails` (top N headers), `search` (query subject/sender), `folders` (list known folders). Headless - does not require the Outlook window to be open or focused. Returns JSON.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "outlook",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        action: input.action,
        folder: input.folder ?? "Inbox",
        count: input.count,
        query: input.query,
      },
    })
    const out = await run(build(input), ctx.abort)
    const body = out.trim() || (input.action === "last_email" ? "{}" : "[]")
    return {
      title: `Outlook: ${input.action}`,
      output: body,
      metadata: {
        action: input.action,
        folder: input.folder ?? "Inbox",
        chars: body.length,
      },
    }
  },
})
