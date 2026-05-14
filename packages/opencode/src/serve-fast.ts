import path from "path"
import { EOL } from "os"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { Log } from "./util/log"
import { Heap } from "./cli/heap"
import { Installation } from "./installation"
import { Filesystem } from "./util/filesystem"
import { Global } from "./global"
import { JsonMigration } from "./storage/json-migration"
import { Database } from "./storage/db"
import { Server } from "./server/server"
import { Flag } from "./flag/flag"
import { Config } from "./config/config"
import { errorMessage } from "./util/error"

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", { e: errorMessage(e) })
})
process.on("uncaughtException", (e) => {
  Log.Default.error("exception", { e: errorMessage(e) })
})

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  return process.argv[i + 1] ?? fallback
}

const t0 = performance.now()

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: "INFO",
})
Heap.start()

process.env.AGENT = "1"
process.env.OPENCODE = "1"
process.env.OPENCODE_PID = String(process.pid)

Log.Default.info("opencode", { version: Installation.VERSION, args: process.argv.slice(2) })

const marker = path.join(Global.Path.data, "opencode.db")
if (!(await Filesystem.exists(marker))) {
  process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
  await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
    progress: (e) => process.stderr.write(`sqlite-migration:${Math.floor((e.current / e.total) * 100)}${EOL}`),
  })
  process.stderr.write("Database migration complete." + EOL)
}

if (!Flag.OPENCODE_SERVER_PASSWORD) {
  console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
}

const port = Number(arg("--port", "0"))
const cfg = await Config.getGlobal()
const hostname = arg("--hostname", cfg?.server?.hostname ?? "127.0.0.1")!
const cors = cfg?.server?.cors ?? []

const server = await Server.listen({ hostname, port, mdns: false, mdnsDomain: "opencode.local", cors })
const ms = Math.round(performance.now() - t0)
console.log(`opencode server listening on http://${server.hostname}:${server.port} (boot ${ms}ms)`)

await new Promise(() => {})
