import { unlink } from "fs/promises"

const PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct POINT { public int X; public int Y; }
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class MacawWin {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
}
"@
`

export function ensureWindows() {
  if (process.platform !== "win32") {
    throw new Error("Desktop automation is currently only implemented for Windows.")
  }
}

export function ps(value: string) {
  return value.replaceAll("'", "''")
}

export function prelude(script: string) {
  return `${PRELUDE}\n${script}`
}

function clean(text: string) {
  if (!text) return ""
  let out = text.replace(/#<\s*CLIXML[\s\S]*?<\/Objs>/g, "")
  out = out.replace(/<Objs[\s\S]*?<\/Objs>/g, "")
  out = out.replace(/_x000D_/g, "").replace(/_x000A_/g, "\n")
  out = out.replace(/\n\s*At line:\d+ char:\d+[\s\S]*$/m, "")
  return out.trim()
}

export async function run(script: string, signal?: AbortSignal) {
  ensureWindows()
  const child = Bun.spawn(
    [
      "powershell",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  )
  const abort = () => child.kill()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) {
      const msg = clean(err) || clean(out) || "PowerShell command failed"
      throw new Error(msg)
    }
    return out.trim()
  } finally {
    signal?.removeEventListener("abort", abort)
  }
}

export async function runFile(script: string, signal?: AbortSignal, notify?: (chunk: string) => void) {
  ensureWindows()
  const file = `${process.env.TEMP ?? process.env.TMP ?? "."}\\macaw-ps-${crypto.randomUUID()}.ps1`
  await Bun.write(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, "utf8")]))
  const child = Bun.spawn(
    [
      "powershell",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      file,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  )
  const abort = () => child.kill()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const stdout = async () => {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let out = ""
      while (true) {
        const part = await reader.read()
        if (part.done) break
        const chunk = decoder.decode(part.value, { stream: true })
        out += chunk
        notify?.(chunk)
      }
      const chunk = decoder.decode()
      out += chunk
      notify?.(chunk)
      return out
    }
    const [out, err, code] = await Promise.all([
      stdout(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) {
      const msg = clean(err) || clean(out) || "PowerShell command failed"
      throw new Error(msg)
    }
    return out.trim()
  } finally {
    signal?.removeEventListener("abort", abort)
    await unlink(file).catch(() => undefined)
  }
}

export async function json<T>(script: string, signal?: AbortSignal) {
  const out = await run(script, signal)
  if (!out) return undefined as T
  return JSON.parse(out) as T
}

export async function png(script: string, signal?: AbortSignal) {
  const file = await run(script, signal)
  const buf = Buffer.from(await Bun.file(file).arrayBuffer())
  await unlink(file).catch(() => undefined)
  return `data:image/png;base64,${buf.toString("base64")}`
}
