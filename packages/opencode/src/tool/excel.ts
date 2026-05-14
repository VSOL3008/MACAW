import z from "zod"
import { Tool } from "./tool"
import { ps, run } from "./win"

const ACTIONS = [
  "list_workbooks",
  "open",
  "new_workbook",
  "save",
  "save_as",
  "close",
  "list_sheets",
  "add_sheet",
  "rename_sheet",
  "delete_sheet",
  "get_range",
  "get_used_range",
  "get_cell",
  "find",
  "set_cell",
  "set_range",
  "append_row",
  "clear_range",
  "evaluate",
  "run_macro",
  "list_tables",
  "get_table",
  "format",
  "autofit",
  "sort",
  "filter",
  "chart",
] as const

export const parameters = z.object({
  action: z.enum(ACTIONS),
  workbook: z.string().optional(),
  sheet: z.string().optional(),
  range: z.string().optional(),
  address: z.string().optional(),
  file_path: z.string().optional(),
  save: z.boolean().optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  formula: z.string().optional(),
  values: z.array(z.array(z.unknown())).optional(),
  formulas: z.array(z.array(z.string())).optional(),
  macro: z.string().optional(),
  args: z.array(z.unknown()).optional(),
  expression: z.string().optional(),
  query: z.string().optional(),
  match_case: z.boolean().optional(),
  whole_cell: z.boolean().optional(),
  columns: z
    .array(
      z.object({
        column: z.number().int().positive(),
        ascending: z.boolean().optional(),
      }),
    )
    .optional(),
  has_header: z.boolean().optional(),
  criteria: z.string().optional(),
  column: z.number().int().positive().optional(),
  clear: z.boolean().optional(),
  what: z.enum(["contents", "formats", "all", "columns", "rows"]).optional(),
  chart_type: z.enum(["column", "bar", "line", "pie", "scatter", "area"]).optional(),
  destination: z.string().optional(),
  title: z.string().optional(),
  new_name: z.string().optional(),
  after: z.string().optional(),
  table: z.string().optional(),
  number_format: z.string().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  font_color: z.string().optional(),
  fill_color: z.string().optional(),
  horizontal_align: z.enum(["left", "center", "right"]).optional(),
  wrap_text: z.boolean().optional(),
  limit: z.number().int().positive().max(5000).optional(),
})

export type ExcelInput = z.infer<typeof parameters>

function b64(obj: unknown) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64")
}

function decodeBlock(name: string, payload: unknown) {
  return `$${name} = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(payload)}')) | ConvertFrom-Json`
}

const HEADER = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
Add-Type -AssemblyName Microsoft.Office.Interop.Excel | Out-Null
try {
  $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
  $owned = $false
} catch {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false
  $owned = $true
}
function Resolve-Workbook([string]$id) {
  if ([string]::IsNullOrWhiteSpace($id)) {
    if (-not $app.ActiveWorkbook) { throw 'No active workbook. Provide workbook arg.' }
    return $app.ActiveWorkbook
  }
  foreach ($wb in $app.Workbooks) {
    if ($wb.FullName -ieq $id -or $wb.Name -ieq $id) { return $wb }
  }
  if (Test-Path -LiteralPath $id) {
    $full = (Resolve-Path -LiteralPath $id).Path
    return $app.Workbooks.Open($full)
  }
  $open = @($app.Workbooks | ForEach-Object { $_.Name }) -join ', '
  throw ("Workbook '" + $id + "' not open. Currently open: " + $open)
}
function Resolve-Sheet($wb, [string]$id) {
  if ([string]::IsNullOrWhiteSpace($id)) { return $wb.ActiveSheet }
  foreach ($s in $wb.Sheets) { if ($s.Name -ieq $id) { return $s } }
  throw ("Sheet '" + $id + "' not found in " + $wb.Name)
}
function Normalize-Value($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [double] -or $v -is [single] -or $v -is [decimal]) { return [double]$v }
  if ($v -is [int] -or $v -is [long]) { return [double]$v }
  if ($v -is [bool]) { return $v }
  if ($v -is [datetime]) { return $v.ToString('o') }
  return [string]$v
}
function Rect-Values($rng) {
  $raw = $rng.Value2
  if ($null -eq $raw) {
    return ,@(,@())
  }
  if ($raw -isnot [System.Array]) {
    return ,@(,@((Normalize-Value $raw)))
  }
  $rows = $raw.GetLength(0)
  $cols = $raw.GetLength(1)
  $out = New-Object System.Collections.Generic.List[object]
  for ($r = 1; $r -le $rows; $r++) {
    $row = New-Object System.Collections.Generic.List[object]
    for ($c = 1; $c -le $cols; $c++) {
      [void]$row.Add((Normalize-Value $raw[$r, $c]))
    }
    [void]$out.Add($row.ToArray())
  }
  return ,$out.ToArray()
}
function Save-If([bool]$flag, $wb) { if ($flag) { $wb.Save() } }
`.trim()

function buildList() {
  return `
${HEADER}
$out = New-Object System.Collections.Generic.List[object]
foreach ($wb in $app.Workbooks) {
  [void]$out.Add([pscustomobject]@{
    name = $wb.Name
    path = $wb.FullName
    saved = [bool]$wb.Saved
    readonly = [bool]$wb.ReadOnly
  })
}
$arr = $out.ToArray()
if ($arr.Length -eq 0) { '[]' } else { ConvertTo-Json -InputObject ([object[]]$arr) -Depth 4 -Compress }
`
}

function buildOpen(input: ExcelInput) {
  if (!input.file_path) throw new Error("excel open requires file_path.")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.file_path)}'
[pscustomobject]@{ name = $wb.Name; path = $wb.FullName; saved = [bool]$wb.Saved } | ConvertTo-Json -Compress
`
}

function buildNewWorkbook(input: ExcelInput) {
  const savePath = input.file_path
  return `
${HEADER}
$wb = $app.Workbooks.Add()
${savePath ? `$wb.SaveAs('${ps(savePath)}')` : ""}
[pscustomobject]@{ name = $wb.Name; path = $wb.FullName; saved = [bool]$wb.Saved } | ConvertTo-Json -Compress
`
}

function buildSave(input: ExcelInput) {
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$wb.Save()
[pscustomobject]@{ name = $wb.Name; path = $wb.FullName; saved = [bool]$wb.Saved } | ConvertTo-Json -Compress
`
}

function buildSaveAs(input: ExcelInput) {
  if (!input.file_path) throw new Error("excel save_as requires file_path.")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$wb.SaveAs('${ps(input.file_path)}')
[pscustomobject]@{ name = $wb.Name; path = $wb.FullName; saved = [bool]$wb.Saved } | ConvertTo-Json -Compress
`
}

function buildClose(input: ExcelInput) {
  const save = input.save === true ? "$true" : "$false"
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$name = $wb.Name
$wb.Close(${save})
[pscustomobject]@{ name = $name; closed = $true } | ConvertTo-Json -Compress
`
}

function buildListSheets(input: ExcelInput) {
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$out = New-Object System.Collections.Generic.List[object]
foreach ($s in $wb.Sheets) {
  $u = $s.UsedRange
  [void]$out.Add([pscustomobject]@{
    name = $s.Name
    index = [int]$s.Index
    used_range = $u.Address($false, $false)
    rows = [int]$u.Rows.Count
    cols = [int]$u.Columns.Count
  })
}
$arr = $out.ToArray()
if ($arr.Length -eq 0) { '[]' } else { ConvertTo-Json -InputObject ([object[]]$arr) -Depth 4 -Compress }
`
}

function buildAddSheet(input: ExcelInput) {
  if (!input.new_name) throw new Error("excel add_sheet requires new_name.")
  const after = input.after
    ? `$after = $wb.Sheets | Where-Object { $_.Name -ieq '${ps(input.after)}' } | Select-Object -First 1
$s = $wb.Sheets.Add([System.Type]::Missing, $after)`
    : `$s = $wb.Sheets.Add()`
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
${after}
$s.Name = '${ps(input.new_name)}'
Save-If $${input.save === true ? "true" : "false"} $wb
[pscustomobject]@{ name = $s.Name; index = [int]$s.Index } | ConvertTo-Json -Compress
`
}

function buildRenameSheet(input: ExcelInput) {
  if (!input.sheet || !input.new_name) throw new Error("excel rename_sheet requires sheet and new_name.")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet)}'
$old = $s.Name
$s.Name = '${ps(input.new_name)}'
Save-If $${input.save === true ? "true" : "false"} $wb
[pscustomobject]@{ renamed_from = $old; name = $s.Name } | ConvertTo-Json -Compress
`
}

function buildDeleteSheet(input: ExcelInput) {
  if (!input.sheet) throw new Error("excel delete_sheet requires sheet.")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet)}'
$name = $s.Name
$prev = $app.DisplayAlerts
try {
  $app.DisplayAlerts = $false
  $s.Delete()
} finally {
  $app.DisplayAlerts = $prev
}
Save-If $${input.save === true ? "true" : "false"} $wb
[pscustomobject]@{ deleted = $name } | ConvertTo-Json -Compress
`
}

function buildGetRange(input: ExcelInput) {
  if (!input.range) throw new Error("excel get_range requires range.")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$rng = $s.Range('${ps(input.range)}')
$vals = Rect-Values $rng
[pscustomobject]@{
  address = $rng.Address($false, $false, 1, $true)
  rows = [int]$rng.Rows.Count
  cols = [int]$rng.Columns.Count
  values = $vals
} | ConvertTo-Json -Depth 6 -Compress
`
}

function buildGetUsedRange(input: ExcelInput) {
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$rng = $s.UsedRange
$vals = Rect-Values $rng
[pscustomobject]@{
  address = $rng.Address($false, $false, 1, $true)
  rows = [int]$rng.Rows.Count
  cols = [int]$rng.Columns.Count
  values = $vals
} | ConvertTo-Json -Depth 6 -Compress
`
}

function buildGetCell(input: ExcelInput) {
  const addr = input.address ?? input.range
  if (!addr) throw new Error("excel get_cell requires address.")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$c = $s.Range('${ps(addr)}')
[pscustomobject]@{
  address = $c.Address($false, $false)
  value = Normalize-Value $c.Value2
  formula = [string]$c.Formula
  number_format = [string]$c.NumberFormat
  text = [string]$c.Text
} | ConvertTo-Json -Depth 4 -Compress
`
}

function buildFind(input: ExcelInput) {
  if (!input.query) throw new Error("excel find requires query.")
  const limit = input.limit ?? 200
  const matchCase = input.match_case === true ? "$true" : "$false"
  const whole = input.whole_cell === true
    ? "[Microsoft.Office.Interop.Excel.XlLookAt]::xlWhole"
    : "[Microsoft.Office.Interop.Excel.XlLookAt]::xlPart"
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$rng = $s.UsedRange
$hits = New-Object System.Collections.Generic.List[object]
$first = $rng.Find('${ps(input.query)}', $rng.Cells(1,1), [Microsoft.Office.Interop.Excel.XlFindLookIn]::xlValues, ${whole}, [Microsoft.Office.Interop.Excel.XlSearchOrder]::xlByRows, [Microsoft.Office.Interop.Excel.XlSearchDirection]::xlNext, ${matchCase}, $false, $false)
if ($first) {
  $cur = $first
  do {
    [void]$hits.Add([pscustomobject]@{
      address = $cur.Address($false, $false, 1, $true)
      value = Normalize-Value $cur.Value2
      formula = [string]$cur.Formula
    })
    if ($hits.Count -ge ${limit}) { break }
    $cur = $rng.FindNext($cur)
  } while ($cur -and $cur.Address -ne $first.Address)
}
$arr = $hits.ToArray()
if ($arr.Length -eq 0) { '[]' } else { ConvertTo-Json -InputObject ([object[]]$arr) -Depth 4 -Compress }
`
}

function scalarAssignment(value: ExcelInput["value"]) {
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "$true" : "$false"
  if (value === null || value === undefined) return "$null"
  return `'${ps(String(value))}'`
}

function buildSetCell(input: ExcelInput) {
  const addr = input.address ?? input.range
  if (!addr) throw new Error("excel set_cell requires address.")
  const save = input.save === true ? "$true" : "$false"
  const write = input.formula !== undefined
    ? `$c.Formula = '${ps(input.formula)}'`
    : `$c.Value2 = ${scalarAssignment(input.value)}`
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$c = $s.Range('${ps(addr)}')
${write}
Save-If ${save} $wb
[pscustomobject]@{
  address = $c.Address($false, $false)
  value = Normalize-Value $c.Value2
  formula = [string]$c.Formula
} | ConvertTo-Json -Compress
`
}

function buildSetRange(input: ExcelInput) {
  if (!input.range) throw new Error("excel set_range requires range.")
  if (!input.values && !input.formulas) throw new Error("excel set_range requires values or formulas.")
  const save = input.save === true ? "$true" : "$false"
  const valuesBlock = input.values ? decodeBlock("rawValues", input.values) : ""
  const formulasBlock = input.formulas ? decodeBlock("rawFormulas", input.formulas) : ""
  const applyValues = input.values
    ? `
$rows = $rawValues.Count
$cols = if ($rows -gt 0 -and $rawValues[0]) { $rawValues[0].Count } else { 0 }
if ($rows -gt 0 -and $cols -gt 0) {
  $arr = New-Object 'object[,]' $rows, $cols
  for ($r = 0; $r -lt $rows; $r++) {
    $row = $rawValues[$r]
    for ($c = 0; $c -lt $cols; $c++) {
      $arr[$r, $c] = $row[$c]
    }
  }
  $target = $s.Range('${ps(input.range)}').Resize($rows, $cols)
  $target.Value2 = $arr
}
`.trim()
    : ""
  const applyFormulas = input.formulas
    ? `
$rows = $rawFormulas.Count
$cols = if ($rows -gt 0 -and $rawFormulas[0]) { $rawFormulas[0].Count } else { 0 }
if ($rows -gt 0 -and $cols -gt 0) {
  $arr = New-Object 'object[,]' $rows, $cols
  for ($r = 0; $r -lt $rows; $r++) {
    $row = $rawFormulas[$r]
    for ($c = 0; $c -lt $cols; $c++) {
      $arr[$r, $c] = [string]$row[$c]
    }
  }
  $target = $s.Range('${ps(input.range)}').Resize($rows, $cols)
  $target.Formula = $arr
}
`.trim()
    : ""
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
${valuesBlock}
${formulasBlock}
${applyValues}
${applyFormulas}
$final = $s.Range('${ps(input.range)}')
Save-If ${save} $wb
[pscustomobject]@{
  address = $final.Address($false, $false, 1, $true)
  rows = [int]$final.Rows.Count
  cols = [int]$final.Columns.Count
} | ConvertTo-Json -Compress
`
}

function buildAppendRow(input: ExcelInput) {
  const row = input.values?.[0] ?? (Array.isArray(input.value) ? (input.value as unknown[]) : undefined)
  if (!row) throw new Error("excel append_row requires values with one row.")
  const save = input.save === true ? "$true" : "$false"
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
${decodeBlock("rawRow", row)}
$cols = $rawRow.Count
$u = $s.UsedRange
$nextRow = 1
if ($u -and $u.Cells.Count -gt 0) { $nextRow = $u.Row + $u.Rows.Count }
$target = $s.Cells.Item($nextRow, 1).Resize(1, $cols)
$arr = New-Object 'object[,]' 1, $cols
for ($c = 0; $c -lt $cols; $c++) { $arr[0, $c] = $rawRow[$c] }
$target.Value2 = $arr
Save-If ${save} $wb
[pscustomobject]@{
  address = $target.Address($false, $false, 1, $true)
  row = $nextRow
  cols = $cols
} | ConvertTo-Json -Compress
`
}

function buildClearRange(input: ExcelInput) {
  if (!input.range) throw new Error("excel clear_range requires range.")
  const what = input.what ?? "contents"
  const call = what === "formats" ? "$r.ClearFormats()" : what === "all" ? "$r.Clear()" : "$r.ClearContents()"
  const save = input.save === true ? "$true" : "$false"
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$r = $s.Range('${ps(input.range)}')
${call}
Save-If ${save} $wb
[pscustomobject]@{ cleared = $r.Address($false, $false, 1, $true); what = '${what}' } | ConvertTo-Json -Compress
`
}

function buildEvaluate(input: ExcelInput) {
  if (!input.expression) throw new Error("excel evaluate requires expression.")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$null = $wb
$result = $app.Evaluate('${ps(input.expression)}')
if ($result -is [System.Array]) {
  $rows = $result.GetLength(0)
  $cols = $result.GetLength(1)
  $out = New-Object System.Collections.Generic.List[object]
  for ($r = 1; $r -le $rows; $r++) {
    $row = New-Object System.Collections.Generic.List[object]
    for ($c = 1; $c -le $cols; $c++) { [void]$row.Add((Normalize-Value $result[$r, $c])) }
    [void]$out.Add($row.ToArray())
  }
  [pscustomobject]@{ kind = 'array'; rows = $rows; cols = $cols; values = $out.ToArray() } | ConvertTo-Json -Depth 6 -Compress
} else {
  [pscustomobject]@{ kind = 'scalar'; value = Normalize-Value $result } | ConvertTo-Json -Compress
}
`
}

function buildRunMacro(input: ExcelInput) {
  if (!input.macro) throw new Error("excel run_macro requires macro.")
  const argsJson = input.args ?? []
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$null = $wb
${decodeBlock("rawArgs", argsJson)}
$argList = @()
foreach ($a in $rawArgs) { $argList += ,$a }
$result = $app.Run('${ps(input.macro)}', $argList)
[pscustomobject]@{ kind = 'scalar'; value = Normalize-Value $result } | ConvertTo-Json -Compress
`
}

function buildListTables(input: ExcelInput) {
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$out = New-Object System.Collections.Generic.List[object]
foreach ($s in $wb.Sheets) {
  foreach ($t in $s.ListObjects) {
    [void]$out.Add([pscustomobject]@{
      sheet = $s.Name
      name = $t.Name
      range = $t.Range.Address($false, $false, 1, $true)
      rows = [int]$t.ListRows.Count
      columns = [int]$t.ListColumns.Count
    })
  }
}
$arr = $out.ToArray()
if ($arr.Length -eq 0) { '[]' } else { ConvertTo-Json -InputObject ([object[]]$arr) -Depth 4 -Compress }
`
}

function buildGetTable(input: ExcelInput) {
  if (!input.table) throw new Error("excel get_table requires table.")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$hit = $null
foreach ($s in $wb.Sheets) {
  foreach ($t in $s.ListObjects) {
    if ($t.Name -ieq '${ps(input.table)}') { $hit = $t; break }
  }
  if ($hit) { break }
}
if (-not $hit) { throw ("Table '" + '${ps(input.table)}' + "' not found in " + $wb.Name) }
$headers = @()
foreach ($c in $hit.HeaderRowRange.Cells) { $headers += [string]$c.Value2 }
$rows = New-Object System.Collections.Generic.List[object]
if ($hit.DataBodyRange) {
  $raw = $hit.DataBodyRange.Value2
  if ($raw -isnot [System.Array]) {
    $r = [ordered]@{}
    for ($i = 0; $i -lt $headers.Count; $i++) { $r[$headers[$i]] = Normalize-Value $raw }
    [void]$rows.Add([pscustomobject]$r)
  } else {
    $rn = $raw.GetLength(0)
    $cn = $raw.GetLength(1)
    for ($r = 1; $r -le $rn; $r++) {
      $obj = [ordered]@{}
      for ($c = 1; $c -le $cn; $c++) {
        $name = if ($c -le $headers.Count) { $headers[$c - 1] } else { "col$c" }
        $obj[$name] = Normalize-Value $raw[$r, $c]
      }
      [void]$rows.Add([pscustomobject]$obj)
    }
  }
}
[pscustomobject]@{
  name = $hit.Name
  sheet = $hit.Parent.Name
  headers = $headers
  rows = $rows.ToArray()
} | ConvertTo-Json -Depth 6 -Compress
`
}

function buildFormat(input: ExcelInput) {
  if (!input.range) throw new Error("excel format requires range.")
  const save = input.save === true ? "$true" : "$false"
  const stmts: string[] = []
  if (input.number_format) stmts.push(`$r.NumberFormat = '${ps(input.number_format)}'`)
  if (input.bold !== undefined) stmts.push(`$r.Font.Bold = $${input.bold ? "true" : "false"}`)
  if (input.italic !== undefined) stmts.push(`$r.Font.Italic = $${input.italic ? "true" : "false"}`)
  if (input.font_color) stmts.push(`$r.Font.Color = ${colorLiteral(input.font_color)}`)
  if (input.fill_color) stmts.push(`$r.Interior.Color = ${colorLiteral(input.fill_color)}`)
  if (input.horizontal_align) {
    const map: Record<string, string> = {
      left: "-4131", // xlLeft
      center: "-4108", // xlCenter
      right: "-4152", // xlRight
    }
    stmts.push(`$r.HorizontalAlignment = ${map[input.horizontal_align]}`)
  }
  if (input.wrap_text !== undefined) stmts.push(`$r.WrapText = $${input.wrap_text ? "true" : "false"}`)
  if (stmts.length === 0) throw new Error("excel format requires at least one format option.")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$r = $s.Range('${ps(input.range)}')
${stmts.join("\n")}
Save-If ${save} $wb
[pscustomobject]@{ formatted = $r.Address($false, $false, 1, $true) } | ConvertTo-Json -Compress
`
}

function colorLiteral(color: string) {
  const hex = color.replace(/^#/, "").trim()
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    // Excel Color uses BGR (decimal)
    return String(r + (g << 8) + (b << 16))
  }
  const n = Number(color)
  if (Number.isFinite(n)) return String(n)
  throw new Error(`excel format color must be hex (#rrggbb) or integer: ${color}`)
}

function buildAutofit(input: ExcelInput) {
  const what = input.what === "rows" ? "rows" : "columns"
  const range = input.range
  const save = input.save === true ? "$true" : "$false"
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$target = ${range ? `$s.Range('${ps(range)}')` : "$s.UsedRange"}
if ('${what}' -eq 'rows') { $target.Rows.AutoFit() | Out-Null } else { $target.Columns.AutoFit() | Out-Null }
Save-If ${save} $wb
[pscustomobject]@{ autofit = '${what}'; address = $target.Address($false, $false, 1, $true) } | ConvertTo-Json -Compress
`
}

function buildSort(input: ExcelInput) {
  if (!input.range) throw new Error("excel sort requires range.")
  if (!input.columns || input.columns.length === 0) throw new Error("excel sort requires columns.")
  const header = input.has_header === false ? "xlNo" : "xlYes"
  const save = input.save === true ? "$true" : "$false"
  const sortCalls = input.columns
    .slice(0, 3)
    .map((c, idx) => {
      const key = `Key${idx + 1}`
      const order = `Order${idx + 1}`
      const dir = c.ascending === false ? "xlDescending" : "xlAscending"
      return `-${key} $r.Columns.Item(${c.column}) -${order} ([Microsoft.Office.Interop.Excel.XlSortOrder]::${dir})`
    })
    .join(" ")
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$r = $s.Range('${ps(input.range)}')
$r.Sort ${sortCalls} -Header ([Microsoft.Office.Interop.Excel.XlYesNoGuess]::${header})
Save-If ${save} $wb
[pscustomobject]@{ sorted = $r.Address($false, $false, 1, $true) } | ConvertTo-Json -Compress
`
}

function buildFilter(input: ExcelInput) {
  if (!input.range) throw new Error("excel filter requires range.")
  const save = input.save === true ? "$true" : "$false"
  if (input.clear === true) {
    return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
if ($s.AutoFilterMode) { $s.AutoFilterMode = $false }
Save-If ${save} $wb
[pscustomobject]@{ filter = 'cleared' } | ConvertTo-Json -Compress
`
  }
  const col = input.column ?? 1
  const crit = input.criteria ?? ""
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$r = $s.Range('${ps(input.range)}')
$r.AutoFilter(${col}, '${ps(crit)}') | Out-Null
Save-If ${save} $wb
[pscustomobject]@{ filter = 'applied'; column = ${col}; criteria = '${ps(crit)}' } | ConvertTo-Json -Compress
`
}

function buildChart(input: ExcelInput) {
  if (!input.range) throw new Error("excel chart requires range.")
  const save = input.save === true ? "$true" : "$false"
  const typeMap: Record<string, string> = {
    column: "xlColumnClustered",
    bar: "xlBarClustered",
    line: "xlLine",
    pie: "xlPie",
    scatter: "xlXYScatter",
    area: "xlArea",
  }
  const chartType = typeMap[input.chart_type ?? "column"]
  const title = input.title ? `$chart.Chart.HasTitle = $true; $chart.Chart.ChartTitle.Text = '${ps(input.title)}'` : ""
  return `
${HEADER}
$wb = Resolve-Workbook '${ps(input.workbook ?? "")}'
$s = Resolve-Sheet $wb '${ps(input.sheet ?? "")}'
$data = $s.Range('${ps(input.range)}')
$chart = $s.Shapes.AddChart2(-1, [Microsoft.Office.Interop.Excel.XlChartType]::${chartType}, $data.Left + $data.Width + 20, $data.Top, 400, 300)
$chart.Chart.SetSourceData($data)
${title}
Save-If ${save} $wb
[pscustomobject]@{ chart = $chart.Name; type = '${input.chart_type ?? "column"}'; sheet = $s.Name } | ConvertTo-Json -Compress
`
}

export function build(input: ExcelInput): string {
  switch (input.action) {
    case "list_workbooks":
      return buildList()
    case "open":
      return buildOpen(input)
    case "new_workbook":
      return buildNewWorkbook(input)
    case "save":
      return buildSave(input)
    case "save_as":
      return buildSaveAs(input)
    case "close":
      return buildClose(input)
    case "list_sheets":
      return buildListSheets(input)
    case "add_sheet":
      return buildAddSheet(input)
    case "rename_sheet":
      return buildRenameSheet(input)
    case "delete_sheet":
      return buildDeleteSheet(input)
    case "get_range":
      return buildGetRange(input)
    case "get_used_range":
      return buildGetUsedRange(input)
    case "get_cell":
      return buildGetCell(input)
    case "find":
      return buildFind(input)
    case "set_cell":
      return buildSetCell(input)
    case "set_range":
      return buildSetRange(input)
    case "append_row":
      return buildAppendRow(input)
    case "clear_range":
      return buildClearRange(input)
    case "evaluate":
      return buildEvaluate(input)
    case "run_macro":
      return buildRunMacro(input)
    case "list_tables":
      return buildListTables(input)
    case "get_table":
      return buildGetTable(input)
    case "format":
      return buildFormat(input)
    case "autofit":
      return buildAutofit(input)
    case "sort":
      return buildSort(input)
    case "filter":
      return buildFilter(input)
    case "chart":
      return buildChart(input)
  }
}

const DESTRUCTIVE = new Set<ExcelInput["action"]>([
  "delete_sheet",
  "clear_range",
  "save_as",
  "close",
])

export const ExcelTool = Tool.define("excel", {
  description:
    "Drive Microsoft Excel via COM. Read and write cells/ranges, run VBA macros, evaluate formulas, manage sheets and workbooks, format, sort, filter, chart. Reuses an already-open workbook when possible; never auto-saves unless you pass save=true.",
  parameters,
  async execute(input, ctx) {
    await ctx.ask({
      permission: "excel",
      patterns: ["*"],
      always: ["*"],
      metadata: {
        action: input.action,
        workbook: input.workbook,
        sheet: input.sheet,
        range: input.range ?? input.address,
        destructive: DESTRUCTIVE.has(input.action),
      },
    })
    if (input.action === "run_macro") {
      await ctx.ask({
        permission: "excel_macro",
        patterns: [input.macro ?? "*"],
        always: [input.macro ?? "*"],
        metadata: {
          macro: input.macro,
          args: input.args,
          workbook: input.workbook,
        },
      })
    }
    const script = build(input)
    const out = await run(script, ctx.abort)
    const body = out.trim() || "{}"
    return {
      title: `Excel: ${input.action}`,
      output: body,
      metadata: {
        action: input.action,
        workbook: input.workbook ?? "",
        sheet: input.sheet ?? "",
        chars: body.length,
      },
    }
  },
})
