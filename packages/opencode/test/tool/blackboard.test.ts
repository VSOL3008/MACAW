import { afterEach, describe, expect, test } from "bun:test"
import {
  advance,
  create,
  current,
  done,
  get,
  markStale,
  record,
  reset,
  tail,
} from "../../src/tool/blackboard"

afterEach(() => {
  reset("s1")
})

describe("blackboard.create", () => {
  test("stores a session-scoped board", () => {
    const board = create("s1", "Open settings", [
      { text: "open menu", cue: "menu visible", done: false },
      { text: "click settings", cue: "settings open", done: false },
    ])
    expect(get("s1")).toBe(board)
    expect(current(board)?.text).toBe("open menu")
  })
})

describe("blackboard.record", () => {
  test("increments stuck on repeated same-sid unverified steps", () => {
    const board = create("s1", "goal", [{ text: "a", cue: "", done: false }])
    record(board, { action: "click", sid: "abc", verified: false, state: "" })
    record(board, { action: "click", sid: "abc", verified: false, state: "" })
    expect(board.stuck).toBe(1)
    expect(board.trajectory.length).toBe(2)
    expect(board.trajectory[1].step).toBe(2)
  })

  test("resets stuck on verified step", () => {
    const board = create("s1", "goal", [{ text: "a", cue: "", done: false }])
    record(board, { action: "click", sid: "abc", verified: false, state: "" })
    record(board, { action: "click", sid: "abc", verified: false, state: "" })
    expect(board.stuck).toBe(1)
    record(board, { action: "click", sid: "abc", verified: true, state: "ok" })
    expect(board.stuck).toBe(0)
  })
})

describe("blackboard.markStale", () => {
  test("stale sids accumulate in a set", () => {
    const board = create("s1", "goal", [{ text: "a", cue: "", done: false }])
    markStale(board, "abc")
    markStale(board, "def")
    expect(board.stale.size).toBe(2)
    expect(board.stale.has("abc")).toBe(true)
  })
})

describe("blackboard.advance", () => {
  test("marks current subgoal done and moves pointer", () => {
    const board = create("s1", "goal", [
      { text: "a", cue: "", done: false },
      { text: "b", cue: "", done: false },
    ])
    const more = advance(board)
    expect(more).toBe(true)
    expect(board.subgoals[0].done).toBe(true)
    expect(current(board)?.text).toBe("b")
    advance(board)
    expect(done(board)).toBe(true)
  })

  test("clears stuck and lastSid on advance", () => {
    const board = create("s1", "goal", [
      { text: "a", cue: "", done: false },
      { text: "b", cue: "", done: false },
    ])
    record(board, { action: "click", sid: "abc", verified: false, state: "" })
    record(board, { action: "click", sid: "abc", verified: false, state: "" })
    expect(board.stuck).toBe(1)
    advance(board)
    expect(board.stuck).toBe(0)
    expect(board.lastSid).toBeUndefined()
  })
})

describe("blackboard.tail", () => {
  test("returns the last n steps", () => {
    const board = create("s1", "goal", [{ text: "a", cue: "", done: false }])
    for (let i = 0; i < 8; i++) {
      record(board, { action: "click", sid: `s${i}`, verified: true, state: `${i}` })
    }
    const end = tail(board, 3)
    expect(end.length).toBe(3)
    expect(end[2].state).toBe("7")
  })
})
