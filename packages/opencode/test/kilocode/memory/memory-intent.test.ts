import { describe, expect, test } from "bun:test"
import path from "path"
import { KiloMemory, MemoryPaths } from "../../../src/kilocode/memory"
import { MemoryIntent } from "../../../src/kilocode/memory/intent"
import type { MessageV2 } from "../../../src/session/message-v2"
import { tmpdir } from "../../fixture/fixture"

function msg(input: string) {
  return {
    info: { role: "user" },
    parts: [
      {
        type: "text",
        text: input,
      },
    ],
  } as MessageV2.WithParts
}

function ctx(dir: string) {
  return {
    directory: dir,
    worktree: dir,
  }
}

async function home<T>(dir: string, fn: () => Promise<T>) {
  const prior = process.env.KILO_TEST_HOME
  process.env.KILO_TEST_HOME = dir
  try {
    return await fn()
  } finally {
    if (prior === undefined) delete process.env.KILO_TEST_HOME
    if (prior !== undefined) process.env.KILO_TEST_HOME = prior
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

describe("memory intent", () => {
  test("parses natural remember, forget, and correction requests", () => {
    expect(MemoryIntent.parse("remember that tests run from packages/opencode")).toEqual({
      kind: "remember",
      ops: [
        {
          action: "add",
          file: "environment.md",
          key: "tests_run_from_packages_opencode",
          text: "tests run from packages/opencode",
        },
      ],
    })
    expect(MemoryIntent.parse('"Remember for this project: CLI memory tests run with bun test ./test/kilocode/memory"'))
      .toEqual({
        kind: "remember",
        ops: [
          {
            action: "add",
            file: "environment.md",
            key: "cli_tests_run_with_bun_test_test_kilocode",
            text: "CLI memory tests run with bun test ./test/kilocode/memory",
          },
        ],
      })

    expect(MemoryIntent.parse("forget stale root test command")).toEqual({
      kind: "forget",
      ops: [{ action: "remove", query: "stale root test command" }],
    })

    expect(MemoryIntent.parse("memory about test_command is wrong; actually run bun test from packages/opencode")).toEqual({
      kind: "correct",
      ops: [
        { action: "remove", query: "test_command" },
        {
          action: "add",
          file: "corrections.md",
          section: "Corrections",
          key: "run_bun_test_from_packages_opencode",
          text: "run bun test from packages/opencode",
        },
      ],
    })

    expect(MemoryIntent.parse("correction: root bun test should not be used")).toEqual({
      kind: "correct",
      ops: [
        {
          action: "add",
          file: "corrections.md",
          section: "Corrections",
          key: "root_bun_test_should_not_be_used",
          text: "root bun test should not be used",
        },
      ],
    })

    expect(MemoryIntent.parse("actually, remember tests run from packages/opencode")).toEqual({
      kind: "remember",
      ops: [
        {
          action: "add",
          file: "environment.md",
          key: "tests_run_from_packages_opencode",
          text: "tests run from packages/opencode",
        },
      ],
    })
    expect(MemoryIntent.parse("/remember to write concise commit messages")).toEqual({
      kind: "remember",
      ops: [
        {
          action: "add",
          file: "project.md",
          key: "write_concise_commit_messages",
          text: "write concise commit messages",
        },
      ],
    })
    expect(MemoryIntent.parse("save that feature work should maintain product parity across CLI, VS Code, and JetBrains"))
      .toEqual({
        kind: "remember",
        ops: [
          {
            action: "add",
            file: "project.md",
            section: "Constraints",
            key: "feature_work_should_maintain_product_parity_across_cli",
            text: "feature work should maintain product parity across CLI, VS Code, and JetBrains",
          },
        ],
      })
    expect(MemoryIntent.parse("/save that feature work needs product parity")).toBeUndefined()
    expect(MemoryIntent.parse("remember what command runs CLI tests?")).toBeUndefined()
    expect(MemoryIntent.parse("/remember what command runs CLI tests?")).toBeUndefined()
    expect(MemoryIntent.parse("save what command runs CLI tests?")).toBeUndefined()

    expect(MemoryIntent.parse("remember when touching shared files, add kilocode_change markers")).toEqual({
      kind: "remember",
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Constraints",
          key: "when_touching_shared_files_add_kilocode_change_markers",
          text: "when touching shared files, add kilocode_change markers",
        },
      ],
    })

    expect(MemoryIntent.parse("remember we should always favor writing kilo code paths")).toEqual({
      kind: "remember",
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Constraints",
          key: "we_should_always_favor_writing_kilo_code_paths",
          text: "we should always favor writing kilo code paths",
        },
      ],
    })

    expect(MemoryIntent.parse("remember kilo branch is yellow and black")).toEqual({
      kind: "remember",
      ops: [
        {
          action: "add",
          file: "project.md",
          key: "kilo_brand_yellow_black",
          text: "kilo branch is yellow and black",
        },
      ],
    })

    expect(MemoryIntent.parse("never use pnpm here")).toEqual({
      kind: "correct",
      ops: [
        {
          action: "add",
          file: "corrections.md",
          section: "Corrections",
          key: "pnpm",
          text: "Never use pnpm here.",
        },
      ],
    })

    expect(MemoryIntent.parse("always favor Kilo-owned source paths")).toEqual({
      kind: "remember",
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Constraints",
          key: "favor_kilo_owned_source_paths",
          text: "Always favor Kilo-owned source paths.",
        },
      ],
    })
  })

  test("skips natural intent while project memory is disabled", async () => {
    await using tmp = await tmpdir()
    const result = await home(path.join(tmp.path, "home"), () =>
      MemoryIntent.apply({
        ctx: ctx(tmp.path),
        message: msg("remember that tests run from packages/opencode"),
      }),
    )

    expect(result).toEqual({ skipped: true, reason: "disabled" })
  })

  test("skips natural intent before migration in eval off mode", async () => {
    await using tmp = await tmpdir()
    await home(path.join(tmp.path, "home"), async () => {
      const context = ctx(tmp.path)
      const old = MemoryPaths.legacyRoot({ ctx: context })
      const root = MemoryPaths.root({ ctx: context })
      await KiloMemory.enable({ root: old })

      const result = await evalMode("off", () =>
        MemoryIntent.apply({
          ctx: context,
          message: msg("remember that tests run from packages/opencode"),
        }),
      )

      expect(result).toEqual({ skipped: true, reason: "eval_off_capture_disabled" })
      expect(await Bun.file(MemoryPaths.files(old).state).exists()).toBe(true)
      expect(await Bun.file(MemoryPaths.files(root).state).exists()).toBe(false)
    })
  })

  test("applies natural correction before the model turn", async () => {
    await using tmp = await tmpdir()
    await home(path.join(tmp.path, "home"), async () => {
      const context = ctx(tmp.path)
      const root = MemoryPaths.root({ ctx: context })
      await KiloMemory.enable({ root })
      await KiloMemory.apply({
        root,
        ops: [{ action: "add", key: "test_command", text: "Run pnpm from the repo root." }],
      })

      const result = await MemoryIntent.apply({
        ctx: context,
        message: msg("memory about test_command is wrong; actually run bun test from packages/opencode"),
      })
      const shown = await KiloMemory.show({ root })

      expect(result).toEqual({ skipped: false, kind: "correct", operationCount: 2 })
      expect(shown.sources.project).not.toContain("Run pnpm")
      expect(shown.sources.corrections).toContain("- run_bun_test_from_packages_opencode :: run bun test")
      expect(shown.index).toContain("type=correction")
      expect(shown.index).toContain("run_bun_test_from_packages_opencode :: run bun test")
    })
  })
})
