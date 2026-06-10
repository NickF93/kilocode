import { describe, expect, it } from "bun:test"
import { parseMemoryCommand } from "../../webview-ui/src/utils/memory-command"

describe("parseMemoryCommand", () => {
  it("ignores non-memory prompts", () => {
    expect(parseMemoryCommand("please remember this in normal chat")).toBeUndefined()
  })

  it("parses inspect commands", () => {
    expect(parseMemoryCommand("/memory")).toEqual({ kind: "inspect" })
    expect(parseMemoryCommand("/memory project show")).toEqual({ kind: "inspect" })
  })

  it("parses memory operations", () => {
    expect(parseMemoryCommand("/memory remember tests run from packages/opencode")).toEqual({
      kind: "operation",
      operation: "remember",
      text: "tests run from packages/opencode",
    })
    expect(parseMemoryCommand("/memory forget stale test command")).toEqual({
      kind: "operation",
      operation: "forget",
      query: "stale test command",
    })
    expect(parseMemoryCommand("/memory correct tests run from packages/opencode")).toEqual({
      kind: "operation",
      operation: "correct",
      text: "tests run from packages/opencode",
    })
    expect(parseMemoryCommand("/memory purge")).toEqual({
      kind: "operation",
      operation: "purge",
    })
  })

  it("rejects unsupported commands", () => {
    expect(parseMemoryCommand("/memory auto-consolidate off")).toEqual({
      kind: "usage",
      reason: expect.stringContaining("Unknown memory action"),
    })
    expect(parseMemoryCommand("/memory use-personal on")).toEqual({
      kind: "usage",
      reason: expect.stringContaining("Personal memory is not supported"),
    })
    expect(parseMemoryCommand("/memory personal show")).toEqual({
      kind: "usage",
      reason: expect.stringContaining("Personal memory is not supported"),
    })
  })
})
