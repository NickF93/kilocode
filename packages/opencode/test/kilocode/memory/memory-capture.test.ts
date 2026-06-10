import { describe, expect, test } from "bun:test"
import z from "zod"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect } from "effect"
import { Bus } from "../../../src/bus"
import { provideInstance, tmpdir } from "../../fixture/fixture"
import {
  MemoryCapture,
  consolidationOptions,
  consolidationPrompt,
  fallbackDigest,
  guardReason,
  hasDurableDiff,
  inferOps,
  isVagueContinuation,
  mergeOps,
  parseDigest,
  parseJson,
  parseOps,
  shouldBypassInterval,
  shouldConsider,
  shouldConsiderOutput,
  skipped,
  summarize,
  summarizeDiffs,
  toolSummary,
  typedCapture,
} from "../../../src/kilocode/memory/capture"
import { KiloMemory, MemoryEvents, MemoryFiles, MemoryPaths } from "../../../src/kilocode/memory"
import type { MessageV2 } from "../../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../../src/session/schema"
import type { Provider } from "../../../src/provider/provider"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import type { Session } from "../../../src/session/session"
import type { SessionSummary } from "../../../src/session/summary"
import { MemoryTurn } from "../../../src/kilocode/memory/turn"

function llm(): Provider.Model {
  return {
    id: "gpt-5.4",
    providerID: "openai",
    api: { id: "gpt-5.4", npm: "@ai-sdk/openai", url: "" },
  } as Provider.Model
}

function mdl(): Provider.Model {
  return {
    ...llm(),
    id: ModelID.make("fake-memory-model"),
    providerID: ProviderID.make("test"),
    api: { id: "fake-memory-model", npm: "test-provider", url: "" },
    limit: { context: 100_000, output: 4_000 },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
  } as Provider.Model
}

function lang(outputs: string[], calls?: string[]): LanguageModelV3 {
  let idx = 0
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "fake-memory-model",
    supportedUrls: {},
    doGenerate: async (input: unknown) => {
      calls?.push(JSON.stringify(input))
      const text = outputs[idx++] ?? outputs.at(-1) ?? "{}"
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop" },
        usage: {
          inputTokens: { total: 12 },
          outputTokens: { total: 8 },
          raw: {},
        },
        warnings: [],
        providerMetadata: {},
        request: {},
        response: {},
      }
    },
  } as unknown as LanguageModelV3
}

function provider(outputs: string[], calls?: string[]): Provider.Interface {
  const model = mdl()
  const info = {
    id: model.providerID,
    name: "Test",
    source: "config",
    env: [],
    options: {},
    models: { [model.id]: model },
  } satisfies Provider.Info
  return {
    list: () => Effect.succeed({ [model.providerID]: info }),
    getProvider: () => Effect.succeed(info),
    getModel: () => Effect.succeed(model),
    getLanguage: () => Effect.succeed(lang(outputs, calls)),
    closest: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
    getSmallModel: () => Effect.succeed(model),
    defaultModel: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
  }
}

function small(outputs: string[], calls: string[]): Provider.Interface {
  const big = { ...mdl(), id: ModelID.make("large-memory-model") } as Provider.Model
  const tiny = { ...mdl(), id: ModelID.make("small-memory-model") } as Provider.Model
  const info = {
    id: big.providerID,
    name: "Test",
    source: "config",
    env: [],
    options: {},
    models: { [big.id]: big, [tiny.id]: tiny },
  } satisfies Provider.Info
  return {
    list: () => Effect.succeed({ [big.providerID]: info }),
    getProvider: () => Effect.succeed(info),
    getModel: () => Effect.succeed(big),
    getLanguage: (model) => {
      calls.push(model.id)
      return Effect.succeed(lang(outputs))
    },
    closest: () => Effect.succeed({ providerID: big.providerID, modelID: big.id }),
    getSmallModel: () => Effect.succeed(tiny),
    defaultModel: () => Effect.succeed({ providerID: big.providerID, modelID: big.id }),
  }
}

function failing(error: unknown): Provider.Interface {
  const model = mdl()
  const info = {
    id: model.providerID,
    name: "Test",
    source: "config",
    env: [],
    options: {},
    models: { [model.id]: model },
  } satisfies Provider.Info
  const language = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "fake-memory-model",
    supportedUrls: {},
    doGenerate: async () => {
      throw error
    },
  } as unknown as LanguageModelV3
  return {
    list: () => Effect.succeed({ [model.providerID]: info }),
    getProvider: () => Effect.succeed(info),
    getModel: () => Effect.succeed(model),
    getLanguage: () => Effect.succeed(language),
    closest: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
    getSmallModel: () => Effect.succeed(model),
    defaultModel: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
  }
}

function hanging(): Provider.Interface {
  const model = mdl()
  const info = {
    id: model.providerID,
    name: "Test",
    source: "config",
    env: [],
    options: {},
    models: { [model.id]: model },
  } satisfies Provider.Info
  const language = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "fake-memory-model",
    supportedUrls: {},
    doGenerate: async () => new Promise<never>(() => undefined),
  } as unknown as LanguageModelV3
  return {
    list: () => Effect.succeed({ [model.providerID]: info }),
    getProvider: () => Effect.succeed(info),
    getModel: () => Effect.succeed(model),
    getLanguage: () => Effect.succeed(language),
    closest: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
    getSmallModel: () => Effect.succeed(model),
    defaultModel: () => Effect.succeed({ providerID: model.providerID, modelID: model.id }),
  }
}

function prompt(input: string | undefined) {
  const parsed = JSON.parse(input ?? "{}") as Record<string, unknown>
  if (typeof parsed.prompt === "string") return parsed.prompt
  return JSON.stringify(parsed.prompt ?? parsed)
}

function section(input: string, name: string) {
  return input.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?:\\n## |\\n\`\`\`|$)`))?.[1] ?? ""
}

const summary = {
  summarize: () => Effect.void,
  diff: () => Effect.succeed([]),
  computeDiff: () => Effect.succeed([]),
} as SessionSummary.Interface

function part(sessionID: SessionID, messageID: MessageID, text: string): MessageV2.TextPart {
  return {
    id: PartID.make(`prt_${messageID}_part`),
    sessionID,
    messageID,
    type: "text",
    text,
  }
}

function turns(input: { sessionID: SessionID; user: string; assistant: string }) {
  const model = mdl()
  const userID = MessageID.make("msg_user")
  const assistantID = MessageID.make("msg_assistant")
  return [
    {
      info: {
        id: userID,
        sessionID: input.sessionID,
        role: "user",
        time: { created: 1 },
        agent: "code",
        model: { providerID: model.providerID, modelID: model.id },
      },
      parts: [part(input.sessionID, userID, input.user)],
    },
    {
      info: {
        id: assistantID,
        sessionID: input.sessionID,
        role: "assistant",
        time: { created: 2, completed: 3 },
        parentID: userID,
        modelID: model.id,
        providerID: model.providerID,
        mode: "build",
        agent: "code",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [part(input.sessionID, assistantID, input.assistant)],
    },
  ] as MessageV2.WithParts[]
}

function sessions(messages: MessageV2.WithParts[]): Session.Interface {
  return {
    get: () => Effect.succeed({ parentID: undefined }),
    messages: () => Effect.succeed(messages),
  } as unknown as Session.Interface
}

async function evalOff<T>(fn: () => Promise<T>) {
  const prior = {
    eval: process.env.KILO_MEMORY_EVAL,
    mode: process.env.KILO_MEMORY_EVAL_MODE,
  }
  process.env.KILO_MEMORY_EVAL = "0"
  delete process.env.KILO_MEMORY_EVAL_MODE
  try {
    return await fn()
  } finally {
    if (prior.eval === undefined) delete process.env.KILO_MEMORY_EVAL
    if (prior.eval !== undefined) process.env.KILO_MEMORY_EVAL = prior.eval
    if (prior.mode === undefined) delete process.env.KILO_MEMORY_EVAL_MODE
    if (prior.mode !== undefined) process.env.KILO_MEMORY_EVAL_MODE = prior.mode
  }
}

async function evalMode<T>(mode: string, fn: () => Promise<T>) {
  const prior = {
    eval: process.env.KILO_MEMORY_EVAL,
    mode: process.env.KILO_MEMORY_EVAL_MODE,
  }
  process.env.KILO_MEMORY_EVAL = "1"
  process.env.KILO_MEMORY_EVAL_MODE = mode
  try {
    return await fn()
  } finally {
    if (prior.eval === undefined) delete process.env.KILO_MEMORY_EVAL
    if (prior.eval !== undefined) process.env.KILO_MEMORY_EVAL = prior.eval
    if (prior.mode === undefined) delete process.env.KILO_MEMORY_EVAL_MODE
    if (prior.mode !== undefined) process.env.KILO_MEMORY_EVAL_MODE = prior.mode
  }
}

describe("memory capture", () => {
  test("gates model calls to likely memory intent", () => {
    expect(shouldConsider("remember that tests run from packages/opencode")).toBe(true)
    expect(shouldConsider("save that feature work should maintain product parity")).toBe(true)
    expect(shouldConsider("actually, use bun test here")).toBe(true)
    expect(shouldConsider("what commands are needed for this repo setup?")).toBe(true)
    expect(shouldConsider("how do I set up and run this repo?")).toBe(true)
    expect(shouldConsider("install dependencies before running dev")).toBe(true)
    expect(shouldConsider("we decided to keep memory project-only")).toBe(true)
    expect(shouldConsider("memory must stay project-only for v0")).toBe(true)
    expect(shouldConsider("do not use beads unless the user asks")).toBe(true)
    expect(shouldConsider("the architecture uses a file-backed index")).toBe(true)
    expect(shouldConsider("generated files should not be edited by hand")).toBe(true)
    expect(shouldConsider("that memory is wrong; remote checks should run after local tests")).toBe(true)
    expect(shouldConsider("the sibling cloud repo lives under ~/Workspace/cloud")).toBe(true)
    expect(shouldConsider("the useful project fixture lives outside the repo at /Users/me/fixtures")).toBe(true)
    expect(shouldConsider("thanks, continue")).toBe(false)
  })

  test("gates assistant output to command-like durable answers", () => {
    expect(shouldConsiderOutput("Use bun install, then bun run dev.")).toBe(true)
    expect(shouldConsiderOutput("Decision: keep v0 memory project-only.")).toBe(true)
    expect(shouldConsiderOutput("Architecture: use a file-backed memory index.")).toBe(true)
    expect(shouldConsiderOutput("This workspace uses Bun, Turborepo, and Java 21.")).toBe(true)
    expect(shouldConsiderOutput("Run:\nmake test")).toBe(true)
    expect(shouldConsiderOutput("I checked the current task and continued.")).toBe(false)
  })

  test("summarizes tool commands for consolidation evidence", () => {
    const part = {
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "tool",
      callID: "call",
      tool: "shell",
      state: {
        status: "completed",
        input: { command: "bun run typecheck", description: "Run typecheck" },
        output: "ok",
        title: "Run typecheck",
        metadata: { exit: 0 },
        time: { start: 1, end: 2 },
      },
    } as unknown as MessageV2.ToolPart

    const text = toolSummary(part)

    expect(text).toContain("Tool shell completed")
    expect(text).toContain("command=bun run typecheck")
    expect(text).toContain("exit=0")
    expect(shouldConsiderOutput(text)).toBe(true)
  })

  test("summarizes failed tool commands without leaking secret-like inputs", () => {
    const part = {
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "tool",
      callID: "call",
      tool: "shell",
      state: {
        status: "error",
        input: { command: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz bun test" },
        error: "password=supersecret failed",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } as unknown as MessageV2.ToolPart

    const text = toolSummary(part)

    expect(text).toContain("Tool shell error")
    expect(text).toContain("command=[redacted]")
    expect(text).toContain("error=[redacted]")
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(text).not.toContain("supersecret")
  })

  test("bypasses consolidation interval only for explicit memory intent", () => {
    expect(shouldBypassInterval("that memory is wrong; use remote checks after local tests")).toBe(true)
    expect(shouldBypassInterval("remember for this project that tests run from packages/opencode")).toBe(true)
    expect(shouldBypassInterval("save that feature work should maintain product parity")).toBe(true)
    expect(shouldBypassInterval("the sibling cloud repo lives under ~/Workspace/cloud")).toBe(false)
  })

  test("runs typed consolidation only for completed turns", () => {
    expect(typedCapture({ reason: "completed", signal: true, interval: false, inferred: 0 })).toEqual({
      call: true,
      work: true,
    })
    expect(typedCapture({ reason: "completed", signal: false, interval: false, inferred: 1 })).toEqual({
      call: true,
      work: true,
    })
    expect(typedCapture({ reason: "completed", signal: false, interval: false, inferred: 0 })).toEqual({
      call: false,
      work: false,
    })
    expect(typedCapture({ reason: "interrupted", signal: true, interval: false, inferred: 1 })).toEqual({
      call: false,
      work: false,
    })
    expect(typedCapture({ reason: "interrupted", signal: false, interval: false, inferred: 0 })).toEqual({
      call: false,
      work: false,
    })
    expect(typedCapture({ reason: "error", signal: true, interval: false, inferred: 1 })).toEqual({
      call: false,
      work: false,
    })
  })

  test("does not let the consolidation interval suppress inferred commands", () => {
    expect(typedCapture({ reason: "completed", signal: true, interval: true, inferred: 0 })).toEqual({
      call: false,
      work: false,
    })
    expect(typedCapture({ reason: "completed", signal: false, interval: true, inferred: 1 })).toEqual({
      call: true,
      work: true,
    })
    expect(typedCapture({ reason: "interrupted", signal: false, interval: true, inferred: 1 })).toEqual({
      call: false,
      work: false,
    })
  })

  test("builds audited skip decisions for transparent auto-save", () => {
    expect(skipped({ sessionID: SessionID.make("session-memory"), reason: "no_signal" })).toEqual({
      kind: "typed",
      trigger: "turn-close",
      sessionID: "session-memory",
      result: "skipped",
      llm: false,
      parsed: false,
      fallback: false,
      reason: "no_signal",
      tokens: 0,
      operationCount: 0,
      skippedCount: 1,
      summary: "memory capture skipped: no_signal",
    })
  })

  test("uses safe OpenAI options for consolidation model calls", () => {
    expect(consolidationOptions(llm())).toEqual({ store: false })
    expect(consolidationPrompt({ model: llm(), options: { store: false }, system: "memory prompt" })).toEqual({
      providerOptions: { openai: { store: false, instructions: "memory prompt" } },
      system: undefined,
    })
  })

  test("classifies consolidation quota guard failures", () => {
    expect(guardReason("status=429 rate limit exceeded")).toBe("rate_limit_guard")
    expect(guardReason("insufficient_quota billing limit")).toBe("quota_guard")
    expect(guardReason("json parse error")).toBeUndefined()
  })

  test("detects vague continuation prompts", () => {
    expect(isVagueContinuation("i wanna continue")).toBe(true)
    expect(isVagueContinuation("resume")).toBe(true)
    expect(isVagueContinuation("continue implementing the memory spec")).toBe(false)
    expect(isVagueContinuation("run tests and continue")).toBe(false)
  })

  test("parses spec operation names into deterministic memory operations", () => {
    expect(
      parseOps({
        operations: [
          {
            op: "upsert_environment_fact",
            key: "tests",
            value: "Run bun test from packages/opencode.",
          },
          {
            op: "remove_memory",
            query: "stale",
          },
          {
            op: "noop",
            key: "low",
            value: "Skip me",
          },
        ],
        skipped: [],
      }),
    ).toEqual([
      {
        action: "add",
        file: "environment.md",
        section: "Commands",
        key: "tests",
        text: "Run bun test from packages/opencode.",
      },
      {
        action: "remove",
        query: "stale",
      },
    ])
  })

  test("routes environment facts into typed sections", () => {
    expect(
      parseOps({
        operations: [
          {
            op: "upsert_environment_fact",
            section: "Paths",
            key: "workspace_root",
            value: "Linked worktrees use the canonical repo identity for project memory.",
          },
          {
            op: "upsert_environment_fact",
            section: "tooling",
            key: "package_manager",
            value: "Use Bun for package scripts.",
          },
          {
            op: "upsert_environment_fact",
            section: "invalid",
            key: "dev_command",
            value: "Run bun run dev from the repo root.",
          },
        ],
        skipped: [],
      }),
    ).toEqual([
      {
        action: "add",
        file: "environment.md",
        section: "Paths",
        key: "workspace_root",
        text: "Linked worktrees use the canonical repo identity for project memory.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Tooling",
        key: "package_manager",
        text: "Use Bun for package scripts.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Commands",
        key: "dev_command",
        text: "Run bun run dev from the repo root.",
      },
    ])
  })

  test("parses json text from model output", () => {
    expect(parseJson(z.object({ value: z.string() }), '```json\n{"value":"ok"}\n```')).toEqual({ value: "ok" })
  })

  test("maps correction, decision, and constraint operations to priority source sections", () => {
    expect(
      parseOps({
        operations: [
          {
            op: "append_correction",
            key: "test_command",
            value: "Run bun test from packages/opencode, not from the repo root.",
          },
          {
            op: "upsert_project_decision",
            key: "memory_storage",
            value: "Keep v0 memory file-based.",
          },
          {
            op: "upsert_project_constraint",
            key: "project_only",
            value: "Memory v0 must stay project-only.",
          },
        ],
        skipped: [],
      }),
    ).toEqual([
      {
        action: "add",
        file: "corrections.md",
        section: "Corrections",
        key: "test_command",
        text: "Run bun test from packages/opencode, not from the repo root.",
      },
      {
        action: "add",
        file: "project.md",
        section: "Decisions",
        key: "memory_storage",
        text: "Keep v0 memory file-based.",
      },
      {
        action: "add",
        file: "project.md",
        section: "Constraints",
        key: "project_only",
        text: "Memory v0 must stay project-only.",
      },
    ])
  })

  test("infers obvious environment commands without model judgment", () => {
    expect(
      inferOps({
        user: "what commands are needed for setup?",
        assistant:
          "Run bun install from the repo root, use bun run dev for dev, and run bun test from packages/opencode. Never run root bun test.",
      }),
    ).toEqual([
      {
        action: "add",
        file: "environment.md",
        section: "Tooling",
        key: "package_manager",
        text: "Use Bun for package management and package scripts.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Commands",
        key: "install_dependencies",
        text: "Run bun install from the repo root.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Commands",
        key: "dev_command",
        text: "Run bun run dev from the repo root.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Commands",
        key: "cli_tests",
        text: "Run bun test from packages/opencode for CLI tests.",
      },
      {
        action: "add",
        file: "corrections.md",
        section: "Corrections",
        key: "root_bun_test",
        text: "Do not run root bun test; run package-level tests instead.",
      },
    ])
  })

  test("infers durable local tooling without model judgment", () => {
    expect(
      inferOps({
        user: "what tooling does this repo use?",
        assistant:
          "This workspace uses Bun for package scripts, Turborepo for orchestration, and Java 21 for JetBrains checks.",
      }),
    ).toEqual([
      {
        action: "add",
        file: "environment.md",
        section: "Tooling",
        key: "package_manager",
        text: "Use Bun for package management and package scripts.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Tooling",
        key: "build_orchestration",
        text: "Use Turborepo/Turbo for workspace orchestration.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Tooling",
        key: "java_21",
        text: "Use Java 21 for project checks or tooling that require it.",
      },
    ])
  })

  test("infers setup commands without inventing repo-root location", () => {
    expect(
      inferOps({
        user: "what commands are needed for setup?",
        assistant: "Use bun install, then bun run dev.",
      }),
    ).toEqual([
      {
        action: "add",
        file: "environment.md",
        section: "Tooling",
        key: "package_manager",
        text: "Use Bun for package management and package scripts.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Commands",
        key: "install_dependencies",
        text: "Run bun install.",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Commands",
        key: "dev_command",
        text: "Run bun run dev.",
      },
    ])
  })

  test("merges fallback typed operations without duplicates", () => {
    expect(
      mergeOps([
        {
          action: "add",
          file: "environment.md",
          section: "Commands",
          key: "cli_tests",
          text: "Run bun test from packages/opencode for CLI tests.",
        },
        {
          action: "add",
          file: "environment.md",
          section: "Commands",
          key: "cli_tests",
          text: "Run bun test from packages/opencode for CLI tests.",
        },
        {
          action: "remove",
          query: "stale",
        },
        {
          action: "remove",
          query: "stale",
        },
      ]),
    ).toEqual([
      {
        action: "add",
        file: "environment.md",
        section: "Commands",
        key: "cli_tests",
        text: "Run bun test from packages/opencode for CLI tests.",
      },
      {
        action: "remove",
        query: "stale",
      },
    ])
  })

  test("does not infer typed memory from vague continuation work", () => {
    expect(
      inferOps({
        user: "where did we stop?",
        assistant: "I checked the current task and inspected the worktree.",
      }),
    ).toEqual([])
  })

  test("summarizes completed turns within the session memory line budget", () => {
    const text = summarize({
      user: "Remember that local tests should run before remote checks.",
      assistant: "Updated the test workflow and verified the targeted suite.",
      max: 80,
    })

    expect(text.length).toBeLessThanOrEqual(80)
    expect(text).toContain("User:")
    expect(text).toContain("Result:")
  })

  test("normalizes session digests and falls back when the model returns empty output", () => {
    expect(parseDigest({ topic: "", summary: "" }, "fallback digest", 80)).toEqual({
      topic: "fallback digest",
      summary: "fallback digest",
    })
    expect(
      parseDigest({ topic: "test workflow", summary: "  objective done; next run tests  " }, "fallback", 80),
    ).toEqual({
      topic: "test workflow",
      summary: "objective done; next run tests",
    })
  })

  test("drops repo status-only session digests", () => {
    expect(
      parseDigest(
        {
          topic: "memory updates",
          summary:
            "Recent state: Latest commit: e83a920622 feat(cli): add project memory v0. Working tree has untracked .plans and memory docs.",
        },
        "",
        240,
      ),
    ).toEqual({ topic: "", summary: "" })
  })

  test("fallback digest rolls forward from prior digest and latest turn", () => {
    const text = fallbackDigest({
      prior: "Objective: implement memory digest. Done: split typed memory prompt.",
      summary: "User: continue Result: added tests and fixed typecheck.",
      max: 120,
    })

    expect(text.length).toBeLessThanOrEqual(120)
    expect(text).toContain("Objective")
    expect(text).toContain("Latest:")
  })

  test("detects durable repository diff signals", () => {
    expect(hasDurableDiff([{ file: "package.json", additions: 1, deletions: 0 }])).toBe(true)
    expect(hasDurableDiff([{ file: ".kilo/command/test.md", additions: 1, deletions: 0 }])).toBe(true)
    expect(hasDurableDiff([{ file: "src/feature.ts", additions: 25, deletions: 0 }])).toBe(true)
    expect(hasDurableDiff([{ file: "src/button.ts", additions: 1, deletions: 0 }])).toBe(false)
  })

  test("summarizes changed files for consolidation input", () => {
    expect(
      summarizeDiffs([
        {
          file: "package.json",
          status: "modified",
          additions: 2,
          deletions: 1,
        },
      ]),
    ).toBe("modified package.json +2 -1")
  })

  test("turn-close typed LLM saves environment memory and audit records", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_save")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })
    const messages = turns({
      sessionID,
      user: "what commands are needed for this repo setup?",
      assistant: "Use bun install, then bun test ./test/kilocode/memory from packages/opencode.",
    })

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider([
            '{"topic":"repo setup","summary":"Explored repo setup commands. Next step: verify memory tests."}',
            '{"operations":[{"op":"upsert_environment_fact","section":"Commands","key":"cli_memory_tests","value":"Run bun test ./test/kilocode/memory from packages/opencode."}],"skipped":[{"reason":"transient","text":"temporary setup exploration"}]}',
          ]),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )

    const root = MemoryPaths.root({ ctx })
    const shown = await KiloMemory.show({ ctx })

    expect(result).toMatchObject({ skipped: false, operationCount: 1 })
    expect(result.tokens).toBeGreaterThan(0)
    expect(shown.sources.environment).toContain("cli_memory_tests")
    expect(shown.index).toContain("type=env")
    expect(shown.index).toContain("cli_memory_tests")
    expect(shown.decisions).toContain('"kind":"digest"')
    expect(shown.decisions).toContain('"kind":"typed"')
    expect(shown.decisions).toContain('"result":"saved"')
    expect(shown.decisions).toContain('"files":["environment.md"]')
    expect(shown.decisions).toContain('"skipped":[{"reason":"transient"')
    expect(await MemoryFiles.readSession(root, { sessionID, max: 360 })).toMatchObject({
      id: sessionID,
      topic: "repo setup",
      summary: "Explored repo setup commands. Next step: verify memory tests.",
    })
  })

  test("eval off mode skips capture before legacy memory migration", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_eval_off_memory")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    const old = MemoryPaths.legacyRoot({ ctx })
    const root = MemoryPaths.root({ ctx })
    await KiloMemory.enable({ root: old })
    const messages = turns({
      sessionID,
      user: "remember this should not migrate during eval off",
      assistant: "This should not be captured.",
    })

    const result = await evalMode("off", () =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider(['{"topic":"no","summary":"no"}']),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )

    expect(result).toMatchObject({ skipped: true, reason: "eval_off_capture_disabled" })
    expect(await Bun.file(MemoryPaths.files(old).state).exists()).toBe(true)
    expect(await Bun.file(MemoryPaths.files(root).state).exists()).toBe(false)
  })

  test("turn-close skips memory-echo turns answered from recall", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_echo")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    const messages = turns({
      sessionID,
      user: "what is the kilo brand?",
      assistant: "Kilo brand colors are black and yellow.",
    })
    const last = messages.at(-1)!
    last.parts = [
      ...last.parts,
      {
        ...part(sessionID, last.info.id, ""),
        synthetic: true,
        ignored: true,
        metadata: { kiloMemory: { type: "recall", count: 1, bytes: 100, tokens: 25, files: ["project.md"] } },
      },
    ]

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider(['{"topic":"brand","summary":"Echoed brand answer."}']),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )

    expect(result).toMatchObject({ skipped: true, reason: "memory_echo" })
    const root = MemoryPaths.root({ ctx })
    const item = await MemoryFiles.readSession(root, { sessionID, max: 360 })
    expect(item).toBeUndefined()
  })

  test("turn-close digests long recall-assisted research answers", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_research")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    const messages = turns({
      sessionID,
      user: "explain the effect architecture in this codebase",
      assistant: `The architecture uses Effect-TS layers. ${"Each service is defined as a namespace with Effect.fn wrappers and InstanceState context propagation. ".repeat(20)}`,
    })
    const last = messages.at(-1)!
    last.parts = [
      ...last.parts,
      {
        ...part(sessionID, last.info.id, ""),
        synthetic: true,
        ignored: true,
        metadata: { kiloMemory: { type: "recall", count: 1, bytes: 100, tokens: 25, files: ["project.md"] } },
      },
    ]

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider(['{"topic":"effect architecture","summary":"Explained Effect-TS layer architecture."}']),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )

    expect(result).toMatchObject({ skipped: false })
    const root = MemoryPaths.root({ ctx })
    const item = await MemoryFiles.readSession(root, { sessionID, max: 360 })
    expect(item?.summary).toContain("Effect-TS")
  })

  test("turn-close consolidation uses the session model", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_small_model")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    const messages = turns({
      sessionID,
      user: "what commands are needed for this repo setup?",
      assistant: "Use bun install from the repo root.",
    })
    const calls: string[] = []

    await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: small(['{"topic":"repo setup","summary":"Saved setup digest."}'], calls),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )

    expect(calls).toEqual(["large-memory-model"])
  })

  test("turn-close digest-only capture records auto-save model usage tokens", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_digest_stats")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    const messages = turns({
      sessionID,
      user: "what commands are needed for this repo setup?",
      assistant: "Use bun install from the repo root.",
    })

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider(['{"topic":"repo setup","summary":"Saved setup digest."}']),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const root = MemoryPaths.root({ ctx })
    const state = await MemoryFiles.readState(root)
    const shown = await KiloMemory.show({ ctx })

    expect(result).toMatchObject({ skipped: false, operationCount: 0, tokens: 20 })
    expect(state.stats.lastConsolidationTokens).toBe(20)
    expect(state.stats.lastOperationCount).toBe(0)
    expect(shown.changes).toContain("consolidate trigger=turn-close digest=1 ops=0 tokens=20")
  })

  test("turn-close session digest redacts secret-like text", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_secret_digest")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
    const messages = turns({
      sessionID,
      user: "remember the setup note",
      assistant: `The test token is api_key=${secret}.`,
    })

    await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider([`{"topic":"api_key ${secret}","summary":"The token is api_key=${secret}."}`]),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const root = MemoryPaths.root({ ctx })
    const item = await MemoryFiles.readSession(root, { sessionID, max: 360 })

    expect(item?.topic).toContain("[redacted]")
    expect(item?.summary).toContain("[redacted]")
    expect(item?.summary).not.toContain(secret)
  })

  test("turn-close consolidation evidence redacts secret-like text", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_secret_evidence")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
    const calls: string[] = []
    await KiloMemory.enable({ ctx })
    const messages = turns({
      sessionID,
      user: `remember that api_key=${secret}`,
      assistant: `The token is ${secret}.`,
    })

    await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider(['{"topic":"secret","summary":"Secret was redacted."}'], calls),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const sent = prompt(calls.at(0))

    expect(sent).toContain("[redacted]")
    expect(sent).not.toContain(secret)
  })

  test("turn-close skips child sessions before capture", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_child_memory")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    const messages = turns({
      sessionID,
      user: "remember the child session command",
      assistant: "Run child-only-test from the child session.",
    })
    let reads = 0
    const svc = {
      get: () => Effect.succeed({ parentID: SessionID.make("ses_parent") }),
      messages: () =>
        Effect.sync(() => {
          reads++
          return messages
        }),
    } as unknown as Session.Interface

    await Effect.runPromise(
      MemoryTurn.close({
        sessionID,
        reason: "completed",
        sessions: svc,
        summary,
        provider: provider(['{"topic":"child","summary":"Should not save."}']),
      }).pipe(provideInstance(tmp.path)),
    )
    const shown = await KiloMemory.show({ ctx })

    expect(reads).toBe(0)
    expect(shown.decisions).not.toContain(sessionID)
    expect(shown.index).not.toContain("child-only-test")
  })

  test("turn-close typed LLM skip is visible in decisions", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_skip")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })
    const messages = turns({
      sessionID,
      user: "what commands did you check?",
      assistant: "I checked git status and continued the task.",
    })
    const events: MemoryEvents.Status[] = []

    const result = await evalOff(() =>
      Effect.runPromise(
        Effect.acquireUseRelease(
          Effect.sync(() => Bus.subscribe(MemoryEvents.Status, (event) => events.push(event.properties))),
          () =>
            MemoryCapture.turn({
              sessionID,
              sessions: sessions(messages),
              summary,
              provider: provider([
                '{"summary":"Checked current status. No durable project knowledge was established."}',
                '{"operations":[],"skipped":[{"reason":"transient","text":"checked git status"}]}',
              ]),
              reason: "completed",
            }),
          (off) => Effect.sync(off),
        ).pipe(provideInstance(tmp.path)),
      ),
    )
    await Bun.sleep(10)
    const shown = await KiloMemory.show({ ctx })

    expect(result).toMatchObject({ skipped: false, operationCount: 0 })
    expect(result.tokens).toBeGreaterThan(0)
    expect(events.some((event) => event.state === "idle" && event.consolidation?.operationCount === 0)).toBe(true)
    expect(events.some((event) => event.detail?.type === "skipped")).toBe(false)
    expect(shown.decisions).toContain('"kind":"typed"')
    expect(shown.decisions).toContain('"result":"skipped"')
    expect(shown.decisions).toContain('"skippedCount":1')
    expect(shown.decisions).toContain('"text":"checked git status"')
    expect(shown.sources.environment).not.toContain("checked git status")
  })

  test("turn-close model rate-limit failures are audited as guard fallbacks", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_rate_limit")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })
    const messages = turns({
      sessionID,
      user: "what commands are needed for this repo setup?",
      assistant: "Use bun install from the repo root.",
    })
    const error = Object.assign(new Error("Rate limit exceeded"), { status: 429 })

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: failing(error),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const shown = await KiloMemory.show({ ctx })

    expect(result).toMatchObject({ skipped: false })
    expect(shown.decisions).toContain('"reason":"rate_limit_guard"')
    expect(shown.decisions).toContain('"result":"fallback"')
    expect(shown.changes).toContain("digest error=rate_limit_guard")
    expect(shown.sources.environment).not.toContain("install_dependencies")
  })

  test("turn-close skips errored turns without saving session or typed memory", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_error_turn")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })
    const messages = turns({
      sessionID,
      user: "what commands are needed for this repo setup?",
      assistant: "Use bun install from the repo root.",
    })

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider([
            '{"topic":"repo setup","summary":"Should not be used."}',
            '{"operations":[{"op":"upsert_environment_fact","section":"Commands","key":"install_dependencies","value":"Run bun install from the repo root."}],"skipped":[]}',
          ]),
          reason: "error",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const root = MemoryPaths.root({ ctx })
    const shown = await KiloMemory.show({ ctx })

    expect(result).toMatchObject({ skipped: true, reason: "no_signal" })
    expect(await MemoryFiles.readSession(root, { sessionID, max: 360 })).toBeUndefined()
    expect(shown.sources.environment).not.toContain("install_dependencies")
    expect(shown.decisions).toContain('"reason":"no_signal"')
  })

  test("turn-close model timeout saves digest fallback but no typed fallback memory", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_timeout")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })
    const root = MemoryPaths.root({ ctx })
    const state = await MemoryFiles.readState(root)
    await MemoryFiles.writeState(root, {
      ...state,
      capture: {
        ...state.capture,
        timeoutMs: 20,
      },
    })
    const messages = turns({
      sessionID,
      user: "what commands are needed for this repo setup?",
      assistant: "Use bun install from the repo root.",
    })
    const started = Date.now()

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: hanging(),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const shown = await KiloMemory.show({ ctx })

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result).toMatchObject({ skipped: false, operationCount: 0 })
    expect(await MemoryFiles.readSession(root, { sessionID, max: 360 })).toMatchObject({
      id: sessionID,
    })
    expect(shown.decisions).toContain('"reason":"memory model timed out"')
    expect(shown.decisions).toContain('"fallback":true')
    expect(shown.sources.environment).not.toContain("install_dependencies")
  })

  test("turn-close duplicate skip cites typed memory source", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_duplicate_skip")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })
    await KiloMemory.apply({
      ctx,
      ops: [
        {
          action: "add",
          file: "environment.md",
          section: "Commands",
          key: "vscode_unit_tests",
          text: "Run VS Code unit tests with bun run test:unit from packages/kilo-vscode.",
        },
      ],
    })
    const messages = turns({
      sessionID,
      user: "what did we establish about vscode unit tests?",
      assistant: "VS Code unit tests run with bun run test:unit from packages/kilo-vscode.",
    })

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider([
            '{"summary":"Confirmed VS Code unit test command already known."}',
            '{"operations":[],"skipped":[{"reason":"duplicate","text":"VS Code unit tests run with bun run test:unit from packages/kilo-vscode."}]}',
          ]),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const shown = await KiloMemory.show({ ctx })

    expect(result).toMatchObject({ skipped: false, operationCount: 0 })
    expect(shown.decisions).toContain('"duplicateOf":"environment.md:vscode_unit_tests"')
    expect(shown.changes).toContain("reason=duplicate duplicateOf=environment.md:vscode_unit_tests")
  })

  test("turn-close rescues facts the model wrongly skipped as duplicates", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_rescue")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })
    await KiloMemory.apply({
      ctx,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "effect_facade_ratchet",
          text: "Do not add runtime-backed Promise facades to shared Effect services.",
        },
      ],
    })
    const messages = turns({
      sessionID,
      user: "how do we test effect services here?",
      assistant: "The Effect service test command uses test/lib/effect.ts helpers to provision InstanceState.",
    })

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider([
            '{"summary":"Explained Effect service test helpers."}',
            '{"operations":[],"skipped":[{"reason":"duplicate","text":"Use test/lib/effect.ts helpers to provision InstanceState for Effect service tests.","duplicateOf":"project.md:effect_facade_ratchet"}]}',
          ]),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const root = MemoryPaths.root({ ctx })
    const project = await MemoryFiles.readSource(root, "project.md")

    expect(result).toMatchObject({ skipped: false, operationCount: 1 })
    expect(project).toContain("test/lib/effect.ts")
  })

  test("turn-close filters duplicate operations even when model emits them", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_duplicate_operation")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    await KiloMemory.enable({ ctx })
    await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })
    await KiloMemory.apply({
      ctx,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "features_need_to_have_parity_if_we_implement",
          text: "features need to have parity, if we implement in cli we need to implement in vscode and jetbrains too",
        },
      ],
    })
    const messages = turns({
      sessionID,
      user: "what constraints do we have in this repo?",
      assistant: "Feature parity: if implementing a feature in CLI, also consider VS Code and JetBrains parity.",
    })

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider([
            '{"summary":"Answered with project constraints."}',
            '{"operations":[{"op":"append_correction","key":"features_need_to_have_parity_if_we_implement","value":"features need to have parity across CLI, VS Code, and JetBrains"}],"skipped":[{"reason":"duplicate","text":"features need to have parity"}]}',
          ]),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const shown = await KiloMemory.show({ ctx })

    expect(result).toMatchObject({ skipped: false, operationCount: 0 })
    expect(shown.sources.corrections).not.toContain("features_need_to_have_parity_if_we_implement")
    expect(shown.decisions).toContain('"duplicateOf":"project.md:features_need_to_have_parity_if_we_implement"')
  })

  test("turn-close typed LLM does not treat session digests as typed duplicates", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.make("ses_memory_digest_duplicate")
    const ctx = { directory: tmp.path, worktree: tmp.path }
    const enabled = await KiloMemory.enable({ ctx })
    await KiloMemory.configure({ ctx, settings: { autoConsolidate: true } })
    await MemoryFiles.writeSession(MemoryPaths.root({ ctx }), {
      sessionID: "ses_prior",
      summary: "PR #10550 is already addressed by merged PR #10594.",
      max: enabled.state.limits.maxSessionLineChars,
    })
    await KiloMemory.rebuild({ ctx })
    const calls: string[] = []
    const messages = turns({
      sessionID,
      user: "remember the durable result from checking PR #10550",
      assistant: "PR #10550 is already addressed by merged PR #10594.",
    })

    const result = await evalOff(() =>
      Effect.runPromise(
        MemoryCapture.turn({
          sessionID,
          sessions: sessions(messages),
          summary,
          provider: provider(
            [
              '{"summary":"Checked PR #10550 against merged PR #10594."}',
              '{"operations":[{"op":"upsert_project_fact","key":"pr_10550_status","value":"PR #10550 is already addressed by merged PR #10594."}],"skipped":[]}',
            ],
            calls,
          ),
          reason: "completed",
        }).pipe(provideInstance(tmp.path)),
      ),
    )
    const typed = prompt(calls.at(-1))
    const existing = section(typed, "existing_memory")
    const shown = await KiloMemory.show({ ctx })

    expect(result).toMatchObject({ skipped: false, operationCount: 1 })
    expect(typed).toContain("PR #10550")
    expect(typed).toContain("```kilo-memory-evidence-v1")
    expect(existing).not.toContain("10550")
    expect(existing).not.toContain("10594")
    expect(shown.sources.project).toContain("pr_10550_status")
  })
})
