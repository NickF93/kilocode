import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { KiloMemory, MemoryFiles } from "../../../src/kilocode/memory"
import { MemoryRecallTool } from "../../../src/kilocode/tool/memory-recall"
import { WithInstance } from "../../../src/project/with-instance"
import { MessageID, SessionID } from "../../../src/session/schema"
import { RemoteSender } from "../../../src/kilo-sessions/remote-sender"
import type { Tool } from "../../../src/tool/tool"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

const watch = process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "code",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function user(text: string): Tool.Context {
  return {
    ...ctx,
    messages: [
      {
        info: { role: "user" },
        parts: [{ type: "text", text }],
      },
    ] as unknown as Tool.Context["messages"],
  }
}

beforeEach(() => {
  process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  spyOn(RemoteSender, "create").mockReturnValue({ handle() {}, dispose() {} })
})

afterEach(async () => {
  mock.restore()
  if (watch === undefined) delete process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER
  if (watch !== undefined) process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER = watch
  await resetDatabase()
})

async function withConfig<T>(dir: string, fn: () => Promise<T> | T) {
  const prior = Global.Path.config
  ;(Global.Path as { config: string }).config = dir
  try {
    return await fn()
  } finally {
    ;(Global.Path as { config: string }).config = prior
  }
}

describe("kilo_memory_recall", () => {
  test("shows typed memory hits separately from session digests", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      const enabled = await KiloMemory.enable({ ctx: memory })
      await KiloMemory.apply({
        root: enabled.root,
        ops: [
          {
            action: "add",
            file: "environment.md",
            section: "Commands",
            key: "vscode_tests",
            text: "Run VS Code unit tests from packages/kilo-vscode with bun run test:unit.",
          },
          {
            action: "add",
            file: "project.md",
            section: "Constraints",
            key: "project_only",
            text: "Memory v0 must stay project-only.",
          },
        ],
      })
      await KiloMemory.recordSession({
        ctx: memory,
        sessionID: "ses_memory_only",
        topic: "digest recall",
        summary: "Objective: continue memory digest recall. Next: avoid full transcript reads.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })

      const typed = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "typed", query: "vscode unit tests" }, ctx))
        },
      })
      const digest = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "digest", sessionID: "ses_memory_only" }, ctx))
        },
      })
      const constraint = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "typed", query: "project-only constraints" }, ctx))
        },
      })

      expect(typed.title).toContain("Kilo memory typed")
      expect(typed.output).toContain("## Typed Memory")
      expect(typed.output).toContain("vscode_tests")
      expect(typed.output).not.toContain("## Session Digests")
      expect(constraint.output).toContain("PROJECT_CONSTRAINT")
      expect(constraint.output).toContain("project_only")

      expect(digest.title).toContain("Kilo memory digest")
      expect(digest.output).toContain("## Session Digests")
      expect(digest.output).toContain('topic="digest recall"')
      expect(digest.output).toContain("continue memory digest recall")
      expect(digest.output).not.toContain("# Session:")

      const direct = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(
            tool.execute({ mode: "digest", sessionID: "ses_memory_only", query: "unrelated" }, ctx),
          )
        },
      })

      expect(direct.output).toContain("continue memory digest recall")

      const decisions = await MemoryFiles.readDecisions(enabled.root)
      expect(decisions).toContain('"sessionID":"ses_test"')
      expect(decisions).toContain('"query":"sessionID=ses_memory_only"')
      expect(decisions).toContain('"summary":"memory recall returned 1 typed hits"')
      expect(decisions).toContain('"summary":"memory recall returned 1 digest hits"')
    })
  })

  test("catalog mode lists all stored keys with optional filter", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      const enabled = await KiloMemory.enable({ ctx: memory })
      await KiloMemory.apply({
        root: enabled.root,
        ops: [
          {
            action: "add",
            file: "project.md",
            section: "Facts",
            key: "kilo_was_originally_a_fork",
            text: "kilo was originally a fork of roo and has a kilocode-legacy repo",
          },
          {
            action: "add",
            file: "environment.md",
            section: "Commands",
            key: "vscode_tests",
            text: "Run VS Code unit tests from packages/kilo-vscode with bun run test:unit.",
          },
        ],
      })

      const all = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "catalog" }, ctx))
        },
      })
      const filtered = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "catalog", query: "fork" }, ctx))
        },
      })

      expect(all.output).toContain("kilo_was_originally_a_fork")
      expect(all.output).toContain("vscode_tests")
      expect(filtered.output).toContain("kilo_was_originally_a_fork")
      expect(filtered.output).not.toContain("vscode_tests")
    })
  })

  test("digest mode does not fall back to another session when id is missing", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      await KiloMemory.enable({ ctx: memory })
      await KiloMemory.recordSession({
        ctx: memory,
        sessionID: "ses_memory_only",
        summary: "Objective: continue memory digest recall.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })

      const result = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "digest", sessionID: "ses_missing" }, ctx))
        },
      })

      expect(result.output).toContain('No useful saved memory digest found for session "ses_missing"')
      expect(result.output).not.toContain("continue memory digest recall")
    })
  })

  test("continuation digest recall browses recent digests instead of trusting a stale session id", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      await KiloMemory.enable({ ctx: memory })
      await KiloMemory.recordSession({
        ctx: memory,
        sessionID: "ses_plugins",
        topic: "OpenCode plugin architecture",
        summary: "Explored how plugins load through config, server hooks, and TUI runtime wiring.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })
      await KiloMemory.recordSession({
        ctx: memory,
        sessionID: "ses_upstream",
        topic: "upstream file edits",
        summary: "Discussed minimizing shared upstream file edits under packages/opencode.",
        time: Date.UTC(2026, 0, 1, 0, 1),
      })

      const result = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(
            tool.execute({ mode: "digest", sessionID: "ses_upstream", limit: 5 }, user("where were we?")),
          )
        },
      })

      expect(result.output).toContain("session=ses_plugins")
      expect(result.output).toContain("plugins load through config")
      expect(result.output).toContain("session=ses_upstream")
    })
  })

  test("typed and search modes require a topic query", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      await KiloMemory.enable({ ctx: memory })
      await KiloMemory.apply({
        ctx: memory,
        ops: [{ action: "add", key: "cli_tests", text: "Run CLI tests from packages/opencode." }],
      })

      const typed = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "typed" }, ctx))
        },
      })
      const search = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "search" }, ctx))
        },
      })

      for (const result of [typed, search]) {
        expect(result.title).toContain("no query")
        expect(result.output).toContain("Provide a topic query")
        expect(result.output).not.toContain("cli_tests")
      }
    })
  })

  test("digest mode does not read the active session id", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      const enabled = await KiloMemory.enable({ ctx: memory })
      await KiloMemory.recordSession({
        ctx: memory,
        sessionID: "ses_test",
        summary: "Objective: useful prior work. Next: keep going.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })

      const result = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "digest", sessionID: "ses_test" }, ctx))
        },
      })

      expect(result.title).toContain("no results")
      expect(result.output).toContain("active session")
      expect(result.output).not.toContain("useful prior work")

      const decisions = await MemoryFiles.readDecisions(enabled.root)
      expect(decisions).toContain('"sessionID":"ses_test"')
      expect(decisions).toContain('"query":"sessionID=ses_test"')
      expect(decisions).toContain('"reason":"current_session_digest"')
    })
  })

  test("digest browsing skips empty continuation digests", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      await KiloMemory.enable({ ctx: memory })
      await KiloMemory.recordSession({
        ctx: memory,
        sessionID: "ses_useful",
        topic: "memory v0",
        summary: "Objective: finish memory v0. Next: verify extension recall behavior.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })
      await KiloMemory.recordSession({
        ctx: memory,
        sessionID: "ses_empty",
        topic: "continue recent work",
        summary: 'That session was empty, just another "continue recent work" request with no actual work done.',
        time: Date.UTC(2026, 0, 1, 0, 1),
      })

      const result = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "digest", limit: 5 }, ctx))
        },
      })

      expect(result.output).toContain("session=ses_useful")
      expect(result.output).toContain("verify extension recall behavior")
      expect(result.output).not.toContain("session=ses_empty")
    })
  })

  test("typed mode omits expired typed memory", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      const enabled = await KiloMemory.enable({ ctx: memory })
      await KiloMemory.apply({
        root: enabled.root,
        ops: [
          {
            action: "add",
            file: "project.md",
            section: "Facts",
            key: "birthday_party",
            text: "The team is planning the release birthday party for next Saturday.",
          },
        ],
      })
      const shown = await KiloMemory.show({ root: enabled.root })
      const id = MemoryFiles.metaKey({ file: "project.md", section: "Facts", key: "birthday_party" })
      const item = shown.metadata.items[id]
      if (!item) throw new Error("missing typed memory metadata")
      await MemoryFiles.writeMetadata(enabled.root, {
        ...shown.metadata,
        items: {
          ...shown.metadata.items,
          [id]: { ...item, staleAfter: Date.now() - 1 },
        },
      })

      const result = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "typed", query: "birthday party" }, ctx))
        },
      })

      expect(result.output).toContain("No typed memory matched the query.")
      expect(result.output).not.toContain("birthday_party")
    })
  })

  test("typed mode uses recency as a tiebreaker", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      const enabled = await KiloMemory.enable({ ctx: memory })
      await KiloMemory.apply({
        root: enabled.root,
        ops: [
          {
            action: "add",
            file: "project.md",
            section: "Facts",
            key: "newer_docs",
            text: "Memory docs describe current recall ranking.",
          },
          {
            action: "add",
            file: "project.md",
            section: "Facts",
            key: "older_docs",
            text: "Memory docs describe older recall ranking.",
          },
        ],
      })
      const shown = await KiloMemory.show({ root: enabled.root })
      const newer = MemoryFiles.metaKey({ file: "project.md", section: "Facts", key: "newer_docs" })
      const older = MemoryFiles.metaKey({ file: "project.md", section: "Facts", key: "older_docs" })
      await MemoryFiles.writeMetadata(enabled.root, {
        ...shown.metadata,
        items: {
          ...shown.metadata.items,
          [newer]: {
            ...shown.metadata.items[newer]!,
            updatedAt: Date.UTC(2026, 0, 2),
          },
          [older]: {
            ...shown.metadata.items[older]!,
            updatedAt: Date.UTC(2026, 0, 1),
          },
        },
      })

      const result = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(
            tool.execute({ mode: "typed", query: "memory docs recall ranking", limit: 1 }, ctx),
          )
        },
      })

      expect(result.output).toContain("newer_docs")
      expect(result.output).not.toContain("older_docs")
    })
  })

  test("search mode renders typed and digest memory without catalog mode", async () => {
    await using dir = await tmpdir({ git: true })
    await withConfig(path.join(dir.path, "global", ".kilo"), async () => {
      const memory = { directory: dir.path, worktree: dir.path }
      const enabled = await KiloMemory.enable({ ctx: memory })
      await KiloMemory.apply({
        root: enabled.root,
        ops: [
          {
            action: "add",
            file: "environment.md",
            section: "Commands",
            key: "cli_tests",
            text: "Run CLI tests from packages/opencode with bun test.",
          },
        ],
      })
      await KiloMemory.recordSession({
        ctx: memory,
        sessionID: "ses_catalog",
        topic: "catalog recall",
        summary: "Verified catalog mode for generated memory inspection.",
        time: Date.UTC(2026, 0, 1, 0, 0),
      })

      const result = await WithInstance.provide({
        directory: dir.path,
        fn: async () => {
          const info = await AppRuntime.runPromise(MemoryRecallTool)
          const tool = await AppRuntime.runPromise(info.init())
          return AppRuntime.runPromise(tool.execute({ mode: "search", query: "cli tests catalog recall", limit: 20 }, ctx))
        },
      })

      expect(result.title).toContain("Kilo memory search")
      expect(result.output).toContain("# Kilo Memory Recall")
      expect(result.output).toContain("## Typed Memory")
      expect(result.output).toContain("cli_tests")
      expect(result.output).toContain("## Session Digests")
      expect(result.output).toContain('topic="catalog recall"')

      const decisions = await MemoryFiles.readDecisions(enabled.root)
      expect(decisions).toContain('"summary":"memory recall returned')
    })
  })
})
