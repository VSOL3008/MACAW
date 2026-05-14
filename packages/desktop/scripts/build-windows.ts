#!/usr/bin/env bun
import { $ } from "bun"
import * as path from "node:path"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const target = "x86_64-pc-windows-msvc"
const root = path.resolve(import.meta.dir, "../../..")
const cli = path.join(root, "packages/opencode")
const sidecar = getCurrentSidecar(target)

if (process.platform !== "win32") {
  throw new Error("Windows installer builds must run on Windows")
}

console.log("Building Windows CLI sidecar")
await $`bun run script/build.ts --single --baseline`.cwd(cli)

console.log("Copying CLI sidecar for Tauri")
await copyBinaryToSidecarFolder(windowsify(path.join(cli, "dist", sidecar.ocBinary, "bin", "macaw")), target)

console.log("Building Windows setup installer")
await $`bun run tauri build --target ${target} --bundles nsis --config ./src-tauri/tauri.prod.conf.json`

console.log(
  `Windows setup installer written to ${path.join(
    "packages/desktop/src-tauri/target",
    target,
    "release/bundle/nsis",
  )}`,
)
