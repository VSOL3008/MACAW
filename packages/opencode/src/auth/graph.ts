import os from "os"
import path from "path"
import fs from "fs/promises"
import { Global } from "../global"

const GRAPH = "https://graph.microsoft.com"

// Default client id = Microsoft Azure CLI public client
// (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`). It is pre-approved in virtually
// every enterprise tenant because IT needs it to manage Azure, so silent SSO
// via the Windows broker usually succeeds without admin consent.
// Override with MACAW_GRAPH_CLIENT_ID for an app registered in your own tenant.
const DEFAULT_CLIENT_ID = process.env.MACAW_GRAPH_CLIENT_ID || "04b07795-8ddb-461a-bbee-02f9e1bf7b46"

// Set MACAW_GRAPH_INTERACTIVE=0 to disable the one-time Windows account-picker
// popup; the chain will then only use disk cache, az, and silent MSAL.
const INTERACTIVE_ENABLED = process.env.MACAW_GRAPH_INTERACTIVE !== "0"

type AzTokenResponse = {
  accessToken: string
  expiresOn?: string
  expires_on?: number
}

type Cached = {
  token: string
  expires: number
  source: "az" | "msal"
}

const cachePath = () => path.join(Global.Path.cache, "graph-token.json")

async function readCache(): Promise<Cached | undefined> {
  const file = Bun.file(cachePath())
  if (!(await file.exists())) return undefined
  const data = (await file.json().catch(() => undefined)) as Cached | undefined
  if (!data || typeof data.token !== "string" || typeof data.expires !== "number") return undefined
  if (Date.now() + 60_000 > data.expires) return undefined
  return data
}

async function writeCache(entry: Cached) {
  await fs.mkdir(path.dirname(cachePath()), { recursive: true })
  await Bun.write(cachePath(), JSON.stringify(entry))
}

export async function clearCache() {
  await fs.rm(cachePath(), { force: true }).catch(() => undefined)
}

async function has(cmd: string) {
  const probe = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`
  const child = Bun.spawn(["powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probe], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await child.exited
  return code === 0
}

async function fromAz(scopes: string[]): Promise<Cached | undefined> {
  if (!(await has("az"))) return undefined
  const tenant = process.env.MACAW_GRAPH_TENANT
  const args = [
    "az",
    "account",
    "get-access-token",
    "--resource",
    GRAPH,
    "--output",
    "json",
    ...(tenant ? ["--tenant", tenant] : []),
  ]
  const child = Bun.spawn(
    process.platform === "win32"
      ? ["powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", args.join(" ")]
      : args,
    { stdout: "pipe", stderr: "pipe" },
  )
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) return undefined
  const data = JSON.parse(out.trim()) as AzTokenResponse
  if (!data?.accessToken) return undefined
  const expires = data.expires_on ? data.expires_on * 1000 : data.expiresOn ? new Date(data.expiresOn).getTime() : Date.now() + 45 * 60_000
  void scopes
  return { token: data.accessToken, expires, source: "az" }
}

type MsalModule = typeof import("@azure/msal-node")
type MsalExtModule = typeof import("@azure/msal-node-extensions")

let msalMod: Promise<MsalModule> | undefined
let extMod: Promise<MsalExtModule> | undefined

function loadMsal() {
  if (!msalMod) msalMod = import("@azure/msal-node")
  return msalMod
}

function loadExt() {
  if (!extMod) extMod = import("@azure/msal-node-extensions")
  return extMod
}

async function persistence() {
  const { PersistenceCreator, DataProtectionScope } = await loadExt()
  return PersistenceCreator.createPersistence({
    cachePath: path.join(Global.Path.cache, "msal-cache.json"),
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: "opencode-graph",
    accountName: os.userInfo().username || "opencode",
    usePlaintextFileOnLinux: false,
  })
}

async function buildPca() {
  if (process.platform !== "win32") return undefined
  const { PublicClientApplication, LogLevel } = await loadMsal()
  const { PersistenceCachePlugin, NativeBrokerPlugin } = await loadExt()
  const persist = await persistence()
  const cachePlugin = new PersistenceCachePlugin(persist)
  const tenant = process.env.MACAW_GRAPH_TENANT || "common"
  return new PublicClientApplication({
    auth: {
      clientId: DEFAULT_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${tenant}`,
    },
    cache: { cachePlugin },
    broker: { nativeBrokerPlugin: new NativeBrokerPlugin() },
    system: {
      loggerOptions: {
        loggerCallback: () => undefined,
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
      },
    },
  })
}

function expiresOf(res: { accessToken: string; expiresOn?: Date | null }): number {
  return res.expiresOn ? res.expiresOn.getTime() : Date.now() + 45 * 60_000
}

async function fromMsalSilent(scopes: string[]): Promise<Cached | undefined> {
  const pca = await buildPca().catch(() => undefined)
  if (!pca) return undefined
  const accounts = await pca.getTokenCache().getAllAccounts().catch(() => [])
  if (!accounts.length) return undefined
  const res = await pca.acquireTokenSilent({ scopes, account: accounts[0]! }).catch(() => undefined)
  if (!res?.accessToken) return undefined
  return { token: res.accessToken, expires: expiresOf(res), source: "msal" }
}

async function openBrowser(url: string) {
  if (process.platform !== "win32") return
  Bun.spawn(["powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`], {
    stdout: "ignore",
    stderr: "ignore",
  })
}

async function fromMsalInteractive(scopes: string[]): Promise<Cached | undefined> {
  if (!INTERACTIVE_ENABLED) return undefined
  const pca = await buildPca().catch(() => undefined)
  if (!pca) return undefined
  const res = await pca
    .acquireTokenInteractive({
      scopes,
      prompt: "select_account",
      windowHandle: Buffer.alloc(0),
      openBrowser,
    })
    .catch(() => undefined)
  if (!res?.accessToken) return undefined
  return { token: res.accessToken, expires: expiresOf(res), source: "msal" }
}

function consentHint(scopes: string[]) {
  const tenant = process.env.MACAW_GRAPH_TENANT || "common"
  const list = scopes.join(" ")
  const url = `https://login.microsoftonline.com/${tenant}/adminconsent?client_id=${DEFAULT_CLIENT_ID}`
  return [
    "Could not acquire a Microsoft Graph token. Every silent path (disk cache, Azure CLI, Windows broker) failed,",
    "and the interactive Windows account picker was either dismissed or not available.",
    "",
    "What to forward to IT:",
    `  Client id:    ${DEFAULT_CLIENT_ID}`,
    `  Scopes:       ${list}`,
    `  Consent URL:  ${url}`,
    "",
    "Self-serve options:",
    "  1. Run `az login` once (if Azure CLI is installed). It handles enterprise SSO in your browser.",
    "  2. Set MACAW_GRAPH_CLIENT_ID to a client id that is already approved in your tenant.",
    "  3. Set MACAW_GRAPH_TENANT to your tenant GUID if your account is not in the home tenant.",
    "  4. Set MACAW_GRAPH_INTERACTIVE=0 to disable the Windows account picker if it misbehaves.",
  ].join("\n")
}

export async function acquireToken(scopes: string[]): Promise<string> {
  const cached = await readCache()
  if (cached) return cached.token

  const viaAz = await fromAz(scopes).catch(() => undefined)
  if (viaAz) {
    await writeCache(viaAz)
    return viaAz.token
  }

  const viaSilent = await fromMsalSilent(scopes).catch(() => undefined)
  if (viaSilent) {
    await writeCache(viaSilent)
    return viaSilent.token
  }

  const viaInteractive = await fromMsalInteractive(scopes).catch(() => undefined)
  if (viaInteractive) {
    await writeCache(viaInteractive)
    return viaInteractive.token
  }

  throw new Error(consentHint(scopes))
}

export function scopesFor(action: string): string[] {
  switch (action) {
    case "list_chats":
    case "list_messages":
    case "search_chats":
      return ["Chat.Read"]
    case "list_teams":
      return ["Team.ReadBasic.All"]
    case "list_channels":
      return ["Channel.ReadBasic.All"]
    case "list_channel_messages":
      return ["ChannelMessage.Read.All"]
    case "list_meetings":
      return ["Calendars.Read"]
    case "presence":
      return ["Presence.Read"]
    default:
      return ["User.Read"]
  }
}

export { DEFAULT_CLIENT_ID, consentHint }
