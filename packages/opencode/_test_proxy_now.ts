import { Proxy } from "./src/util/proxy"

console.log("HTTPS_PROXY=", process.env.HTTPS_PROXY)
console.log("HTTP_PROXY=", process.env.HTTP_PROXY)
console.log("NO_PROXY=", process.env.NO_PROXY)

for (const u of ["https://opencode.ai", "https://github.com/opencode-ai/opencode", "https://en.wikipedia.org/wiki/OpenCode", "https://example.com"]) {
  const t0 = Date.now()
  try {
    const r = await Proxy.fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36" } })
    console.log(`OK [${u}] status=${r.status} elapsed=${Date.now()-t0}ms`)
    const text = await r.text()
    console.log(`  body length=${text.length}`)
  } catch (e: any) {
    console.error(`FAIL [${u}] after ${Date.now()-t0}ms: ${e.message}`)
    if (e.cause) console.error(`  cause: ${e.cause}`)
  }
}
