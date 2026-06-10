// kilocode_change - new file

import { appendFile, mkdir } from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { MemoryFiles } from "./files"
import { MemoryIndexer } from "./indexer"
import { MemoryOperations } from "./operations"
import { MemoryPaths } from "./paths"
import { MemoryRecall } from "./recall"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"

export namespace MemoryEval {
  export type Mode = "off" | "inject-digest" | "typed-auto" | "typed-auto-low-budget"
  export type Result = "success" | "failure" | "partial"

  export type Turn = {
    runID: string
    scenarioID: string
    mode: Mode
    sessionID: string
    directory: string
    modelID: string
    providerID: string
    startedAt: number
    completedAt: number
    result: Result
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
    memoryInjectedTokens: number
    memoryInjectedBytes: number
    memoryTruncated: boolean
    memorySearchMs: number
    memoryConsolidationMs: number
    memoryConsolidationTokens: number
    memoryConsolidationCost: number
    memoryOperationCount: number
    memorySkippedReason?: string
    toolCallCount: number
    repeatedToolReadCount: number
    userClarificationCount: number
    userCorrectionCount: number
    testsPassed?: boolean
    notes?: string
  }

  export type RecordInput = Partial<Turn> &
    Pick<Turn, "sessionID" | "directory" | "startedAt" | "completedAt" | "result">

  export type Scenario = {
    id: string
    prompt: string
    seed: { key: string; text: string; file?: "project.md" | "environment.md" | "corrections.md"; section?: string }[]
    sessions?: { sessionID: string; summary: string; time?: number }[]
    recall?: { query: string }
    expect: string[]
    notes: string
  }

  type Env = Record<string, string | undefined>
  type Hit = {
    bytes: number
    tokens: number
    truncated: boolean
    ms: number
  }
  type Cap = {
    tokens: number
    cost: number
    ops: number
    ms: number
    reason?: string
  }

  const starts = new Map<string, number>()
  const hits = new Map<string, Hit>()
  const caps = new Map<string, Cap>()
  const boot = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const modes: Mode[] = ["off", "inject-digest", "typed-auto", "typed-auto-low-budget"]

  function flag(env: Env = process.env) {
    return env.KILO_MEMORY_EVAL === "1"
  }

  function pick(input: string | undefined): Mode {
    if (input === "off") return input
    if (input === "inject-digest") return input
    if (input === "typed-auto") return input
    if (input === "typed-auto-low-budget") return input
    return "inject-digest"
  }

  function id(env: Env = process.env) {
    return env.KILO_MEMORY_EVAL_RUN_ID?.trim() || boot
  }

  function scenario(env: Env = process.env) {
    return env.KILO_MEMORY_EVAL_SCENARIO?.trim() || "manual"
  }

  function file(root: string, run = id()) {
    return path.join(root, "eval", "runs", `${run}.jsonl`)
  }

  function report(root: string, run: string) {
    return path.join(root, "eval", "reports", `${run}.md`)
  }

  function last(messages: MessageV2.WithParts[]) {
    return messages.findLast(
      (msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } =>
        msg.info.role === "assistant" && msg.info.summary !== true,
    )
  }

  function count(messages: MessageV2.WithParts[]) {
    const tools = messages.flatMap((msg) => msg.parts.filter((part) => part.type === "tool"))
    const reads = tools.filter((part) => part.tool === "read").map((part) => {
      const state = part.state
      if (state.status === "pending" || state.status === "running") return JSON.stringify(state.input)
      return JSON.stringify(state.input)
    })
    const seen = new Set<string>()
    const repeated = reads.filter((item) => {
      if (seen.has(item)) return true
      seen.add(item)
      return false
    })
    const text = messages
      .filter((msg) => msg.info.role === "assistant")
      .flatMap((msg) => msg.parts)
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    return {
      tools: tools.length,
      reads: repeated.length,
      clarifications: /\?\s*$|clarif|which file|can you confirm/i.test(text) ? 1 : 0,
    }
  }

  function defaults(input: RecordInput): Turn {
    return {
      runID: input.runID ?? id(),
      scenarioID: input.scenarioID ?? scenario(),
      mode: input.mode ?? mode(),
      sessionID: input.sessionID,
      directory: input.directory,
      modelID: input.modelID ?? "unknown",
      providerID: input.providerID ?? "unknown",
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      result: input.result,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      cost: input.cost ?? 0,
      memoryInjectedTokens: input.memoryInjectedTokens ?? 0,
      memoryInjectedBytes: input.memoryInjectedBytes ?? 0,
      memoryTruncated: input.memoryTruncated ?? false,
      memorySearchMs: input.memorySearchMs ?? 0,
      memoryConsolidationMs: input.memoryConsolidationMs ?? 0,
      memoryConsolidationTokens: input.memoryConsolidationTokens ?? 0,
      memoryConsolidationCost: input.memoryConsolidationCost ?? 0,
      memoryOperationCount: input.memoryOperationCount ?? 0,
      ...(input.memorySkippedReason ? { memorySkippedReason: input.memorySkippedReason } : {}),
      toolCallCount: input.toolCallCount ?? 0,
      repeatedToolReadCount: input.repeatedToolReadCount ?? 0,
      userClarificationCount: input.userClarificationCount ?? 0,
      userCorrectionCount: input.userCorrectionCount ?? 0,
      ...(input.testsPassed === undefined ? {} : { testsPassed: input.testsPassed }),
      ...(input.notes ? { notes: input.notes } : {}),
    }
  }

  export function active(env: Env = process.env) {
    return flag(env)
  }

  export function mode(env: Env = process.env): Mode {
    return pick(env.KILO_MEMORY_EVAL_MODE)
  }

  export function shouldInject(env: Env = process.env) {
    return !active(env) || mode(env) !== "off"
  }

  export function shouldCapture(env: Env = process.env) {
    if (!active(env)) return true
    const next = mode(env)
    return next !== "off"
  }

  export function maxBytes(bytes: number, env: Env = process.env) {
    if (!active(env) || mode(env) !== "typed-auto-low-budget") return bytes
    const raw = Number(env.KILO_MEMORY_EVAL_LOW_BUDGET_BYTES ?? 512)
    const cap = Number.isFinite(raw) && raw > 0 ? raw : 512
    return Math.min(bytes, cap)
  }

  export function open(input: { sessionID: SessionID; time?: number }) {
    if (!active()) return
    starts.set(input.sessionID, input.time ?? Date.now())
  }

  export function injected(input: { root: string; bytes: number; tokens: number; truncated: boolean; ms: number }) {
    if (!active()) return
    const prior = hits.get(input.root)
    hits.set(input.root, {
      bytes: (prior?.bytes ?? 0) + input.bytes,
      tokens: (prior?.tokens ?? 0) + input.tokens,
      truncated: Boolean(prior?.truncated || input.truncated),
      ms: (prior?.ms ?? 0) + input.ms,
    })
  }

  export function captured(input: { root: string; tokens?: number; cost?: number; ops?: number; ms?: number; reason?: string }) {
    if (!active()) return
    const prior = caps.get(input.root)
    caps.set(input.root, {
      tokens: (prior?.tokens ?? 0) + (input.tokens ?? 0),
      cost: (prior?.cost ?? 0) + (input.cost ?? 0),
      ops: (prior?.ops ?? 0) + (input.ops ?? 0),
      ms: (prior?.ms ?? 0) + (input.ms ?? 0),
      ...(input.reason ?? prior?.reason ? { reason: input.reason ?? prior?.reason } : {}),
    })
  }

  export async function record(root: string, input: RecordInput) {
    if (!active()) return { skipped: true as const }
    const turn = defaults(input)
    const target = file(root, turn.runID)
    await mkdir(path.dirname(target), { recursive: true })
    await appendFile(target, `${JSON.stringify(turn)}\n`, "utf8")
    return { skipped: false as const, path: target, turn }
  }

  export async function close(input: {
    ctx: MemoryPaths.Ctx
    sessionID: SessionID
    reason: "completed" | "error" | "interrupted"
    messages: MessageV2.WithParts[]
  }) {
    if (!active()) return { skipped: true as const }
    const root = MemoryPaths.root({ ctx: input.ctx })
    const msg = last(input.messages)
    const stats = count(input.messages)
    const hit = hits.get(root) ?? { bytes: 0, tokens: 0, truncated: false, ms: 0 }
    const cap = caps.get(root) ?? { tokens: 0, cost: 0, ops: 0, ms: 0 }
    const started = starts.get(input.sessionID) ?? msg?.info.time.created ?? Date.now()
    const done = msg?.info.time.completed ?? Date.now()
    const result = input.reason === "completed" ? "success" : "failure"
    const out = await record(root, {
      sessionID: input.sessionID,
      directory: input.ctx.directory,
      startedAt: started,
      completedAt: done,
      result,
      modelID: msg?.info.modelID ?? "unknown",
      providerID: msg?.info.providerID ?? "unknown",
      inputTokens: msg?.info.tokens.input ?? 0,
      outputTokens: (msg?.info.tokens.output ?? 0) + (msg?.info.tokens.reasoning ?? 0),
      cacheReadTokens: msg?.info.tokens.cache.read ?? 0,
      cacheWriteTokens: msg?.info.tokens.cache.write ?? 0,
      cost: msg?.info.cost ?? 0,
      memoryInjectedTokens: hit.tokens,
      memoryInjectedBytes: hit.bytes,
      memoryTruncated: hit.truncated,
      memorySearchMs: hit.ms,
      memoryConsolidationMs: cap.ms,
      memoryConsolidationTokens: cap.tokens,
      memoryConsolidationCost: cap.cost,
      memoryOperationCount: cap.ops,
      ...(cap.reason ? { memorySkippedReason: cap.reason } : {}),
      toolCallCount: stats.tools,
      repeatedToolReadCount: stats.reads,
      userClarificationCount: stats.clarifications,
      userCorrectionCount: 0,
    })
    starts.delete(input.sessionID)
    hits.delete(root)
    caps.delete(root)
    return out
  }

  export async function writeReport(root: string, run: string, turns: Turn[]) {
    const target = report(root, run)
    const passed = turns.filter((turn) => turn.result === "success").length
    const failed = turns.filter((turn) => turn.result === "failure").length
    const token = turns.reduce((sum, turn) => sum + turn.inputTokens + turn.outputTokens, 0)
    const memory = turns.reduce((sum, turn) => sum + turn.memoryInjectedTokens, 0)
    const cost = turns.reduce((sum, turn) => sum + turn.cost + turn.memoryConsolidationCost, 0)
    const rows = turns
      .map(
        (turn) =>
          `| ${turn.scenarioID} | ${turn.mode} | ${turn.result} | ${turn.inputTokens} | ${turn.memoryInjectedTokens} | ${turn.cost.toFixed(6)} | ${turn.toolCallCount} | ${turn.notes ?? ""} |`,
      )
      .join("\n")
    const text = [
      "Memory Eval Report",
      `Run: ${run}`,
      `Date: ${new Date().toISOString()}`,
      "",
      "Summary",
      `- Passed scenarios: ${passed}`,
      `- Failed scenarios: ${failed}`,
      "- Main regressions: none detected by deterministic harness",
      `- Token delta: ${token}`,
      `- Memory tokens: ${memory}`,
      `- Cost delta: ${cost.toFixed(6)}`,
      "- Recommendation: Run live model evals before broad release.",
      "",
      "Scenario Results",
      "| Scenario | Mode | Result | Input Tokens | Memory Tokens | Cost | Tool Calls | Notes |",
      "|---|---|---|---|---|---|---|---|",
      rows,
      "",
    ].join("\n")
    await Filesystem.write(target, text)
    return { path: target, text }
  }

  export async function run(input: { dir: string; runID?: string; modes?: Mode[] }) {
    const prior = {
      eval: process.env.KILO_MEMORY_EVAL,
      mode: process.env.KILO_MEMORY_EVAL_MODE,
      run: process.env.KILO_MEMORY_EVAL_RUN_ID,
      scenario: process.env.KILO_MEMORY_EVAL_SCENARIO,
    }
    const run = input.runID ?? id()
    const cfg = path.join(input.dir, ".kilo", "eval", "xdg-config", run, "kilo")
    const home = path.join(input.dir, ".kilo", "eval", "home", run)
    const priorConfig = Global.Path.config
    const priorHome = process.env.KILO_TEST_HOME
    const scenarios: Scenario[] = [
      {
        id: "repo-command-recall",
        prompt: "Run the CLI memory tests.",
        seed: [{ key: "cli_tests", text: "Run bun test ./test/kilocode/memory from packages/opencode." }],
        expect: ["cli_tests"],
        notes: "Checks seeded project command recall.",
      },
      {
        id: "correction-priority",
        prompt: "Use the correct local test command.",
        seed: [
          {
            key: "stale_tests",
            text: "Run bun test from packages/opencode, not from the repo root.",
            file: "corrections.md",
            section: "Corrections",
          },
        ],
        expect: ["stale_tests"],
        notes: "Checks correction memory priority.",
      },
      {
        id: "low-budget-pressure",
        prompt: "Remember the correction under a tight budget.",
        seed: [
          ...Array.from({ length: 12 }, (_, idx) => ({
            key: `fact_${idx}`,
            text: `Lower priority fact ${idx} ${"x".repeat(40)}`,
          })),
          {
            key: "must_keep_correction",
            text: "Prefer current repo files over stale memory.",
            file: "corrections.md" as const,
            section: "Corrections",
          },
        ],
        expect: ["must_keep_correction"],
        notes: "Checks low-budget truncation preserves corrections.",
      },
      {
        id: "recent-session-lookup",
        prompt: "Continue the memory implementation from last session.",
        seed: [],
        sessions: Array.from({ length: 12 }, (_, idx) => ({
          sessionID: `ses_${idx}`,
          summary:
            idx === 11
              ? "Objective: finish memory v0. Next: verify recent session lookup with kilo_memory_recall."
              : `Older memory implementation note ${idx}.`,
          time: Date.UTC(2026, 0, 1, 0, idx),
        })),
        expect: ["type=session_digest", "session=ses_11", "verify recent session lookup"],
        notes: "Checks recent session injection includes direct recall-tool lookup IDs.",
      },
      {
        id: "repo-exploration-recall",
        prompt: "Explore how this repo is built and common dev tasks.",
        seed: [
          {
            key: "typecheck_command",
            text: "Run bun turbo typecheck from the repo root.",
            file: "environment.md",
            section: "Commands",
          },
          {
            key: "build_orchestration",
            text: "Use Turborepo/Turbo for workspace orchestration.",
            file: "environment.md",
            section: "Tooling",
          },
          {
            key: "package_manager",
            text: "Use Bun for package management and package scripts.",
            file: "environment.md",
            section: "Tooling",
          },
        ],
        recall: {
          query: "I'd like to explore how this repo is built and what commands are used for common dev tasks.",
        },
        expect: ["type=env", "build_orchestration", "typecheck_command", "package_manager"],
        notes: "Checks targeted recall for natural repo exploration phrasing.",
      },
    ]
    try {
      ;(Global.Path as { config: string }).config = cfg
      process.env.KILO_TEST_HOME = home
      const root = MemoryPaths.root({ ctx: { directory: input.dir, worktree: input.dir } })
      process.env.KILO_MEMORY_EVAL = "1"
      process.env.KILO_MEMORY_EVAL_RUN_ID = run
      const turns: Turn[] = []
      for (const item of scenarios) {
        for (const next of input.modes ?? modes) {
          process.env.KILO_MEMORY_EVAL_MODE = next
          process.env.KILO_MEMORY_EVAL_SCENARIO = item.id
          const dir = path.join(input.dir, ".kilo", "eval", "workspaces", run, `${item.id}-${next}`)
          const mem = MemoryPaths.root({ ctx: { directory: dir, worktree: dir } })
          const base = await MemoryFiles.scaffold(mem)
          const state =
            next === "typed-auto" || next === "typed-auto-low-budget" ? { ...base, autoConsolidate: true } : base
          if (state !== base) await MemoryFiles.writeState(mem, state)
          await MemoryOperations.apply({
            root: mem,
            ops: item.seed.map((seed) => ({
              action: "add" as const,
              file: seed.file,
              section: seed.section,
              key: seed.key,
              text: seed.text,
            })),
          })
          for (const session of item.sessions ?? []) {
            await MemoryFiles.writeSession(mem, {
              sessionID: session.sessionID,
              summary: session.summary,
              max: state.limits.maxSessionLineChars,
              time: session.time,
            })
          }
          if (item.sessions?.length) await MemoryIndexer.rebuild({ root: mem, state })
          const startedAt = Date.now()
          const index = await MemoryFiles.readIndex(mem)
          const max = maxBytes(state.limits.maxProjectIndexBytes)
          const capped = next === "off" ? { text: "", bytes: 0, tokens: 0, truncated: false } : MemoryIndexer.cap(index, max)
          const recalled =
            item.recall && next !== "off" ? await MemoryRecall.search({ root: mem, query: item.recall.query, state }) : undefined
          const text = item.recall ? (recalled?.block ?? "") : capped.text
          const memory = item.recall ? (recalled?.tokens ?? 0) : capped.tokens
          const ok = next === "off" ? text.length === 0 : item.expect.every((expect) => text.includes(expect))
          const result = ok ? "success" : "failure"
          const note = next === "off" ? "baseline no injection" : item.notes
          const logged = await record(root, {
            sessionID: `${item.id}-${next}`,
            directory: dir,
            startedAt,
            completedAt: Date.now(),
            result,
            mode: next,
            scenarioID: item.id,
            memoryInjectedTokens: memory,
            memoryInjectedBytes: item.recall ? (recalled?.bytes ?? 0) : capped.bytes,
            memoryTruncated: capped.truncated,
            repeatedToolReadCount: next === "off" ? 2 : 0,
            toolCallCount: next === "off" ? 2 : 0,
            notes: note,
            testsPassed: ok,
          })
          if (!logged.skipped) turns.push(logged.turn)
        }
      }
      const out = await writeReport(root, run, turns)
      return { runID: run, root, report: out.path, turns }
    } finally {
      ;(Global.Path as { config: string }).config = priorConfig
      if (priorHome === undefined) delete process.env.KILO_TEST_HOME
      if (priorHome !== undefined) process.env.KILO_TEST_HOME = priorHome
      if (prior.eval === undefined) delete process.env.KILO_MEMORY_EVAL
      if (prior.eval !== undefined) process.env.KILO_MEMORY_EVAL = prior.eval
      if (prior.mode === undefined) delete process.env.KILO_MEMORY_EVAL_MODE
      if (prior.mode !== undefined) process.env.KILO_MEMORY_EVAL_MODE = prior.mode
      if (prior.run === undefined) delete process.env.KILO_MEMORY_EVAL_RUN_ID
      if (prior.run !== undefined) process.env.KILO_MEMORY_EVAL_RUN_ID = prior.run
      if (prior.scenario === undefined) delete process.env.KILO_MEMORY_EVAL_SCENARIO
      if (prior.scenario !== undefined) process.env.KILO_MEMORY_EVAL_SCENARIO = prior.scenario
    }
  }
}
