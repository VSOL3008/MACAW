import { Auth } from "../../auth"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import path from "path"
import os from "os"
import { Global } from "../../global"
import { Env } from "../../env"

const OLLAMA = "ollama"

function count(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`
}

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: "manage Ollama credentials",
  builder: (yargs) =>
    yargs.command(ProvidersListCommand).command(ProvidersLoginCommand).command(ProvidersLogoutCommand).demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list Ollama credentials and environment",
  async handler(_args) {
    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    prompts.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const auth = await Auth.get(OLLAMA)
    if (!auth) {
      prompts.log.info(`Ollama ${UI.Style.TEXT_DIM}not configured`)
    } else {
      prompts.log.info(`Ollama ${UI.Style.TEXT_DIM}${auth.type}`)
    }
    prompts.outro(`${auth ? 1 : 0} credential`)

    const env = ["OLLAMA_BASE_URL", "OLLAMA_HOST", "OLLAMA_API_KEY"].filter((item) => Env.get(item))

    if (env.length > 0) {
      UI.empty()
      prompts.intro("Environment")
      for (const item of env) {
        prompts.log.info(`Ollama ${UI.Style.TEXT_DIM}${item}`)
      }
      prompts.outro(count(env.length, "environment variable"))
    }
  },
})

export const ProvidersLoginCommand = cmd({
  command: "login",
  describe: "save an Ollama API key",
  builder: (yargs) =>
    yargs
      .option("provider", {
        alias: ["p"],
        describe: "provider id to log in to",
        type: "string",
      }),
  async handler(args) {
    const provider = (args.provider ?? OLLAMA).trim().toLowerCase()
    if (provider !== OLLAMA) {
      prompts.log.error(`Unsupported provider "${provider}". MACAW only supports Ollama.`)
      process.exit(1)
    }
    UI.empty()
    prompts.intro("Add Ollama credential")
    prompts.log.info("Use OLLAMA_HOST, OLLAMA_BASE_URL, or provider.ollama.options.baseURL to point MACAW at your Ollama server.")
    const key = await prompts.password({
      message: "Enter your Ollama API key",
      validate: (x) => (x && x.length > 0 ? undefined : "Required"),
    })
    if (prompts.isCancel(key)) throw new UI.CancelledError()
    await Auth.set(OLLAMA, {
      type: "api",
      key,
    })
    prompts.outro("Done")
  },
})

export const ProvidersLogoutCommand = cmd({
  command: "logout",
  describe: "remove the saved Ollama API key",
  async handler(_args) {
    UI.empty()
    const auth = await Auth.get(OLLAMA)
    prompts.intro("Remove Ollama credential")
    if (!auth) {
      prompts.log.error("No Ollama credential found")
      return
    }
    await Auth.remove(OLLAMA)
    prompts.outro("Removed")
  },
})
