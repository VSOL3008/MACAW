import { describe, expect, test } from "bun:test"
import { build, ExcelTool, parameters } from "../../src/tool/excel"

function b64Decode(s: string) {
  return Buffer.from(s, "base64").toString("utf8")
}

describe("excel.parameters", () => {
  test("accepts list_workbooks", () => {
    expect(parameters.parse({ action: "list_workbooks" }).action).toBe("list_workbooks")
  })

  test("rejects unknown actions", () => {
    expect(() => parameters.parse({ action: "destroy_workbook" })).toThrow()
  })

  test("caps limit at 5000", () => {
    expect(() => parameters.parse({ action: "find", query: "x", limit: 9999 })).toThrow()
  })

  test("2D values shape", () => {
    const p = parameters.parse({ action: "set_range", range: "A1:B2", values: [[1, 2], [3, 4]] })
    expect(p.values).toEqual([[1, 2], [3, 4]])
  })
})

describe("excel.build lifecycle", () => {
  test("list_workbooks enumerates Workbooks", () => {
    const s = build({ action: "list_workbooks" })
    expect(s).toContain("$app.Workbooks")
    expect(s).toContain("GetActiveObject")
    expect(s).toContain("Resolve-Workbook")
  })

  test("open requires file_path", () => {
    expect(() => build({ action: "open" })).toThrow("file_path")
  })

  test("save_as embeds new path", () => {
    const s = build({ action: "save_as", workbook: "Book1.xlsx", file_path: "C:\\tmp\\out.xlsx" })
    expect(s).toContain("$wb.SaveAs('C:\\tmp\\out.xlsx')")
  })

  test("close honors save flag", () => {
    const saveYes = build({ action: "close", workbook: "Book1.xlsx", save: true })
    const saveNo = build({ action: "close", workbook: "Book1.xlsx" })
    expect(saveYes).toContain("$wb.Close($true)")
    expect(saveNo).toContain("$wb.Close($false)")
  })
})

describe("excel.build read", () => {
  test("get_range uses Range().Value2 path", () => {
    const s = build({ action: "get_range", range: "A1:C3", sheet: "Data" })
    expect(s).toContain("$s.Range('A1:C3')")
    expect(s).toContain("Rect-Values $rng")
  })

  test("get_cell requires address", () => {
    expect(() => build({ action: "get_cell" })).toThrow("address")
    const s = build({ action: "get_cell", address: "B2" })
    expect(s).toContain("$s.Range('B2')")
    expect(s).toContain("number_format")
  })

  test("find embeds query and XlLookAt", () => {
    const whole = build({ action: "find", query: "invoice", whole_cell: true })
    const part = build({ action: "find", query: "invoice" })
    expect(whole).toContain("xlWhole")
    expect(part).toContain("xlPart")
    expect(whole).toContain("$rng.Find('invoice'")
  })

  test("list_tables walks ListObjects", () => {
    const s = build({ action: "list_tables" })
    expect(s).toContain("foreach ($t in $s.ListObjects)")
  })
})

describe("excel.build write", () => {
  test("set_cell with formula uses Formula =", () => {
    const s = build({ action: "set_cell", address: "C1", formula: "=SUM(A1:A10)" })
    expect(s).toContain("$c.Formula = '=SUM(A1:A10)'")
    expect(s).not.toContain("$c.Value2 =")
  })

  test("set_cell with numeric value uses Value2", () => {
    const s = build({ action: "set_cell", address: "C1", value: 42 })
    expect(s).toContain("$c.Value2 = 42")
  })

  test("set_cell with string value is quoted", () => {
    const s = build({ action: "set_cell", address: "C1", value: "hello" })
    expect(s).toContain("$c.Value2 = 'hello'")
  })

  test("set_range base64-encodes 2D values (no $ interpolation risk)", () => {
    const s = build({ action: "set_range", range: "A1:B2", values: [[1, "$bar"], [3, 4]] })
    const match = s.match(/FromBase64String\('([^']+)'\)/)!
    expect(match).toBeTruthy()
    const decoded = b64Decode(match[1])
    expect(JSON.parse(decoded)).toEqual([[1, "$bar"], [3, 4]])
    expect(s).not.toContain("$bar")
  })

  test("append_row accepts a single row and writes Value2", () => {
    const s = build({ action: "append_row", sheet: "Sheet1", values: [[1, 2, 3]] })
    expect(s).toContain("$target.Value2 = $arr")
    const match = s.match(/FromBase64String\('([^']+)'\)/)!
    expect(JSON.parse(b64Decode(match[1]))).toEqual([1, 2, 3])
  })

  test("clear_range maps what=formats to ClearFormats", () => {
    const formats = build({ action: "clear_range", range: "A1:A10", what: "formats" })
    const all = build({ action: "clear_range", range: "A1:A10", what: "all" })
    const contents = build({ action: "clear_range", range: "A1:A10" })
    expect(formats).toContain("$r.ClearFormats()")
    expect(all).toContain("$r.Clear()")
    expect(contents).toContain("$r.ClearContents()")
  })
})

describe("excel.build advanced", () => {
  test("evaluate calls Application.Evaluate", () => {
    const s = build({ action: "evaluate", expression: "=SUM(A1:A5)" })
    expect(s).toContain("$app.Evaluate('=SUM(A1:A5)')")
  })

  test("run_macro calls Application.Run with args", () => {
    const s = build({ action: "run_macro", macro: "Module1.Hello", args: ["a", 2] })
    expect(s).toContain("$app.Run('Module1.Hello', $argList)")
    const match = s.match(/FromBase64String\('([^']+)'\)/)!
    expect(JSON.parse(b64Decode(match[1]))).toEqual(["a", 2])
  })

  test("delete_sheet guards DisplayAlerts locally", () => {
    const s = build({ action: "delete_sheet", sheet: "Old" })
    expect(s).toContain("$prev = $app.DisplayAlerts")
    expect(s).toContain("$app.DisplayAlerts = $false")
    expect(s).toContain("$app.DisplayAlerts = $prev")
  })

  test("format maps colors to BGR decimal", () => {
    const s = build({ action: "format", range: "A1:A5", font_color: "#ff0000", fill_color: "#00ff00" })
    expect(s).toContain("$r.Font.Color = 255")
    expect(s).toContain("$r.Interior.Color = 65280")
  })

  test("format requires at least one option", () => {
    expect(() => build({ action: "format", range: "A1:A5" })).toThrow("format option")
  })

  test("sort uses Key1/Order1 and direction", () => {
    const s = build({
      action: "sort",
      range: "A1:C10",
      columns: [{ column: 2, ascending: false }],
    })
    expect(s).toContain("-Key1 $r.Columns.Item(2)")
    expect(s).toContain("xlDescending")
  })

  test("filter clear tears down AutoFilter", () => {
    const s = build({ action: "filter", range: "A1:C10", clear: true })
    expect(s).toContain("$s.AutoFilterMode = $false")
  })

  test("chart uses AddChart2 with type", () => {
    const s = build({
      action: "chart",
      range: "A1:B10",
      chart_type: "pie",
      title: "Shares",
    })
    expect(s).toContain("xlPie")
    expect(s).toContain("Shapes.AddChart2")
    expect(s).toContain("Shares")
  })
})

describe("ExcelTool", () => {
  test("registers as excel", () => {
    expect(ExcelTool.id).toBe("excel")
  })
})
