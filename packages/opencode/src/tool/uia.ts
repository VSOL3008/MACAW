import { createHash } from "crypto"
import z from "zod"
import { prelude, ps, run } from "./win"

const ctrl = z.object({
  runtimeId: z.string(),
  automationId: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  className: z.string().nullable().optional(),
  controlType: z.string().nullable().optional(),
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  enabled: z.boolean(),
  offscreen: z.boolean(),
  patterns: z.array(z.string()),
})

export type Ctrl = z.infer<typeof ctrl>

const node = z.object({
  depth: z.number().int().nonnegative(),
  ctrl: ctrl,
})

export type Node = z.infer<typeof node>

const state = z.object({
  runtimeId: z.string(),
  enabled: z.boolean(),
  offscreen: z.boolean(),
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  toggle: z.string().nullable().optional(),
  value: z.string().nullable().optional(),
  selected: z.boolean().nullable().optional(),
})

export type State = z.infer<typeof state>

export function sid(c: {
  rect: readonly number[]
  className?: string | null
  name?: string | null
  automationId?: string | null
  controlType?: string | null
}) {
  const parts = [
    c.controlType ?? "",
    c.className ?? "",
    c.automationId ?? "",
    (c.name ?? "").trim().toLowerCase().replace(/\s+/g, " "),
    c.rect.slice(0, 4).join(","),
  ]
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12)
}

export function parseCtrls(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return [] as Ctrl[]
  const raw = JSON.parse(trimmed)
  if (!raw) return [] as Ctrl[]
  const list = Array.isArray(raw) ? raw : [raw]
  return list.flatMap((item) => {
    const parsed = ctrl.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

export function parseNodes(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return [] as Node[]
  const raw = JSON.parse(trimmed)
  if (!raw) return [] as Node[]
  const list = Array.isArray(raw) ? raw : [raw]
  return list.flatMap((item) => {
    const parsed = node.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

export function parseState(text: string) {
  const trimmed = text.trim()
  if (!trimmed) throw new Error("Empty UIA state response.")
  return state.parse(JSON.parse(trimmed))
}

const ASSEMBLIES = `Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes`

function rootBlock(title?: string) {
  if (!title) return `$root = [System.Windows.Automation.AutomationElement]::RootElement`
  return `
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${ps(title)}*' } | Select-Object -First 1
if (-not $proc) { throw 'Window not found' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $root) { throw 'Window not reachable by UIA' }
`.trim()
}

function findBlock() {
  return `
$target = $args[0]
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
$hit = $null
foreach ($e in $all) {
  try { if ((($e.GetRuntimeId()) -join ',') -eq $target) { $hit = $e; break } } catch {}
}
if (-not $hit) { throw 'UIA element not found' }
`.trim()
}

export function enumerateScript(title?: string, limit = 400) {
  return prelude(`
${ASSEMBLIES}
${rootBlock(title)}
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
$out = New-Object System.Collections.Generic.List[object]
foreach ($e in $all) {
  if ($out.Count -ge ${limit}) { break }
  if (-not $e) { continue }
  try {
    $r = $e.Current.BoundingRectangle
    if ([double]::IsInfinity($r.Left) -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    $pats = New-Object System.Collections.Generic.List[string]
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { [void]$pats.Add('Invoke') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { [void]$pats.Add('Toggle') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { [void]$pats.Add('Value') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { [void]$pats.Add('ExpandCollapse') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { [void]$pats.Add('SelectionItem') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$p)) { [void]$pats.Add('ScrollItem') }
    $obj = [ordered]@{
      runtimeId = (($e.GetRuntimeId()) -join ',')
      automationId = $e.Current.AutomationId
      name = $e.Current.Name
      className = $e.Current.ClassName
      controlType = $e.Current.ControlType.LocalizedControlType
      rect = @([int]$r.Left, [int]$r.Top, [int]$r.Right, [int]$r.Bottom)
      enabled = [bool]$e.Current.IsEnabled
      offscreen = [bool]$e.Current.IsOffscreen
      patterns = $pats.ToArray()
    }
    [void]$out.Add([pscustomobject]$obj)
  } catch {}
}
$arr = $out.ToArray()
if ($arr.Length -eq 0) { Write-Output '[]' } else { ConvertTo-Json -InputObject ([object[]]$arr) -Depth 4 -Compress }
`)
}

export function invokeScript(rid: string, title?: string) {
  return prelude(`
${ASSEMBLIES}
${rootBlock(title)}
${findBlock().replace("$target = $args[0]", `$target = '${ps(rid)}'`)}
$p = $null
if ($hit.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle() }
elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select() }
elseif ($hit.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
  if ($p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $p.Expand() } else { $p.Collapse() }
}
else { throw 'No invokable pattern on element' }
`)
}

export function setValueScript(rid: string, value: string, title?: string) {
  return prelude(`
${ASSEMBLIES}
${rootBlock(title)}
${findBlock().replace("$target = $args[0]", `$target = '${ps(rid)}'`)}
$p = $null
if (-not $hit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { throw 'No value pattern on element' }
try { $hit.SetFocus() } catch {}
$p.SetValue('${ps(value)}')
`)
}

export function toggleScript(rid: string, title?: string) {
  return prelude(`
${ASSEMBLIES}
${rootBlock(title)}
${findBlock().replace("$target = $args[0]", `$target = '${ps(rid)}'`)}
$p = $null
if (-not $hit.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { throw 'No toggle pattern on element' }
$p.Toggle()
`)
}

export function treeScript(input: { title?: string; limit?: number; includeOffscreen?: boolean }) {
  const limit = input.limit ?? 400
  const off = input.includeOffscreen ? "$true" : "$false"
  return prelude(`
${ASSEMBLIES}
${rootBlock(input.title)}
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$out = New-Object System.Collections.Generic.List[object]
function Emit-Node($e, $depth) {
  if ($out.Count -ge ${limit}) { return }
  try {
    $r = $e.Current.BoundingRectangle
    if ([double]::IsInfinity($r.Left) -or $r.Width -le 0 -or $r.Height -le 0) { return }
    $isOff = [bool]$e.Current.IsOffscreen
    if ($isOff -and -not ${off}) { return }
    $pats = New-Object System.Collections.Generic.List[string]
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { [void]$pats.Add('Invoke') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { [void]$pats.Add('Toggle') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { [void]$pats.Add('Value') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { [void]$pats.Add('ExpandCollapse') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { [void]$pats.Add('SelectionItem') }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$p)) { [void]$pats.Add('ScrollItem') }
    $ctrlObj = [ordered]@{
      runtimeId = (($e.GetRuntimeId()) -join ',')
      automationId = $e.Current.AutomationId
      name = $e.Current.Name
      className = $e.Current.ClassName
      controlType = $e.Current.ControlType.LocalizedControlType
      rect = @([int]$r.Left, [int]$r.Top, [int]$r.Right, [int]$r.Bottom)
      enabled = [bool]$e.Current.IsEnabled
      offscreen = $isOff
      patterns = $pats.ToArray()
    }
    $obj = [ordered]@{ depth = [int]$depth; ctrl = [pscustomobject]$ctrlObj }
    [void]$out.Add([pscustomobject]$obj)
  } catch { return }
  $child = $walker.GetFirstChild($e)
  while ($child -and $out.Count -lt ${limit}) {
    Emit-Node $child ($depth + 1)
    try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
  }
}
Emit-Node $root 0
$arr = $out.ToArray()
if ($arr.Length -eq 0) { Write-Output '[]' } else { ConvertTo-Json -InputObject ([object[]]$arr) -Depth 6 -Compress }
`)
}

export function selectScript(rid: string, title?: string) {
  return prelude(`
${ASSEMBLIES}
${rootBlock(title)}
${findBlock().replace("$target = $args[0]", `$target = '${ps(rid)}'`)}
$p = $null
if (-not $hit.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { throw 'No selection pattern on element' }
$p.Select()
`)
}

export function expandScript(rid: string, title?: string, collapse = false) {
  return prelude(`
${ASSEMBLIES}
${rootBlock(title)}
${findBlock().replace("$target = $args[0]", `$target = '${ps(rid)}'`)}
$p = $null
if (-not $hit.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { throw 'No expand/collapse pattern on element' }
${collapse ? "$p.Collapse()" : "$p.Expand()"}
`)
}

export function focusScript(rid: string, title?: string) {
  return prelude(`
${ASSEMBLIES}
${rootBlock(title)}
${findBlock().replace("$target = $args[0]", `$target = '${ps(rid)}'`)}
$hit.SetFocus()
`)
}

export function queryScript(rid: string, title?: string) {
  return prelude(`
${ASSEMBLIES}
${rootBlock(title)}
${findBlock().replace("$target = $args[0]", `$target = '${ps(rid)}'`)}
$r = $hit.Current.BoundingRectangle
$state = [ordered]@{
  runtimeId = $target
  enabled = [bool]$hit.Current.IsEnabled
  offscreen = [bool]$hit.Current.IsOffscreen
  rect = @([int]$r.Left, [int]$r.Top, [int]$r.Right, [int]$r.Bottom)
  toggle = $null
  value = $null
  selected = $null
}
$p = $null
if ($hit.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $state.toggle = $p.Current.ToggleState.ToString() }
if ($hit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $state.value = [string]$p.Current.Value }
if ($hit.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $state.selected = [bool]$p.Current.IsSelected }
ConvertTo-Json -InputObject ([pscustomobject]$state) -Depth 4 -Compress
`)
}

export async function enumerate(input: { title?: string; limit?: number } = {}, signal?: AbortSignal) {
  const text = await run(enumerateScript(input.title, input.limit ?? 400), signal)
  return parseCtrls(text)
}

export async function invoke(input: { runtimeId: string; title?: string }, signal?: AbortSignal) {
  await run(invokeScript(input.runtimeId, input.title), signal)
}

export async function setValue(input: { runtimeId: string; value: string; title?: string }, signal?: AbortSignal) {
  await run(setValueScript(input.runtimeId, input.value, input.title), signal)
}

export async function toggle(input: { runtimeId: string; title?: string }, signal?: AbortSignal) {
  await run(toggleScript(input.runtimeId, input.title), signal)
}

export async function query(input: { runtimeId: string; title?: string }, signal?: AbortSignal) {
  const text = await run(queryScript(input.runtimeId, input.title), signal)
  return parseState(text)
}

export async function tree(
  input: { title?: string; limit?: number; includeOffscreen?: boolean } = {},
  signal?: AbortSignal,
) {
  const text = await run(treeScript(input), signal)
  return parseNodes(text)
}

export async function select(input: { runtimeId: string; title?: string }, signal?: AbortSignal) {
  await run(selectScript(input.runtimeId, input.title), signal)
}

export async function expand(
  input: { runtimeId: string; title?: string; collapse?: boolean },
  signal?: AbortSignal,
) {
  await run(expandScript(input.runtimeId, input.title, input.collapse === true), signal)
}

export async function focus(input: { runtimeId: string; title?: string }, signal?: AbortSignal) {
  await run(focusScript(input.runtimeId, input.title), signal)
}
