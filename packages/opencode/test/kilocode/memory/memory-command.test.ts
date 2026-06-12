import { describe, expect, test } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2"
import { parseMemoryInput, runMemoryCommand, type MemoryCommand } from "../../../src/kilocode/cli/cmd/tui/memory-command"

type MemoryOperation = "enable" | "disable" | "rebuild" | "remember" | "correct" | "forget" | "purge"
type Case = {
  name: string
  input: string
  result: "none" | "inspect" | "operation" | "usage"
  operation?: MemoryOperation
  text?: string
  query?: string
  reason?: string
}

const cases = (await Bun.file(new URL("./memory-command-cases.json", import.meta.url)).json()) as Case[]

function expected(item: Case): MemoryCommand | undefined {
  if (item.result === "none") return
  if (item.result === "inspect") return { kind: "inspect" }
  if (item.result === "usage") return { kind: "usage", reason: item.reason ?? "" }
  if (!item.operation) throw new Error(`Missing operation for fixture: ${item.name}`)
  if (item.operation === "remember" || item.operation === "correct") {
    if (!item.text) throw new Error(`Missing text for fixture: ${item.name}`)
    return { kind: "operation", operation: item.operation, text: item.text }
  }
  if (item.operation === "forget") {
    if (!item.query) throw new Error(`Missing query for fixture: ${item.name}`)
    return { kind: "operation", operation: item.operation, query: item.query }
  }
  return { kind: "operation", operation: item.operation }
}

describe("memory TUI command parser", () => {
  test("matches shared command fixtures", () => {
    for (const item of cases) {
      const parsed = parseMemoryInput(item.input)
      if (item.result === "usage") {
        expect(parsed?.kind, item.name).toBe("usage")
        expect(parsed && "reason" in parsed ? parsed.reason : "", item.name).toContain(item.reason ?? "")
        continue
      }
      expect(parsed, item.name).toEqual(expected(item))
    }
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
