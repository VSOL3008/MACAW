export type ScheduleKind = "cron" | "interval" | "iso" | "delay"

export type Schedule = {
  kind: ScheduleKind
  expr: string
}

export type Recurrence = "once" | "forever"

export function recurrence(kind: ScheduleKind): Recurrence {
  return kind === "iso" || kind === "delay" ? "once" : "forever"
}

export function parseDuration(input: string): number | null {
  const match = /^\s*(\d+)\s*(ms|s|m|h|d|w)?\s*$/i.exec(input)
  if (!match) return null
  const n = Number(match[1])
  const unit = (match[2] ?? "m").toLowerCase()
  const factor =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000
  return n * factor
}

export function parseInterval(input: string): number | null {
  const m = /^\s*every\s+(.+?)\s*$/i.exec(input)
  if (!m) return null
  return parseDuration(m[1])
}

export function parseISO(input: string): number | null {
  const t = Date.parse(input.trim())
  return Number.isFinite(t) ? t : null
}

type Field = number[]
type CronFields = {
  min: Field
  hour: Field
  dom: Field
  mon: Field
  dow: Field
}

const CRON_RANGES = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
]

const NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

function parseField(token: string, idx: number): Field {
  const range = CRON_RANGES[idx]
  const out = new Set<number>()
  for (const part of token.split(",")) {
    let step = 1
    let body = part
    const slash = part.indexOf("/")
    if (slash >= 0) {
      step = Number(part.slice(slash + 1))
      body = part.slice(0, slash)
      if (!Number.isInteger(step) || step <= 0) throw new Error(`bad step in cron field: ${part}`)
    }
    let lo = range.min
    let hi = range.max
    if (body !== "*") {
      const dash = body.indexOf("-")
      if (dash >= 0) {
        lo = readNum(body.slice(0, dash))
        hi = readNum(body.slice(dash + 1))
      } else {
        lo = readNum(body)
        hi = lo
      }
    }
    if (lo < range.min || hi > range.max || lo > hi) throw new Error(`bad cron field: ${part}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)

  function readNum(raw: string): number {
    const key = raw.trim().toLowerCase()
    if (key in NAMES) return NAMES[key]
    const n = Number(key)
    if (!Number.isInteger(n)) throw new Error(`bad cron value: ${raw}`)
    return n
  }
}

export function parseCron(expr: string): CronFields {
  const tokens = expr.trim().split(/\s+/)
  if (tokens.length !== 5) throw new Error(`cron expression must have 5 fields, got ${tokens.length}`)
  return {
    min: parseField(tokens[0], 0),
    hour: parseField(tokens[1], 1),
    dom: parseField(tokens[2], 2),
    mon: parseField(tokens[3], 3),
    dow: parseField(tokens[4], 4),
  }
}

function nextCron(fields: CronFields, from: number): number {
  let cur = new Date(from)
  cur.setSeconds(0, 0)
  cur = new Date(cur.getTime() + 60_000)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      fields.mon.includes(cur.getMonth() + 1) &&
      (fields.dom.includes(cur.getDate()) || fields.dow.includes(cur.getDay())) &&
      fields.hour.includes(cur.getHours()) &&
      fields.min.includes(cur.getMinutes())
    ) {
      return cur.getTime()
    }
    cur = new Date(cur.getTime() + 60_000)
  }
  throw new Error("could not find next cron occurrence within a year")
}

export const MIN_INTERVAL_MS = 60_000

export function validate(schedule: Schedule): void {
  nextAfter(schedule, Date.now())
  if (schedule.kind === "interval") {
    const ms = parseInterval(schedule.expr)
    if (ms !== null && ms < MIN_INTERVAL_MS) {
      throw new Error(
        `schedules under 1 minute are not supported (got ${ms}ms). Use 'every 1m' or longer.`,
      )
    }
  }
  if (schedule.kind === "delay") {
    const ms = parseDuration(schedule.expr)
    if (ms !== null && ms < MIN_INTERVAL_MS) {
      throw new Error(
        `delays under 1 minute are not supported (got ${ms}ms). Use '1m' or longer.`,
      )
    }
  }
}

export function nextAfter(schedule: Schedule, from: number): number | null {
  if (schedule.kind === "cron") return nextCron(parseCron(schedule.expr), from)
  if (schedule.kind === "interval") {
    const ms = parseInterval(schedule.expr)
    if (ms === null) throw new Error(`bad interval: ${schedule.expr}`)
    return from + ms
  }
  if (schedule.kind === "delay") {
    const ms = parseDuration(schedule.expr)
    if (ms === null) throw new Error(`bad delay: ${schedule.expr}`)
    return from + ms
  }
  if (schedule.kind === "iso") {
    const t = parseISO(schedule.expr)
    if (t === null) throw new Error(`bad iso timestamp: ${schedule.expr}`)
    return t > from ? t : null
  }
  throw new Error(`unknown schedule kind: ${schedule.kind}`)
}

export function describe(schedule: Schedule): string {
  if (schedule.kind === "interval") return schedule.expr
  if (schedule.kind === "delay") return `in ${schedule.expr}`
  if (schedule.kind === "iso") return `at ${schedule.expr}`
  return `cron ${schedule.expr}`
}
