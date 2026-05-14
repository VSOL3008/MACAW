export type Subgoal = {
  text: string
  cue: string
  done: boolean
}

export type Step = {
  step: number
  action: string
  sid?: string
  label?: string
  verified: boolean
  state: string
}

export type Board = {
  goal: string
  subgoals: Subgoal[]
  active: number
  trajectory: Step[]
  stale: Set<string>
  stuck: number
  lastSid?: string
  lastShot?: string
}

const store = new Map<string, Board>()

export function create(sessionId: string, goal: string, subgoals: Subgoal[]) {
  const board: Board = {
    goal,
    subgoals: subgoals.map((s) => ({ ...s, done: false })),
    active: 0,
    trajectory: [],
    stale: new Set(),
    stuck: 0,
  }
  store.set(sessionId, board)
  return board
}

export function get(sessionId: string) {
  return store.get(sessionId)
}

export function reset(sessionId: string) {
  store.delete(sessionId)
}

export function record(board: Board, step: Omit<Step, "step">) {
  const entry: Step = { ...step, step: board.trajectory.length + 1 }
  board.trajectory.push(entry)
  if (step.sid) {
    const last = board.lastSid
    if (last === step.sid && !step.verified) board.stuck += 1
    else if (step.verified) board.stuck = 0
    board.lastSid = step.sid
  }
  return entry
}

export function markStale(board: Board, sid: string) {
  board.stale.add(sid)
}

export function advance(board: Board) {
  const current = board.subgoals[board.active]
  if (!current) return false
  current.done = true
  board.active += 1
  board.stuck = 0
  board.lastSid = undefined
  return board.active < board.subgoals.length
}

export function current(board: Board) {
  return board.subgoals[board.active]
}

export function done(board: Board) {
  return board.subgoals.every((s) => s.done) || board.active >= board.subgoals.length
}

export function tail(board: Board, n = 5) {
  return board.trajectory.slice(-n)
}
