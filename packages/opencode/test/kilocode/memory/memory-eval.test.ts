import { describe, expect, test } from "bun:test"
import path from "path"
import { Filesystem } from "../../../src/util/filesystem"
import { KiloMemory, MemoryEval, MemoryFiles, MemoryPaths } from "../../../src/kilocode/memory"
import { tmpdir } from "../../fixture/fixture"

async function env<T>(vars: Record<string, string>, fn: () => Promise<T>) {
  const prior = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(vars)) process.env[key] = value
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      if (value !== undefined) process.env[key] = value
    }
  }
}

describe("memory eval", () => {
  test("default eval mode matches slim v0 behavior", () => {
    expect(MemoryEval.mode({ KILO_MEMORY_EVAL: "1" })).toBe("inject-digest")
  })

  test("off mode disables injection without changing normal memory state", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [{ action: "add", key: "repo_fact", text: "Run memory tests from packages/opencode." }],
    })

    await env({ KILO_MEMORY_EVAL: "1", KILO_MEMORY_EVAL_MODE: "off" }, async () => {
      const context = await KiloMemory.context({ root })
      const recall = await KiloMemory.recall({ root, query: "what command runs memory tests?" })
      const state = await MemoryFiles.readState(root)

      expect(context.blocks).toHaveLength(0)
      expect(recall).toBeUndefined()
      expect(context.meta.estimatedTokens).toBe(0)
      expect(state.stats.lastInjectedTokens).toBe(0)
    })
  })

  test("off mode skips context preparation and legacy migration", async () => {
    await using tmp = await tmpdir()
    const ctx = { directory: tmp.path, worktree: tmp.path }
    const old = MemoryPaths.legacyRoot({ ctx })
    const root = MemoryPaths.root({ ctx })
    await KiloMemory.enable({ root: old })

    await env({ KILO_MEMORY_EVAL: "1", KILO_MEMORY_EVAL_MODE: "off" }, async () => {
      const context = await KiloMemory.context({ ctx })
      const recall = await KiloMemory.recall({ ctx, query: "what command runs memory tests?" })

      expect(context.blocks).toHaveLength(0)
      expect(context.root).toBe(root)
      expect(recall).toBeUndefined()
      expect(await Bun.file(MemoryPaths.files(old).state).exists()).toBe(true)
      expect(await Bun.file(MemoryPaths.files(root).state).exists()).toBe(false)
    })
  })

  test("inject-digest mode allows injection and digest capture", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [{ action: "add", key: "repo_fact", text: "Run memory tests from packages/opencode." }],
    })

    await env({ KILO_MEMORY_EVAL: "1", KILO_MEMORY_EVAL_MODE: "inject-digest" }, async () => {
      const context = await KiloMemory.context({ root })

      expect(context.blocks).toHaveLength(1)
      expect(context.blocks[0]?.text).toContain("repo_fact")
      expect(MemoryEval.shouldCapture()).toBe(true)
    })
  })

  test("record writes eval jsonl only when explicitly enabled", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const skipped = await MemoryEval.record(root, {
      sessionID: "ses",
      directory: tmp.path,
      startedAt: 1,
      completedAt: 2,
      result: "success",
    })

    expect(skipped.skipped).toBe(true)

    await env({ KILO_MEMORY_EVAL: "1", KILO_MEMORY_EVAL_RUN_ID: "run_1" }, async () => {
      const logged = await MemoryEval.record(root, {
        sessionID: "ses",
        directory: tmp.path,
        startedAt: 1,
        completedAt: 2,
        result: "success",
        memoryInjectedTokens: 12,
      })
      const text = await Filesystem.readText(path.join(root, "eval", "runs", "run_1.jsonl"))
      const item = JSON.parse(text.trim()) as MemoryEval.Turn

      expect(logged.skipped).toBe(false)
      expect(item.runID).toBe("run_1")
      expect(item.memoryInjectedTokens).toBe(12)
    })
  })

  test("deterministic runner compares memory modes and writes a report", async () => {
    await using tmp = await tmpdir()
    const result = await MemoryEval.run({ dir: tmp.path, runID: "deterministic" })
    const log = await Filesystem.readText(path.join(result.root, "eval", "runs", "deterministic.jsonl"))
    const report = await Filesystem.readText(result.report)
    const turns = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as MemoryEval.Turn)

    expect(turns).toHaveLength(20)
    expect(turns.some((turn) => turn.mode === "off" && turn.memoryInjectedTokens === 0)).toBe(true)
    expect(turns.some((turn) => turn.mode === "inject-digest" && turn.memoryInjectedTokens > 0)).toBe(true)
    expect(turns.some((turn) => turn.mode === "typed-auto-low-budget" && turn.memoryTruncated)).toBe(true)
    expect(report).toContain("Memory Eval Report")
    expect(report).toContain("| repo-command-recall | inject-digest | success |")
    expect(report).toContain("| recent-session-lookup | inject-digest | success |")
    expect(report).toContain("| repo-exploration-recall | inject-digest | success |")
    expect(result.root).toContain(path.join(".kilo", "eval", "home", "deterministic", ".kilo", "memory"))
    expect(await Filesystem.exists(path.join(tmp.path, ".kilo", "memory"))).toBe(false)
  })

})
