import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { Memory } from "../memory/memory"
import { Ripgrep } from "../file/ripgrep"
import { iife } from "@/util/iife"

const Parameters = z.object({
  name: z.string().describe("The name of the skill from available_skills"),
})

export const SkillTool = Tool.define("skill", async () => {
  const list = await Skill.available()

  const description =
    list.length === 0
      ? "Load a specialized skill that provides domain-specific instructions and workflows. No skills are currently available."
      : [
          "Load a specialized skill that provides domain-specific instructions and workflows.",
          "",
          "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
          "",
          "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
          "",
          'Tool output includes a `<skill_content name="...">` block with the loaded content.',
          "",
          "The following skills provide specialized sets of instructions for particular tasks",
          "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
          "",
          Skill.fmt(list, { verbose: false }),
        ].join("\n")

  return {
    description,
    parameters: Parameters,
    async execute(params: z.infer<typeof Parameters>, ctx) {
      const skill = await Skill.get(params.name)

      if (!skill) {
        const available = await Skill.all().then((x) => x.map((skill) => skill.name).join(", "))
        throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
      }

      await ctx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })

      const dir = path.dirname(skill.location)
      const base = pathToFileURL(dir).href

      const limit = 10
      const files = await iife(async () => {
        const arr = []
        for await (const file of Ripgrep.files({
          cwd: dir,
          follow: false,
          hidden: true,
          signal: ctx.abort,
        })) {
          if (file.includes("SKILL.md")) {
            continue
          }
          arr.push(path.resolve(dir, file))
          if (arr.length >= limit) {
            break
          }
        }
        return arr
      }).then((f) => f.map((file) => `<file>${file}</file>`).join("\n"))

      return {
        title: `Loaded skill: ${skill.name}`,
        output: [
          `<skill_content name="${skill.name}">`,
          `# Skill: ${skill.name}`,
          "",
          skill.content.trim(),
          "",
          `Base directory for this skill: ${base}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          files,
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
        metadata: {
          name: skill.name,
          dir,
        },
      }
    },
  }
})

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

const CreateParams = z.object({
  name: z
    .string()
    .regex(NAME, "name must be kebab-case, 1-64 chars, start with a letter or digit")
    .describe("Skill slug, used as folder name. Kebab-case, <=64 chars."),
  description: z
    .string()
    .min(1)
    .max(200)
    .describe("One-line summary of what this skill does and when to use it. <=200 chars."),
  body: z
    .string()
    .min(1)
    .describe("Markdown instructions. Do not include an H1 or frontmatter; the tool writes both."),
  overwrite: z.boolean().optional().describe("Replace an existing skill with the same name."),
})

function escape(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

async function register(name: string, description: string, rel: string) {
  const prior = await Memory.read("index.md").catch(() => "")
  const entry = `- [${name}](${rel}) - ${description}`
  if (prior.includes(`(${rel})`)) return
  const header = "## Skills"
  const idx = prior.indexOf(header)
  const next = idx === -1
    ? `${prior.trimEnd()}\n\n${header}\n${entry}\n`
    : (() => {
        const after = prior.indexOf("\n## ", idx + header.length)
        const head = prior.slice(0, idx + header.length)
        const mid = prior.slice(idx + header.length, after === -1 ? prior.length : after).replace(/^\s+|\s+$/g, "")
        const tail = after === -1 ? "" : prior.slice(after)
        const section = mid ? `${mid}\n${entry}` : entry
        return `${head}\n${section}\n${tail}`
      })()
  await Memory.write("index.md", next)
}

export const SkillCreateTool = Tool.define("skill_create", {
  description: [
    "Capture a reusable workflow as a SKILL. Writes ~/.macaw/memory/skills/<name>/SKILL.md with YAML frontmatter.",
    "Use after you have completed a non-trivial task the user is likely to repeat (a tool chain, a UI flow, a report).",
    "Do not create skills for trivial or one-off actions. Never include secrets in the body.",
    "The skill becomes discoverable on the next session: its name+description are auto-listed, and the `skill` tool can load the full body.",
  ].join(" "),
  parameters: CreateParams,
  async execute(input) {
    const rel = path.posix.join("skills", input.name, "SKILL.md")
    const full = path.join(Memory.root(), "skills", input.name, "SKILL.md")

    const exists = await fs.stat(full).then(() => true, () => false)
    if (exists && !input.overwrite) {
      throw new Error(`skill_create refused: "${input.name}" already exists. Pass overwrite: true to replace.`)
    }

    const body = input.body.trim()
    const content = [
      "---",
      `name: "${escape(input.name)}"`,
      `description: "${escape(input.description)}"`,
      "---",
      "",
      body,
      "",
    ].join("\n")

    const max = Memory.maxFile()
    if (Buffer.byteLength(content, "utf8") > max) {
      throw new Error(`skill_create refused: content exceeds ${max} bytes`)
    }

    await Memory.write(rel, content)
    await register(input.name, input.description, rel)
    await Memory.logEntry("write", rel)

    return {
      title: input.name,
      output: `Saved skill "${input.name}" at ${rel}. It will be available on the next session.`,
      metadata: {
        name: input.name,
        path: rel,
        bytes: Buffer.byteLength(content, "utf8"),
        overwritten: exists,
      },
    }
  },
})
