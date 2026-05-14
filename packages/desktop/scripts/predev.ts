import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const RUST_TARGET = Bun.env.TAURI_ENV_TARGET_TRIPLE

const sidecarConfig = getCurrentSidecar(RUST_TARGET)
const binary = sidecarConfig.ocBinary.replace("-baseline", "")

const binaryPath = windowsify(`../opencode/dist/${binary}/bin/macaw`)

process.env.OPENCODE_DISABLE_MODELS_FETCH = "1"

await $`cd ../opencode && bun run build --single --skip-install`

await copyBinaryToSidecarFolder(binaryPath, RUST_TARGET)
