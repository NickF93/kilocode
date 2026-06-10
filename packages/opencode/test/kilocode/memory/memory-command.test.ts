import { describe, expect, test } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2"
import { parseMemoryInput, runMemoryCommand } from "../../../src/kilocode/cli/cmd/tui/memory-command"

describe("memory TUI command parser", () => {
  test("parses management commands", () => {
    expect(parseMemoryInput("/memory")).toEqual({ action: "show" })
    expect(parseMemoryInput("/mem show")).toEqual({ action: "show" })
    expect(parseMemoryInput("/memory enable")).toEqual({ action: "enable" })
    expect(parseMemoryInput("/memory disable")).toEqual({ action: "disable" })
    expect(parseMemoryInput("/memory rebuild")).toEqual({ action: "rebuild" })
    expect(parseMemoryInput("/memory status")).toEqual({ action: "show" })
    expect(parseMemoryInput("/memory inspect")).toEqual({ action: "show" })
    expect(parseMemoryInput("/memory project show")).toEqual({ action: "show", scope: "project" })
    expect(parseMemoryInput("/memory purge")).toEqual({ action: "purge" })
  })

  test("preserves explicit memory text", () => {
    expect(parseMemoryInput("/memory remember use bun test from packages/opencode")).toEqual({
      action: "remember",
      text: "use bun test from packages/opencode",
    })
    expect(parseMemoryInput("/memory correct old fact is wrong\nnew fact is stable")).toEqual({
      action: "correct",
      text: "old fact is wrong\nnew fact is stable",
    })
    expect(parseMemoryInput("/memory forget stale route")).toEqual({ action: "forget", text: "stale route" })
  })

  test("rejects incomplete and non-memory input", () => {
    expect(parseMemoryInput("remember this")).toBeUndefined()
    expect(parseMemoryInput("/memory remember")).toEqual({ action: "usage", reason: "Missing text." })
    expect(parseMemoryInput("/memory auto-consolidate off")).toEqual({
      action: "usage",
      reason: "Unknown memory action: auto-consolidate",
    })
    expect(parseMemoryInput("/memory personal show")).toEqual({
      action: "usage",
      reason: "Personal memory is not supported in v0.",
    })
    expect(parseMemoryInput("/memory use-personal on")).toEqual({
      action: "usage",
      reason: "Personal memory is not supported in v0.",
    })
    expect(parseMemoryInput("/memory catalog")).toEqual({
      action: "usage",
      reason: "Unknown memory action: catalog",
    })
    expect(parseMemoryInput("/memory wat")).toEqual({ action: "usage", reason: "Unknown memory action: wat" })
  })

  test("manual mutation toasts match server event wording", async () => {
    const shown: string[] = []
    const result = {
      data: {
        operationCount: 1,
        removed: 1,
        index: { tokens: 1234 },
      },
    }
    const client = {
      memory: {
        remember: async () => result,
        correct: async () => result,
        forget: async () => result,
      },
    } as unknown as KiloClient
    const base = {
      client,
      toast: {
        show(input: { message: string }) {
          shown.push(input.message)
        },
      },
      show() {},
      usage() {},
    }

    await runMemoryCommand({ ...base, text: "/memory remember tests run from packages/opencode" })
    await runMemoryCommand({ ...base, text: "/memory correct old test command is wrong" })
    await runMemoryCommand({ ...base, text: "/memory forget old test command" })

    expect(shown).toEqual(["Memory saved · 1 op", "Correction saved · 1 op", "Memory updated · 1 removed"])
    expect(shown.join("\n")).not.toContain("1,234")
    expect(shown.join("\n")).not.toContain("memory tokens")
  })
})
