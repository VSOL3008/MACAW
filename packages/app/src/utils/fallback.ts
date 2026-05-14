export const FALLBACK_TIMEOUT_MS = 90_000

export type Fallback = {
  touch(): void
  stop(): void
}

export type FallbackOptions = {
  timeoutMs?: number
  onStall: () => void
}

export function createFallback(opts: FallbackOptions): Fallback {
  const ms = opts.timeoutMs ?? FALLBACK_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const arm = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (stopped) return
      opts.onStall()
    }, ms)
  }

  arm()

  return {
    touch() {
      if (stopped) return
      arm()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

const registry = new Map<string, Fallback>()

export const FallbackRegistry = {
  register(sessionID: string, opts: FallbackOptions) {
    registry.get(sessionID)?.stop()
    const fb = createFallback(opts)
    registry.set(sessionID, fb)
    return fb
  },
  touch(sessionID: string) {
    registry.get(sessionID)?.touch()
  },
  clear(sessionID: string) {
    const fb = registry.get(sessionID)
    if (!fb) return
    fb.stop()
    registry.delete(sessionID)
  },
  has(sessionID: string) {
    return registry.has(sessionID)
  },
}
