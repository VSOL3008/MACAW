export async function extractPdfText(data: ArrayBuffer): Promise<string> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  })
  const doc = await task.promise
  const out: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const text = content.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim()
    out.push(text)
  }
  await doc.destroy()
  return out.join("\n\n---\n\n")
}

export function textUrl(text: string) {
  const bytes = new TextEncoder().encode(text)
  let raw = ""
  for (const byte of bytes) raw += String.fromCharCode(byte)
  return `data:text/plain;charset=utf-8;base64,${btoa(raw)}`
}
