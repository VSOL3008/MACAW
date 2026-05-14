function toBytes(data: Uint8Array | Buffer | ArrayBuffer): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

export async function extractPdfText(data: Uint8Array | Buffer | ArrayBuffer): Promise<string> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const task = pdfjs.getDocument({
    data: toBytes(data),
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
      .map((i: any) => ("str" in i ? i.str : ""))
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim()
    out.push(text)
  }
  await doc.destroy()
  return out.join("\n\n---\n\n")
}

export function decodeDataBytes(url: string): Uint8Array {
  const idx = url.indexOf(",")
  if (idx === -1) return new Uint8Array(0)
  const head = url.slice(0, idx)
  const body = url.slice(idx + 1)
  const buf = head.includes(";base64")
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body), "utf8")
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}
