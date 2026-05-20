#!/usr/bin/env bun
import { $ } from "bun"
import * as path from "node:path"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const target = "x86_64-pc-windows-msvc"
const base = Bun.argv.includes("--baseline")
const root = path.resolve(import.meta.dir, "../../..")
const cli = path.join(root, "packages/opencode")
const sidecar = getCurrentSidecar(target)
const name = base ? sidecar.ocBinary : "macaw-windows-x64"

if (process.platform !== "win32") {
  throw new Error("Windows installer builds must run on Windows")
}

console.log("Building Windows CLI sidecar")
if (base) {
  await $`bun run script/build.ts --single --baseline --skip-install`.cwd(cli)
} else {
  await $`bun run script/build.ts --single --skip-install`.cwd(cli)
}

console.log("Copying CLI sidecar for Tauri")
await copyBinaryToSidecarFolder(windowsify(path.join(cli, "dist", name, "bin", "macaw")), target)

console.log("Building Windows setup installer")
console.log("Tauri downloads NSIS from GitHub on the first setup build unless it is already cached")
await $`bun run tauri build --target ${target} --bundles nsis --config ./src-tauri/tauri.prod.conf.json`

console.log(
  `Windows setup installer written to ${path.join(
    "packages/desktop/src-tauri/target",
    target,
    "release/bundle/nsis",
  )}`,
)
