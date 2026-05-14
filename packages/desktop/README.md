# MACAW Desktop

Native MACAW desktop app, built with Tauri v2.

## Prerequisites

Building the desktop app requires additional Tauri dependencies (Rust toolchain, platform-specific libraries). See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for setup instructions.

## Development

From the repo root:

```bash
bun install
bun run --cwd packages/desktop tauri dev
```

## Build

```bash
bun run --cwd packages/desktop tauri build
```

## Windows setup installer

From Windows, install the Tauri prerequisites, then run:

```bash
bun install
rustup target add x86_64-pc-windows-msvc
bun run build:windows
```

This builds a Windows x64 NSIS setup `.exe` with the bundled MACAW CLI sidecar. The installer is written to:

```text
packages/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
```

## Troubleshooting

### Rust compiler not found

If you see errors about Rust not being found, install it via [rustup](https://rustup.rs/):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```
