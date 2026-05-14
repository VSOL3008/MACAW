import { Database as Bsqlite } from "bun:sqlite"
const db = new Bsqlite(String.raw`C:\Users\LYV1JH\.local\share\opencode\opencode-local.db`, { readonly: true })
const since = Date.now() - 60 * 60 * 1000 // last hour
const parts = db.query(`SELECT id, message_id, session_id, time_created, data FROM part WHERE time_created > ? ORDER BY time_created DESC LIMIT 200`).all(since) as any[]
console.log(`parts in last 60min: ${parts.length}`)
let shown = 0
for (const p of parts) {
  const d = JSON.parse(p.data || "{}")
  if (d.type !== "tool") continue
  if (!["webfetch", "websearch", "codesearch", "fetch"].includes(d.tool)) continue
  const t = new Date(p.time_created).toISOString()
  console.log(`---[${t}] tool=${d.tool}, status=${d.state?.status}, session=${p.session_id}`)
  if (d.state?.input) console.log(`  input: ${JSON.stringify(d.state.input).slice(0, 250)}`)
  if (d.state?.error) console.log(`  error: ${String(d.state.error).slice(0, 800)}`)
  if (d.state?.output) console.log(`  output: ${String(d.state.output).slice(0, 500)}`)
  shown++
  if (shown >= 20) break
}
