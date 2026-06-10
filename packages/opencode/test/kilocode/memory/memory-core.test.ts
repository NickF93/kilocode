import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { lstat, mkdir, readdir, symlink } from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Bus } from "../../../src/bus"
import { Filesystem } from "../../../src/util/filesystem"
import { KilocodeSystemPrompt } from "../../../src/kilocode/system-prompt"
import {
  KiloMemory,
  MemoryDigest,
  MemoryEvents,
  MemoryFiles,
  MemoryIndexer,
  MemoryOperations,
  MemoryPaths,
  MemoryRecall,
  MemorySchema,
} from "../../../src/kilocode/memory"
import type { Provider } from "../../../src/provider/provider"
import type { InstanceContext } from "../../../src/project/instance"
import { ProjectID } from "../../../src/project/schema"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"

function model(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: 100_000,
      output: 32_000,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { id: "test-model", npm: "@ai-sdk/openai", url: "" },
    options: {},
  } as Provider.Model
}

function ctx(dir: string): InstanceContext {
  return {
    directory: dir,
    worktree: dir,
    project: {
      id: ProjectID.make("project"),
      worktree: dir,
      vcs: "git",
      time: { created: 0, updated: 0 },
      sandboxes: [],
    },
  } as InstanceContext
}

async function withConfig<T>(dir: string, fn: () => Promise<T> | T) {
  const prior = Global.Path.config
  ;(Global.Path as { config: string }).config = dir
  try {
    return await fn()
  } finally {
    ;(Global.Path as { config: string }).config = prior
  }
}

async function withHome<T>(dir: string, fn: () => Promise<T> | T) {
  const prior = process.env.KILO_TEST_HOME
  process.env.KILO_TEST_HOME = dir
  try {
    return await fn()
  } finally {
    if (prior === undefined) delete process.env.KILO_TEST_HOME
    if (prior !== undefined) process.env.KILO_TEST_HOME = prior
  }
}

function expectRoot(root: string, dir: string, name: string) {
  expect(path.dirname(root)).toBe(path.join(dir, "memory"))
  expect(path.basename(root)).toMatch(new RegExp(`^${name}-[a-f0-9]{12}$`))
}

describe("KiloMemory core", () => {
  test("resolves project memory to global .kilo repo folder", async () => {
    await using tmp = await tmpdir()
    await withConfig(path.join(tmp.path, ".kilo"), () => {
      const root = MemoryPaths.root({
        ctx: {
          directory: path.join("/repo", "packages", "opencode"),
          worktree: "/repo",
        },
      })

      expectRoot(root, path.join(tmp.path, ".kilo"), "repo")
      expect(root).not.toContain(path.join("/repo", ".kilo", "memory"))
    })
  })

  test("resolves project memory under home .kilo when global config is xdg", async () => {
    await using tmp = await tmpdir()
    const home = path.join(tmp.path, "home")
    await withConfig(path.join(tmp.path, "xdg", "kilo"), () =>
      withHome(home, () => {
        const root = MemoryPaths.root({
          ctx: {
            directory: path.join("/repo", "packages", "opencode"),
            worktree: "/repo",
          },
        })

        expectRoot(root, path.join(home, ".kilo"), "repo")
        expect(root).not.toContain(path.join(tmp.path, "xdg", "kilo", "memory"))
        expect(root).not.toContain(path.join("/repo", ".kilo", "memory"))
      }),
    )
  })

  test("resolves linked worktree project memory to global main-checkout folder", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees", "work")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${git}\n`)

    await withConfig(global, () => {
      const root = MemoryPaths.root({
        ctx: {
          directory: work,
          worktree: work,
        },
      })

      expectRoot(root, global, "main")
      expect(root).not.toContain(path.join(main, ".kilo", "memory"))
      expect(root).not.toContain(path.join(work, ".kilo", "memory"))
    })
  })

  test("enable from linked worktree writes repo state shared by sibling worktrees", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const next = path.join(tmp.path, "next")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "work", "commondir"), "../..\n")
    await Filesystem.write(path.join(git, "next", "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${path.join(git, "work")}\n`)
    await Filesystem.write(path.join(next, ".git"), `gitdir: ${path.join(git, "next")}\n`)

    await withConfig(global, async () => {
      await KiloMemory.enable({ ctx: { directory: work, worktree: work } })
      await KiloMemory.configure({ ctx: { directory: work, worktree: work }, settings: { autoConsolidate: false } })
      const status = await KiloMemory.status({ ctx: { directory: next, worktree: next } })

      expectRoot(status.root, global, "main")
      expect(status.state.enabled).toBe(true)
      expect(status.state.autoConsolidate).toBe(false)
      expect(await Filesystem.exists(path.join(main, ".kilo", "memory", "state.json"))).toBe(false)
      expect(await Filesystem.exists(path.join(work, ".kilo", "memory", "state.json"))).toBe(false)
      expect(await Filesystem.exists(path.join(next, ".kilo", "memory", "state.json"))).toBe(false)
    })
  })

  test("removes empty legacy worktree memory scaffold after migration", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees", "work")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${git}\n`)
    const context = { directory: work, worktree: work }
    const old = MemoryPaths.legacyRoot({ ctx: context })
    await Filesystem.write(MemoryPaths.files(old).ignore, "*\n!.gitignore\n")
    await Filesystem.write(MemoryPaths.files(old).metadata, '{ "version": 1, "items": {} }\n')

    await withConfig(global, async () => {
      const root = await KiloMemory.prepare({ ctx: context })

      expectRoot(root, global, "main")
      expect(await Filesystem.exists(old)).toBe(false)
      expect(await Filesystem.exists(MemoryPaths.files(root).ignore)).toBe(true)
    })
  })

  test("migrates legacy worktree memory to global repo folder", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees", "work")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${git}\n`)
    const context = { directory: work, worktree: work }
    const old = MemoryPaths.legacyRoot({ ctx: context })
    await KiloMemory.enable({ root: old })
    await KiloMemory.apply({
      root: old,
      ops: [{ action: "add", key: "test_command", text: "Run CLI tests from packages/opencode." }],
    })
    await MemoryFiles.decide(old, { kind: "typed", result: "saved", sessionID: "legacy", operationCount: 1 })

    await withConfig(global, async () => {
      const root = await KiloMemory.prepare({ ctx: context })
      const shown = await KiloMemory.show({ root })
      const manifest = JSON.parse(await Filesystem.readText(MemoryPaths.files(root).manifest)) as Record<string, string>

      expectRoot(root, global, "main")
      expect(manifest.display).toBe("main")
      expect(manifest.canonical).toBe(main)
      expect(await Filesystem.exists(MemoryPaths.files(old).state)).toBe(true)
      expect(shown.sources.project).toContain("test_command")
      expect(shown.changes).toContain("migrate from=")
      expect(shown.decisions).toContain('"sessionID":"legacy"')
    })
  })

  test("enables migrated legacy memory when no legacy state exists", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees", "work")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${git}\n`)
    const context = { directory: work, worktree: work }
    const old = MemoryPaths.legacyRoot({ ctx: context })
    await Filesystem.write(
      MemoryPaths.files(old).project,
      "# Project Memory\n\n## Facts\n- branch_rule :: Prefer Kilo-owned paths for new code.\n",
    )

    await withConfig(global, async () => {
      const root = await KiloMemory.prepare({ ctx: context })
      const shown = await KiloMemory.show({ root })

      expect(shown.state.enabled).toBe(true)
      expect(shown.state.autoInject).toBe(true)
      expect(shown.sources.project).toContain("branch_rule")
      expect(shown.index).toContain("branch_rule")
    })
  })

  test("migrates structured legacy memory files with redaction", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees", "work")
    const secret = "sk-abcdefghijklmnopqrstuvwxyz"
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${git}\n`)
    const context = { directory: work, worktree: work }
    const old = MemoryPaths.legacyRoot({ ctx: context })
    await Filesystem.write(
      MemoryPaths.files(old).metadata,
      `${JSON.stringify({
        version: 1,
        items: {
          "project.md:Facts:api_key": {
            file: "project.md",
            section: "Facts",
            key: "api_key",
            text: `{"api_key":"${secret}"}`,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      })}\n`,
    )
    await Filesystem.write(
      MemoryPaths.files(old).decisions,
      `${JSON.stringify({ kind: "typed", result: "saved", summary: `{"api_key":"${secret}"}` })}\n`,
    )

    await withConfig(global, async () => {
      const root = await KiloMemory.prepare({ ctx: context })
      const paths = MemoryPaths.files(root)
      const metadata = JSON.parse(await Filesystem.readText(paths.metadata)) as MemoryFiles.Metadata
      const decisions = (await Filesystem.readText(paths.decisions)).trim().split("\n").map((line) => JSON.parse(line))

      expect(metadata.items["project.md:Facts:api_key"].text).toBe("[redacted]")
      expect(decisions[0].summary).toBe("[redacted]")
      expect(await Filesystem.readText(paths.metadata)).not.toContain(secret)
      expect(await Filesystem.readText(paths.decisions)).not.toContain(secret)
    })
  })

  test("migrates only known legacy memory files", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees", "work")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${git}\n`)
    const context = { directory: work, worktree: work }
    const old = MemoryPaths.legacyRoot({ ctx: context })
    await KiloMemory.enable({ root: old })
    await KiloMemory.apply({
      root: old,
      ops: [{ action: "add", key: "test_command", text: "Run CLI tests from packages/opencode." }],
    })
    await Filesystem.write(path.join(old, "package.json"), "{}\n")
    await Filesystem.write(path.join(old, "node_modules", "junk.txt"), "junk\n")

    await withConfig(global, async () => {
      const root = await KiloMemory.prepare({ ctx: context })
      const shown = await KiloMemory.show({ root })

      expect(shown.sources.project).toContain("test_command")
      expect(await Filesystem.exists(path.join(root, "package.json"))).toBe(false)
      expect(await Filesystem.exists(path.join(root, "node_modules"))).toBe(false)
      expect(await Filesystem.exists(path.join(old, "package.json"))).toBe(true)
    })
  })

  test("migrates legacy repo memory to global repo folder", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees", "work")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${git}\n`)
    const context = { directory: work, worktree: work }
    const old = MemoryPaths.projectLegacyRoot({ ctx: context })
    await KiloMemory.enable({ root: old })
    await KiloMemory.apply({
      root: old,
      ops: [{ action: "add", key: "test_command", text: "Run CLI tests from packages/opencode." }],
    })

    await withConfig(global, async () => {
      const root = await KiloMemory.prepare({ ctx: context })
      const shown = await KiloMemory.show({ root })

      expectRoot(root, global, "main")
      expect(await Filesystem.exists(MemoryPaths.files(old).state)).toBe(true)
      expect(shown.sources.project).toContain("test_command")
      expect(shown.changes).toContain("migrate from=")
    })
  })

  test("migrates previous global hashed memory to global repo folder", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const global = path.join(tmp.path, "global", ".kilo")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    const context = { directory: main, worktree: main }

    await withConfig(global, async () => {
      const old = MemoryPaths.configLegacyRoot({ ctx: context })
      await KiloMemory.enable({ root: old })
      await KiloMemory.apply({
        root: old,
        ops: [{ action: "add", key: "test_command", text: "Run CLI tests from packages/opencode." }],
      })

      const root = await KiloMemory.prepare({ ctx: context })
      const shown = await KiloMemory.show({ root })

      expectRoot(root, global, "main")
      expect(await Filesystem.exists(MemoryPaths.files(old).state)).toBe(true)
      expect(shown.sources.project).toContain("test_command")
      expect(shown.changes).toContain("migrate from=")
    })
  })

  test("migrates legacy enabled state into existing global memory root", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees", "work")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${git}\n`)
    const context = { directory: work, worktree: work }
    const old = MemoryPaths.legacyRoot({ ctx: context })
    await KiloMemory.enable({ root: old })
    await KiloMemory.apply({
      root: old,
      ops: [{ action: "add", key: "test_command", text: "Run CLI tests from packages/opencode." }],
    })
    await MemoryFiles.decide(old, { kind: "typed", result: "saved", sessionID: "legacy", operationCount: 1 })

    await withConfig(global, async () => {
      const root = MemoryPaths.root({ ctx: context })
      await MemoryFiles.scaffold(root)
      await KiloMemory.prepare({ ctx: context })
      const shown = await KiloMemory.show({ root })

      expect(shown.state.enabled).toBe(true)
      expect(shown.sources.project).toContain("test_command")
      expect(shown.index).toContain("test_command")
      expect(shown.changes).toContain("migrate missing from=")
      expect(shown.decisions).toContain('"sessionID":"legacy"')
    })
  })

  test("repo legacy state wins over stale worktree legacy state", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "main")
    const work = path.join(tmp.path, "work")
    const global = path.join(tmp.path, "global", ".kilo")
    const git = path.join(main, ".git", "worktrees", "work")
    await Filesystem.write(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(git, "commondir"), "../..\n")
    await Filesystem.write(path.join(work, ".git"), `gitdir: ${git}\n`)
    const context = { directory: work, worktree: work }
    const stale = MemoryPaths.legacyRoot({ ctx: context })
    const repo = MemoryPaths.projectLegacyRoot({ ctx: context })
    await KiloMemory.enable({ root: stale })
    await KiloMemory.disable({ root: stale })
    await KiloMemory.enable({ root: repo })
    await KiloMemory.configure({ root: repo, settings: { autoConsolidate: true } })

    await withConfig(global, async () => {
      const root = await KiloMemory.prepare({ ctx: context })
      const shown = await KiloMemory.show({ root })

      expect(shown.state.enabled).toBe(true)
      expect(shown.state.autoConsolidate).toBe(true)
    })
  })

  test("resolves non-git project memory to global directory folder", async () => {
    await using tmp = await tmpdir()
    await withConfig(path.join(tmp.path, ".kilo"), () => {
      const root = MemoryPaths.root({
        ctx: {
          directory: "/workspace",
          worktree: "/",
        },
      })

      expectRoot(root, path.join(tmp.path, ".kilo"), "workspace")
      expect(root).not.toContain(path.join("/workspace", ".kilo", "memory"))
    })
  })

  test("same-basename repos do not share global memory roots", async () => {
    await using tmp = await tmpdir()
    const global = path.join(tmp.path, "global", ".kilo")
    const first = path.join(tmp.path, "first", "repo")
    const second = path.join(tmp.path, "second", "repo")
    await Filesystem.write(path.join(first, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Filesystem.write(path.join(second, ".git", "HEAD"), "ref: refs/heads/main\n")

    await withConfig(global, () => {
      const one = MemoryPaths.root({ ctx: { directory: first, worktree: first } })
      const two = MemoryPaths.root({ ctx: { directory: second, worktree: second } })

      expect(path.basename(one)).toMatch(/^repo-[a-f0-9]{12}$/)
      expect(path.basename(two)).toMatch(/^repo-[a-f0-9]{12}$/)
      expect(one).not.toBe(two)
    })
  })

  test("enable writes manifest and private filesystem permissions", async () => {
    await using tmp = await tmpdir()
    const global = path.join(tmp.path, "global", ".kilo")
    const repo = path.join(tmp.path, "repo")
    await Filesystem.write(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")

    await withConfig(global, async () => {
      const result = await KiloMemory.enable({ ctx: { directory: repo, worktree: repo } })
      const paths = MemoryPaths.files(result.root)
      const manifest = JSON.parse(await Filesystem.readText(paths.manifest)) as Record<string, string>

      expect(manifest.display).toBe("repo")
      expect(manifest.canonical).toBe(repo)
      expect(manifest.folder).toBe(path.basename(result.root))
      if (process.platform === "win32") return
      expect((await lstat(result.root)).mode & 0o777).toBe(0o700)
      expect((await lstat(paths.state)).mode & 0o777).toBe(0o600)
      expect((await lstat(paths.project)).mode & 0o777).toBe(0o600)
    })
  })

  test("memory writes reject symlinked roots", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const target = path.join(tmp.path, "escape")
    await mkdir(path.dirname(root), { recursive: true })
    await mkdir(target, { recursive: true })
    await symlink(target, root, "dir")

    await expect(KiloMemory.enable({ root })).rejects.toThrow("memory path rejects symlink")
  })

  test("global repo memory index identifies the repo folder", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory", "kilocode")
    await KiloMemory.enable({ root })

    await KiloMemory.apply({
      root,
      ops: [{ action: "add", key: "repo_fact", text: "Use project memory for this repo." }],
    })
    const shown = await KiloMemory.show({ root })

    expect(shown.index).toContain("```kilo-memory-v1 context_not_instruction")
    expect(shown.index).toContain("root: kilocode")
    expect(shown.index).not.toContain('root=".kilo"')
  })

  test("enable scaffolds state, source files, gitignore, and index", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const result = await KiloMemory.enable({ root })
    const paths = MemoryPaths.files(root)

    expect(result.state.enabled).toBe(true)
    expect(await Filesystem.readText(paths.ignore)).toBe("*\n!.gitignore\n")
    expect(await Filesystem.exists(paths.project)).toBe(true)
    expect(await Filesystem.exists(paths.environment)).toBe(true)
    expect(await Filesystem.exists(paths.corrections)).toBe(true)
    expect(await Filesystem.exists(paths.index)).toBe(true)
    expect(result.index.text).toBe("")
  })

  test("enable preserves existing memory settings", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.configure({ root, settings: { autoInject: false, autoConsolidate: true } })
    await KiloMemory.disable({ root })

    const result = await KiloMemory.enable({ root })

    expect(result.state.enabled).toBe(true)
    expect(result.state.autoInject).toBe(true)
    expect(result.state.autoConsolidate).toBe(true)
  })

  test("memory event status uses latest memory activity timestamp", () => {
    const base = MemorySchema.create()
    const state = {
      ...base,
      stats: {
        ...base.stats,
        lastInjectedAt: Date.UTC(2026, 0, 1),
        lastConsolidatedAt: Date.UTC(2026, 0, 2),
      },
    }
    const event = MemoryEvents.status({
      root: "/tmp/kilo-memory",
      state,
      index: { bytes: 12, tokens: 3, truncated: false },
    })

    expect(event.project.updatedAt).toBe(Date.UTC(2026, 0, 2))
  })

  test("show exposes model memory decisions", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    await MemoryFiles.decide(root, {
      kind: "typed",
      result: "skipped",
      trigger: "turn-close",
      sessionID: "session",
      reason: "transient",
      skipped: [{ reason: "transient", text: "checked git status" }],
    })
    const shown = await KiloMemory.show({ root })

    expect(shown.decisions).toContain('"kind":"typed"')
    expect(shown.decisions).toContain('"result":"skipped"')
    expect(shown.decisions).toContain('"reason":"transient"')
    expect(shown.decisions).not.toContain('"raw":')
    expect(await Filesystem.exists(path.join(root, "raw"))).toBe(false)
  })

  test("decision audit redacts secret-like text", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    await MemoryFiles.decide(root, {
      kind: "recall",
      result: "skipped",
      query: 'check memory about "api_key": "sk-abcdefghijklmnopqrstuvwxyz"',
      operations: [{ action: "remove", query: "token=sk-abcdefghijklmnopqrstuvwxyz" }],
      skipped: [
        {
          reason: "secret",
          text: "password=hunter2 -----BEGIN OPENSSH PRIVATE KEY----- abc -----END OPENSSH PRIVATE KEY-----",
        },
      ],
    })
    const decisions = await MemoryFiles.readDecisions(root)

    expect(decisions).toContain("[redacted]")
    expect(decisions).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(decisions).not.toContain("hunter2")
    expect(decisions).not.toContain("OPENSSH PRIVATE KEY")
  })

  test("changes log redacts secret-like text", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
    await KiloMemory.enable({ root })

    await MemoryFiles.append(root, `provider error "api_key": "${secret}"`)
    const shown = await KiloMemory.show({ root })

    expect(shown.changes).toContain("[redacted]")
    expect(shown.changes).not.toContain(secret)
  })

  test("session digests redact secret-like text", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
    await KiloMemory.enable({ root })

    await KiloMemory.recordSession({
      root,
      sessionID: "ses_secret",
      topic: `secret ${secret}`,
      summary: `User pasted api_key=${secret}.`,
      time: Date.UTC(2026, 0, 1),
    })
    const shown = await KiloMemory.show({ root })

    expect(shown.index).toContain("[redacted]")
    expect(shown.index).not.toContain(secret)
  })

  test("corrupt state and metadata recover to safe defaults", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    const paths = MemoryPaths.files(root)
    await Filesystem.write(paths.state, "{")
    await Filesystem.write(paths.metadata, "{")

    const state = await MemoryFiles.readState(root)
    const metadata = await MemoryFiles.readMetadata(root)
    const files = await readdir(root)
    const shown = await KiloMemory.show({ root })

    expect(state.enabled).toBe(false)
    expect(metadata.items).toEqual({})
    expect(files.some((file) => file.startsWith("state.json.bad-"))).toBe(true)
    expect(files.some((file) => file.startsWith("metadata.json.bad-"))).toBe(true)
    expect(shown.changes).toContain("recover state.json")
    expect(shown.changes).toContain("recover metadata.json")
  })

  test("state parser rejects non-finite nullable stats", () => {
    const state = MemorySchema.parse({
      stats: {
        lastInjectedAt: Number.NaN,
        lastConsolidatedAt: Number.POSITIVE_INFINITY,
      },
    })

    expect(state.stats.lastInjectedAt).toBeNull()
    expect(state.stats.lastConsolidatedAt).toBeNull()
  })

  test("metadata parser rejects invalid timestamps", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    const started = Date.now()
    const paths = MemoryPaths.files(root)
    await Filesystem.write(
      paths.metadata,
      `${JSON.stringify({
        version: 1,
        items: {
          bad: {
            file: "project.md",
            section: "Facts",
            key: "bad",
            text: "Invalid metadata timestamps should be normalized.",
            createdAt: -1,
            updatedAt: -2,
            staleAfter: -3,
          },
        },
      })}\n`,
    )

    const data = await MemoryFiles.readMetadata(root)
    const item = data.items.bad

    expect(item).toBeDefined()
    expect(item!.createdAt).toBeGreaterThanOrEqual(started)
    expect(item!.updatedAt).toBeGreaterThanOrEqual(started)
    expect(item!.staleAfter).toBeUndefined()
  })

  test("audit logs preserve concurrent append decisions", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    await Promise.all(
      Array.from({ length: 30 }, (_, idx) =>
        MemoryFiles.decide(root, {
          kind: "typed",
          result: "saved",
          sessionID: `ses_${idx}`,
          operationCount: 1,
        }),
      ),
    )
    const decisions = await MemoryFiles.readDecisions(root)

    for (const idx of Array.from({ length: 30 }, (_, item) => item)) {
      expect(decisions).toContain(`"sessionID":"ses_${idx}"`)
    }
  })

  test("settings update injection and consolidation", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    await KiloMemory.configure({
      root,
      settings: {
        autoInject: false,
        autoConsolidate: false,
      },
    })
    const state = await MemoryFiles.readState(root)

    expect(state.autoInject).toBe(false)
    expect(state.autoConsolidate).toBe(false)
  })

  test("recall tool is unavailable when automatic injection is disabled", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.configure({ root, settings: { autoInject: false } })

    expect(await KiloMemory.toolEnabled({ root })).toBe(false)
    expect(await KiloMemory.recall({ root, query: "what did memory say about tests?" })).toBeUndefined()
  })

  test("missing or disabled state returns no context blocks", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const empty = await KiloMemory.context({ root })

    expect(empty.blocks).toHaveLength(0)
    expect(empty.meta.enabled).toBe(false)
    expect(await Filesystem.exists(root)).toBe(false)

    await KiloMemory.enable({ root })
    const active = await KiloMemory.context({ root })
    expect(active.blocks).toHaveLength(0)

    await KiloMemory.disable({ root })
    const disabled = await KiloMemory.context({ root })

    expect(disabled.blocks).toHaveLength(0)
    expect(disabled.meta.enabled).toBe(false)
  })

  test("missing or disabled state does not enable the memory recall tool", async () => {
    await using tmp = await tmpdir()
    const ctx = { directory: tmp.path, worktree: tmp.path }
    const root = MemoryPaths.root({ ctx })

    expect(await KiloMemory.toolEnabled({ ctx })).toBe(false)
    expect(await Filesystem.exists(root)).toBe(false)

    await KiloMemory.enable({ ctx })
    expect(await KiloMemory.toolEnabled({ ctx })).toBe(true)

    await KiloMemory.disable({ ctx })
    expect(await KiloMemory.toolEnabled({ ctx })).toBe(false)
  })

  test("memory recall tool availability uses migrated legacy state", async () => {
    await using tmp = await tmpdir()
    const ctx = { directory: tmp.path, worktree: tmp.path }
    const old = MemoryPaths.legacyRoot({ ctx })
    const root = MemoryPaths.root({ ctx })
    await KiloMemory.enable({ root: old })

    expect(await KiloMemory.toolEnabled({ ctx })).toBe(true)
    expect(await Filesystem.exists(MemoryPaths.files(root).state)).toBe(true)
  })

  test("apply upserts source lines and forget removes them from source and index", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    const scaffolded = await KiloMemory.show({ root })

    expect(scaffolded.sources.project).toContain("## Constraints")
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "test_command",
          text: "Run bun test from packages/opencode, not from the repo root.",
        },
      ],
    })

    const shown = await KiloMemory.show({ root })
    expect(shown.sources.project).toContain("- test_command :: Run bun test from packages/opencode")
    expect(shown.index).toContain("test_command")

    const result = await KiloMemory.forget({ root, query: "Test Command" })
    const next = await KiloMemory.show({ root })

    expect(result.removed).toBe(1)
    expect(next.sources.project).not.toContain("test_command")
    expect(next.index).not.toContain("test_command")
  })

  test("apply normalizes unsafe memory keys", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    const result = await KiloMemory.apply({
      root,
      ops: [{ action: "add", key: "Test Command :: CLI", text: "Run bun test from packages/opencode." }],
    })
    const shown = await KiloMemory.show({ root })

    expect(result.operationCount).toBe(1)
    expect(shown.sources.project).toContain("- test_command_cli :: Run bun test from packages/opencode.")
    expect(shown.index).toContain("test_command_cli")
  })

  test("apply dedupes equivalent source memory saves", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    const first = await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Constraints",
          key: "feature_parity",
          text: "Feature work needs product parity across CLI, VS Code, and JetBrains.",
        },
      ],
    })
    const second = await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Constraints",
          key: "feature_work_parity",
          text: "Feature work should maintain product parity across CLI, VS Code, and JetBrains.",
        },
      ],
    })
    const third = await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Constraints",
          key: "same_feature_work_parity",
          text: "Feature work should maintain product parity across CLI, VS Code, and JetBrains.",
        },
      ],
    })
    const shown = await KiloMemory.show({ root })

    expect(first.added).toBe(1)
    expect(second.added).toBe(1)
    expect(third.added).toBe(0)
    expect(third.operationCount).toBe(0)
    expect(shown.sources.project.match(/product parity/g)?.length).toBe(1)
    expect(shown.sources.project).toContain("- feature_parity :: Feature work should maintain product parity")
    expect(shown.sources.project).not.toContain("feature_work_parity")
  })

  test("explicit memory events include session id when provided", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const events: MemoryEvents.Status[] = []
    await KiloMemory.enable({ root })

    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const off = Bus.subscribe(MemoryEvents.Updated, (event) => events.push(event.properties))
        try {
          await KiloMemory.apply({
            root,
            sessionID: "ses_memory_event",
            tokens: 1234,
            ops: [{ action: "add", key: "event_route", text: "Route explicit memory events by session." }],
          })
        } finally {
          off()
        }
      },
    })

    expect(events.some((event) => event.sessionID === "ses_memory_event" && event.detail?.type === "saved")).toBe(true)
    expect(events.find((event) => event.sessionID === "ses_memory_event" && event.detail?.type === "saved")?.detail?.tokens)
      .toBeUndefined()
    const decisions = await MemoryFiles.readDecisions(root)
    expect(decisions).toContain('"trigger":"explicit"')
    expect(decisions).toContain('"sessionID":"ses_memory_event"')
    expect(decisions).toContain('"llm":false')
  })

  test("explicit forget reports removals without save wording", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const events: MemoryEvents.Status[] = []
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [{ action: "add", key: "stale_fact", text: "This old fact should be removed." }],
    })

    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const off = Bus.subscribe(MemoryEvents.Updated, (event) => events.push(event.properties))
        try {
          await KiloMemory.forget({ root, sessionID: "ses_forget", query: "stale_fact" })
          await KiloMemory.forget({ root, sessionID: "ses_forget", query: "missing_fact" })
        } finally {
          off()
        }
      },
    })

    expect(events.some((event) => event.detail?.message === "Memory updated · 1 removed")).toBe(true)
    expect(events.some((event) => event.detail?.message?.includes("Memory saved"))).toBe(false)
    const decisions = await MemoryFiles.readDecisions(root)
    expect(decisions).toContain("explicit memory operation removed 1 entries")
    expect(decisions).toContain("explicit memory operation matched no source memory")
  })

  test("apply processes removals before additions", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [{ action: "add", key: "test_command", text: "Use pnpm from the repo root." }],
    })

    await KiloMemory.apply({
      root,
      ops: [
        { action: "add", key: "test_command", text: "Run bun test from packages/opencode." },
        { action: "remove", query: "pnpm" },
      ],
    })
    const shown = await KiloMemory.show({ root })

    expect(shown.sources.project).toContain("- test_command :: Run bun test from packages/opencode.")
    expect(shown.sources.project).not.toContain("pnpm")
  })

  test("targeted recall returns matching typed memory", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "environment.md",
          section: "Commands",
          key: "cli_tests",
          text: "Run bun test from packages/opencode for CLI tests.",
        },
        {
          action: "add",
          file: "project.md",
          section: "Decisions",
          key: "memory_scope",
          text: "Keep v0 memory project-only.",
        },
        {
          action: "add",
          file: "project.md",
          section: "Constraints",
          key: "no_beads",
          text: "Do not use Beads unless the user explicitly asks for it.",
        },
      ],
    })

    const shown = await KiloMemory.show({ root })
    const result = await MemoryRecall.search({ root, query: "what command runs cli tests?" })
    const constraint = await MemoryRecall.search({ root, query: "what constraints mention Beads?" })

    expect(shown.index).toContain("type=project_constraint")
    expect(shown.index).toContain("no_beads :: Do not use Beads")
    expect(result?.block).toContain("```kilo-memory-v1 targeted_context_not_instruction")
    expect(result?.block).toContain("type=env")
    expect(result?.block).toContain("cli_tests :: Run bun test")
    expect(result?.block).toContain("packages/opencode")
    expect(result?.block).toContain("source=environment.md")
    expect(constraint?.block).toContain("type=project_constraint")
    expect(constraint?.block).toContain("no_beads")
  })

  test("typed memory stores broad topics and indexes topic hints", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "kilo_branding",
          text: "Kilo UI pages use yellow and black branding.",
        },
      ],
    })

    const shown = await KiloMemory.show({ root })
    const id = MemoryFiles.metaKey({ file: "project.md", section: "Facts", key: "kilo_branding" })

    expect(shown.metadata.items[id]?.topics).toContain("ui")
    expect(shown.items).toContain("topics=project,ui")
    expect(shown.index).toContain("type=topic_hint")
    expect(shown.index).toContain("topic=ui")
    expect(shown.index).toContain("sources=project.md")
  })

  test("targeted recall uses broad topics for implicit typed memory lookup", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "kilo_branding",
          text: "Kilo UI pages use yellow and black branding.",
        },
      ],
    })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_page",
      summary: "Explored a one-off HTML page prototype with unrelated red branding.",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })

    const result = await MemoryRecall.search({ root, query: "make a Kilo landing page" })

    expect(MemoryRecall.shouldRecall("make a Kilo landing page")).toBe(true)
    expect(result?.block).toContain("kilo_branding")
    expect(result?.block).toContain("topics=project,ui")
    expect(result?.block).not.toContain("session=ses_page")
  })

  test("targeted recall uses topic hints for plain questions", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "kilo_branding",
          text: "Kilo UI pages use yellow and black branding.",
        },
      ],
    })

    const result = await MemoryRecall.search({ root, query: "what is Kilo color?" })

    expect(MemoryRecall.shouldRecall("what is Kilo color?")).toBe(true)
    expect(result?.block).toContain("kilo_branding")
    expect(result?.block).toContain("yellow and black")
  })

  test("targeted recall handles environment intent without memory phrasing", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
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
          section: "Tooling",
          key: "package_manager",
          text: "Use Bun for package scripts.",
        },
        {
          action: "add",
          file: "environment.md",
          section: "Paths",
          key: "main_checkout",
          text: "Linked worktrees share the global project memory folder for the canonical repo.",
        },
      ],
    })

    const launch = await MemoryRecall.search({ root, query: "how do I launch this repo locally?" })
    const tooling = await MemoryRecall.search({
      root,
      query: "which package manager and tooling does this project use?",
    })
    const paths = await MemoryRecall.search({ root, query: "where are important workspace paths?" })

    expect(launch?.block).toContain("type=env")
    expect(launch?.block).toContain("dev_command")
    expect(tooling?.block).toContain("package_manager")
    expect(paths?.block).toContain("main_checkout")
  })

  test("targeted recall handles natural repo exploration phrasing", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "environment.md",
          section: "Commands",
          key: "typecheck_command",
          text: "Run bun turbo typecheck from the repo root.",
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
          key: "package_manager",
          text: "Use Bun for package management and package scripts.",
        },
      ],
    })

    const built = await MemoryRecall.search({ root, query: "I'd like to explore how this repo is built." })
    const tasks = await MemoryRecall.search({ root, query: "What commands are used for common dev tasks?" })
    const tools = await MemoryRecall.search({ root, query: "What stack and tools does this repo use?" })

    expect(built?.block).toContain("build_orchestration")
    expect(tasks?.block).toContain("typecheck_command")
    expect(tools?.block).toContain("package_manager")
  })

  test("targeted recall skips save-like prompts", async () => {
    expect(
      MemoryRecall.shouldRecall(
        "i found that the extension package should run unit tests with bun run test:unit from packages/kilo-vscode",
      ),
    ).toBe(false)
    expect(MemoryRecall.shouldRecall("remember we should favor writing kilo code paths")).toBe(false)
    expect(MemoryRecall.shouldRecall("/remember to write concise commit messages")).toBe(false)
    expect(MemoryRecall.shouldRecall("save that feature work should maintain product parity")).toBe(false)
    expect(
      MemoryRecall.shouldRecall(
        "i will stop investigating the plan mode and evaluate if the current memory implementation usage is counting towards the token count we see in the sidebar",
      ),
    ).toBe(false)
    expect(
      MemoryRecall.shouldRecall(
        "i will stop investigating the plan mode and evaluate if the current memory implementaton usage is counting towards the token count we see in the sidebar",
      ),
    ).toBe(false)
    expect(MemoryRecall.shouldRecall("i think memory is becoming useful")).toBe(false)
    expect(MemoryRecall.shouldRecall("what did we establish about vscode unit tests?")).toBe(true)
    expect(MemoryRecall.shouldRecall("actually, what did we decide about vscode unit tests?")).toBe(true)
    expect(MemoryRecall.shouldRecall("what was the duplicate PR we found?")).toBe(true)
    expect(MemoryRecall.shouldRecall("recall vscode unit tests")).toBe(true)
    expect(MemoryRecall.shouldRecall("remember what command runs CLI tests?")).toBe(true)
    expect(MemoryRecall.shouldRecall("is there memory about vscode unit tests?")).toBe(true)
    expect(MemoryRecall.shouldRecall("what did memory say about prompt injection?")).toBe(true)
    expect(MemoryRecall.shouldRecall("where did we end?")).toBe(true)
    expect(MemoryRecall.shouldRecall("what were we investigating before?")).toBe(true)
    expect(MemoryRecall.direct("recall vscode unit tests")).toBe(true)
    expect(MemoryRecall.direct("where were we?")).toBe(false)
    expect(MemoryRecall.explicit("recall vscode unit tests")).toBe(true)
    expect(MemoryRecall.explicit("what is kilo brand?")).toBe(false)
  })

  test("targeted recall dedupes lower-value session hits when typed memory answers", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
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
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_vscode_tests",
      summary: "Established VS Code unit tests use bun run test:unit from packages/kilo-vscode.",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })

    const result = await MemoryRecall.search({ root, query: "what did we establish about vscode unit tests?" })

    expect(result?.block).toContain("type=env")
    expect(result?.block).toContain("vscode_unit_tests")
    expect(result?.block).not.toContain("session=ses_vscode_tests")
  })

  test("targeted recall uses recency as a tiebreaker", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
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
    const shown = await KiloMemory.show({ root })
    const newer = MemoryFiles.metaKey({ file: "project.md", section: "Facts", key: "newer_docs" })
    const older = MemoryFiles.metaKey({ file: "project.md", section: "Facts", key: "older_docs" })
    await MemoryFiles.writeMetadata(root, {
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

    const result = await MemoryRecall.search({ root, query: "memory docs recall ranking", limit: 1 })

    expect(result?.block).toContain("newer_docs")
    expect(result?.block).not.toContain("older_docs")
  })

  test("targeted recall ranks session digests first for continuation prompts", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "memory_v0_work",
          text: "Current project work is memory v0 polishing.",
        },
      ],
    })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_recent",
      topic: "memory recall ranking",
      summary: "Objective: tighten memory recall ranking. Next: validate continuation behavior.",
      time: Date.UTC(2026, 0, 2),
    })

    const result = await MemoryRecall.search({ root, query: "where did we end?" })

    expect(result?.hits[0]?.type).toBe("digest")
    expect(result?.block).toContain("session=ses_recent")
    expect(result?.block).toContain("validate continuation behavior")
  })

  test("targeted recall ranks typed constraints before matching session notes", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Constraints",
          key: "feature_parity",
          text: "Feature work needs product parity across CLI, VS Code, and JetBrains.",
        },
      ],
    })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_constraints",
      topic: "repo constraints",
      summary: "Discussed broad repo constraints and current worktree state.",
      time: Date.UTC(2026, 0, 2),
    })

    const result = await MemoryRecall.search({ root, query: "what did memory say about constraints?" })

    expect(result?.hits[0]?.kind).toBe("PROJECT_CONSTRAINT")
    expect(result?.block).toContain("feature_parity")
    expect(result?.block).toContain("product parity")
  })

  test("targeted recall audits matched memory", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "environment.md",
          section: "Commands",
          key: "cli_tests",
          text: "Run bun test from packages/opencode for CLI tests.",
        },
      ],
    })

    const result = await KiloMemory.recall({ root, sessionID: "ses_recall", query: "what command runs cli tests?" })
    const shown = await KiloMemory.show({ root })

    expect(result?.hits).toHaveLength(1)
    expect(shown.decisions).toContain('"kind":"recall"')
    expect(shown.decisions).toContain('"result":"recalled"')
    expect(shown.decisions).toContain('"query":"what command runs cli tests?"')
    expect(shown.decisions).toContain('"topics":["environment","quality","integration"]')
    expect(shown.decisions).toContain('"files":["environment.md"]')
  })

  test("targeted recall audits no-match attempts", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    const result = await KiloMemory.recall({ root, sessionID: "ses_recall", query: "what command runs deployment?" })
    const shown = await KiloMemory.show({ root })

    expect(result).toBeUndefined()
    expect(shown.decisions).toContain('"kind":"recall"')
    expect(shown.decisions).toContain('"result":"skipped"')
    expect(shown.decisions).toContain('"reason":"no_matches"')
  })

  test("automatic targeted recall ignores active session digest", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_active",
      topic: "memory tests",
      summary: "We established that memory tests should run from packages/opencode.",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })

    const result = await KiloMemory.recall({
      root,
      sessionID: "ses_active",
      query: "what did we establish about memory tests?",
    })

    expect(result).toBeUndefined()
  })

  test("source edits invalidate cached index", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [{ action: "add", key: "old_fact", text: "Old indexed memory." }],
    })
    const paths = MemoryPaths.files(root)
    const first = await KiloMemory.context({ root, record: false })
    await Bun.sleep(10)
    await Filesystem.write(
      paths.project,
      "# Project Memory\n\n## Facts\n- edited_fact :: Direct edits should rebuild the memory index.\n\n## Decisions\n\n## Constraints\n\n## Open Questions\n",
    )

    const next = await KiloMemory.context({ root, record: false })

    expect(first.blocks[0]?.text).toContain("old_fact")
    expect(next.blocks[0]?.text).toContain("edited_fact")
    expect(next.blocks[0]?.text).not.toContain("old_fact")
  })

  test("targeted recall uses recent session digest for specific memory lookup", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_memory",
      summary: "Objective: implement recall. Next: wire prompt injection.",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })

    for (const query of [
      "recall the previous session",
      "what did memory say about prompt injection?",
      "what did we decide last session about recall?",
    ]) {
      const result = await MemoryRecall.search({ root, query })
      expect(result?.block).toContain("type=session_digest")
      expect(result?.block).toContain("session=ses_memory")
      expect(result?.block).toContain("wire prompt injection")
    }
  })

  test("targeted recall searches retained session digests beyond startup index", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    for (let idx = 0; idx < 12; idx++) {
      await KiloMemory.recordSession({
        root,
        sessionID: `ses_${idx}`,
        summary:
          idx === 1
            ? "Investigated duplicate PR #10550 and found merged PR #10594 covers the DirectShow device fix."
            : `summary_${idx} routine session`,
        time: Date.UTC(2026, 0, 1, 0, idx),
      })
    }

    const shown = await KiloMemory.show({ root })
    const result = await MemoryRecall.search({ root, query: "recall duplicate PR 10550" })
    const natural = await MemoryRecall.search({ root, query: "what was the duplicate PR we found?" })

    expect(shown.index).not.toContain("session=ses_1 ")
    expect(shown.index).not.toContain("10550")
    expect(result?.block).toContain("session=ses_1")
    expect(result?.block).toContain("10594")
    expect(natural?.block).toContain("session=ses_1")
    expect(natural?.block).toContain("10594")
  })

  test("targeted recall skips empty continuation session digests", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_useful",
      topic: "memory continuation",
      summary: "Objective: finish memory v0. Next: verify extension recall behavior.",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })
    for (let idx = 0; idx < 4; idx++) {
      await KiloMemory.recordSession({
        root,
        sessionID: `ses_empty_${idx}`,
        topic: "continue recent work",
        summary: 'That session was empty, just another "continue recent work" request with no actual work done.',
        time: Date.UTC(2026, 0, 1, 0, idx + 1),
      })
    }

    const shown = await KiloMemory.show({ root })
    const result = await MemoryRecall.search({ root, query: "recall recent work" })

    expect(shown.index).toContain("session=ses_useful")
    expect(result?.block).toContain("session=ses_useful")
    expect(result?.block).toContain("verify extension recall behavior")
    expect(result?.block).not.toContain("session=ses_empty_")
  })

  test("targeted recall uses non-empty session digests for continuation prompts", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_memory",
      summary: "Objective: implement recall. Next: wire prompt injection.",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_empty",
      summary: 'That session was empty, just another "continue recent work" request with no actual work done.',
      time: Date.UTC(2026, 0, 1, 0, 1),
    })

    for (const query of [
      "where did we stop?",
      "where did we end?",
      "where are we?",
      "where are recent context?",
      "what were we investigating before?",
      "lets continue",
      "pick this back up",
      "what's next?",
    ]) {
      const result = await MemoryRecall.search({ root, query })
      expect(result?.block).toContain("session=ses_memory")
      expect(result?.block).toContain("wire prompt injection")
      expect(result?.block).not.toContain("session=ses_empty")
    }
  })

  test("targeted recall skips memory implementation task phrasing", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_plan_memory",
      summary: "Objective: investigate plan mode memory sidebar token usage. Next: compare memory token accounting.",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })

    const result = await MemoryRecall.search({
      root,
      query:
        "i will stop investigating the plan mode and evaluate if the current memory implementation usage is counting towards the token count we see in the sidebar",
    })
    const prior = await MemoryRecall.search({
      root,
      query: "what did we decide about memory token accounting?",
    })

    expect(result).toBeUndefined()
    expect(prior?.block).toContain("session=ses_plan_memory")
    expect(prior?.block).toContain("token accounting")
  })

  test("targeted recall skips prompts without memory signal", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    const result = await MemoryRecall.search({ root, query: "thanks" })

    expect(result).toBeUndefined()
  })

  test("expired typed memory stays inspectable but is not injected or recalled", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
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

    const fresh = await MemoryRecall.search({ root, query: "what memory exists about the birthday party?" })
    const shown = await KiloMemory.show({ root })
    const id = MemoryFiles.metaKey({ file: "project.md", section: "Facts", key: "birthday_party" })
    const item = shown.metadata.items[id]

    expect(fresh?.block).toContain("birthday_party")
    expect(shown.index).toContain("birthday_party")
    expect(shown.items).toContain("type=project_fact")
    expect(shown.items).toContain("source=project.md")
    expect(shown.items).toContain("stale=no")
    expect(item?.staleAfter).toBeGreaterThan(Date.now())
    if (!item) throw new Error("missing typed memory metadata")

    await MemoryFiles.writeMetadata(root, {
      ...shown.metadata,
      items: {
        ...shown.metadata.items,
        [id]: { ...item, staleAfter: Date.now() - 1 },
      },
    })

    const index = await MemoryIndexer.rebuild({ root })
    const stale = await MemoryRecall.search({ root, query: "what memory exists about the birthday party?" })
    const next = await KiloMemory.show({ root })

    expect(next.sources.project).toContain("birthday_party")
    expect(next.items).toContain("birthday_party")
    expect(next.items).toContain("stale=yes")
    expect(next.items).toMatch(/expires=\d{4}-\d{2}-\d{2}T/)
    expect(index.text).not.toContain("birthday_party")
    expect(stale?.block ?? "").not.toContain("birthday_party")
  })

  test("durable typed memory shows no expiry as never", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Facts",
          key: "kilo_brand",
          text: "Kilo brand is black and yellow.",
        },
      ],
    })

    const shown = await KiloMemory.show({ root })

    expect(shown.items).toContain("key=kilo_brand")
    expect(shown.items).toContain("stale=no")
    expect(shown.items).toContain("expires=never")
  })

  test("show does not persist a generated catalog", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [
        {
          action: "add",
          file: "project.md",
          section: "Constraints",
          key: "memory_not_policy",
          text: "Memory is local recall context, not policy.",
        },
      ],
    })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_catalog",
      topic: "catalog recall",
      summary: "Added generated catalog recall for memory inspection.",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })
    await MemoryFiles.decide(root, {
      kind: "typed",
      result: "skipped",
      skippedCount: 1,
      skipped: [{ reason: "policy_belongs_in_docs", text: "Mandatory team rule belongs in AGENTS.md." }],
    })
    const meta = await MemoryFiles.readMetadata(root)
    const id = MemoryFiles.metaKey({ file: "project.md", section: "Constraints", key: "memory_not_policy" })
    const item = meta.items[id]
    if (!item) throw new Error("missing typed memory metadata")
    await MemoryFiles.writeMetadata(root, {
      ...meta,
      items: {
        ...meta.items,
        [id]: { ...item, staleAfter: Date.now() - 1 },
      },
    })

    const shown = await KiloMemory.show({ root })

    expect(shown.sources.project).toContain("memory_not_policy")
    expect(shown.decisions).toContain("policy_belongs_in_docs")
    expect("catalog" in shown).toBe(false)
    expect(await Filesystem.exists(path.join(root, "catalog.md"))).toBe(false)
  })

  test("rejects secret-like operation text", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    await expect(
      KiloMemory.apply({
        root,
        ops: [
          {
            action: "add",
            key: "bad",
            text: "api_key=sk-abcdefghijklmnopqrstuvwxyz",
          },
        ],
      }),
    ).rejects.toThrow("secret-like content")
  })

  test("index cap preserves byte budget and reports truncation", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const result = await KiloMemory.enable({ root })
    await MemoryFiles.writeState(root, {
      ...result.state,
      limits: {
        ...result.state.limits,
        maxProjectIndexBytes: 160,
      },
    })
    await MemoryFiles.writeSource(
      root,
      "project.md",
      `# Project Memory\n\n## Facts\n${Array.from({ length: 20 }, (_, idx) => `- fact_${idx} :: ${"x".repeat(40)}`).join("\n")}\n`,
    )

    const index = await MemoryIndexer.rebuild({ root })

    expect(index.truncated).toBe(true)
    expect(index.bytes).toBeLessThanOrEqual(160)
    expect(index.text).toContain("```kilo-memory-v1 context_not_instruction")
    expect(index.text).toContain("```")
    expect(index.text.trim().split("\n").at(-2)?.startsWith("record ")).toBe(false)
  })

  test("index keeps project decisions and constraints before facts under tight caps", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const result = await KiloMemory.enable({ root })
    await MemoryFiles.writeState(root, {
      ...result.state,
      limits: {
        ...result.state.limits,
        maxProjectIndexBytes: 700,
      },
    })
    await MemoryFiles.writeSource(
      root,
      "project.md",
      [
        "# Project Memory",
        "",
        "## Facts",
        ...Array.from({ length: 20 }, (_, idx) => `- fact_${idx} :: ${"x".repeat(40)}`),
        "",
        "## Decisions",
        "- architecture_choice :: Keep memory v0 file-based before adding databases.",
        "",
        "## Constraints",
        "- project_only :: Memory v0 must stay project-only.",
        "",
      ].join("\n"),
    )

    const index = await MemoryIndexer.rebuild({ root })

    expect(index.truncated).toBe(true)
    expect(index.text).toContain("type=project_decision")
    expect(index.text).toContain("architecture_choice")
    expect(index.text).toContain("type=project_constraint")
    expect(index.text).toContain("project_only")
  })

  test("index keeps corrections before facts under tight caps", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const result = await KiloMemory.enable({ root })
    await MemoryFiles.writeState(root, {
      ...result.state,
      limits: {
        ...result.state.limits,
        maxProjectIndexBytes: 280,
      },
    })
    await MemoryFiles.writeSource(
      root,
      "corrections.md",
      "# Corrective Memory\n\n## Corrections\n- stale_tests :: Tests run from packages/opencode, not the repo root.\n",
    )
    await MemoryFiles.writeSource(
      root,
      "project.md",
      `# Project Memory\n\n## Facts\n${Array.from({ length: 20 }, (_, idx) => `- fact_${idx} :: ${"x".repeat(40)}`).join("\n")}\n`,
    )

    const index = await MemoryIndexer.rebuild({ root })

    expect(index.truncated).toBe(true)
    expect(index.text).toContain("stale_tests")
  })

  test("index includes summaries for the last 10 sessions", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    for (let idx = 0; idx < 12; idx++) {
      await KiloMemory.recordSession({
        root,
        sessionID: `ses_${idx}`,
        summary: `summary_${String(idx).padStart(2, "0")} durable result`,
        time: Date.UTC(2026, 0, 1, 0, idx),
      })
    }

    const shown = await KiloMemory.show({ root })

    expect(shown.index).toContain("type=session_digest")
    expect(shown.index).toContain("session=ses_11")
    expect(shown.index).toContain("session=ses_10")
    expect(shown.index).toContain("session=ses_9")
    expect(shown.index).toContain("summary_11 durable result")
    expect(shown.index).toContain("summary_10 durable result")
    expect(shown.index).toContain("summary_09 durable result")
    expect(shown.index).toContain("session=ses_2")
    expect(shown.index).not.toContain("session=ses_1 ")
    expect(shown.index).not.toContain("summary_01 durable result")
    expect(shown.index).not.toContain("summary_00 durable result")
  })

  test("index reserves recent sessions under typed memory growth", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    const result = await KiloMemory.enable({ root })
    await MemoryFiles.writeState(root, {
      ...result.state,
      limits: {
        ...result.state.limits,
        maxProjectIndexBytes: 900,
      },
    })
    await MemoryFiles.writeSource(
      root,
      "project.md",
      `# Project Memory\n\n## Facts\n${Array.from({ length: 30 }, (_, idx) => `- fact_${idx} :: ${"x".repeat(50)}`).join("\n")}\n`,
    )
    for (let idx = 0; idx < 4; idx++) {
      await KiloMemory.recordSession({
        root,
        sessionID: `ses_${idx}`,
        topic: `handoff ${idx}`,
        summary: `Objective: keep recent session ${idx} visible. Next: recall digest if more detail is needed.`,
        time: Date.UTC(2026, 0, 1, 0, idx),
      })
    }

    const shown = await KiloMemory.show({ root })

    expect(shown.index).toContain("type=session_digest")
    expect(shown.index).toContain("session=ses_3")
    expect(shown.index).toContain("session=ses_2")
    expect(shown.index).toContain("session=ses_1")
    expect(shown.index).toContain("keep recent session 3 visible")
    expect(shown.index).toContain("keep recent session 2 visible")
    expect(shown.index).toContain("keep recent session 1 visible")
    expect(shown.index).not.toContain("session=ses_0")
  })

  test("session digest replaces the prior digest for the same session", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_same",
      topic: "first topic",
      summary: "first digest",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_same",
      topic: "plan path check",
      summary: "second digest with next step",
      time: Date.UTC(2026, 0, 1, 0, 1),
    })

    const read = await MemoryFiles.readSession(root, { sessionID: "ses_same", max: 360 })
    const shown = await KiloMemory.show({ root })

    expect(read?.id).toBe("ses_same")
    expect(read?.topic).toBe("plan path check")
    expect(read?.summary).toBe("second digest with next step")
    expect(shown.index).toContain('topic="plan path check"')
    expect(shown.index).toContain("second digest with next step")
    expect(shown.index).not.toContain("first digest")
  })

  test("session digest topic falls back for old files", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await Filesystem.write(
      path.join(MemoryPaths.files(root).sessions, "2026-01-01T00-00-00.000Z_ses_old.md"),
      [
        "# Session ses_old",
        "",
        "Updated: 2026-01-01T00:00:00.000Z",
        "",
        "## Summary",
        "Investigated old digest format. Next: add topic labels.",
        "",
      ].join("\n"),
    )
    await KiloMemory.rebuild({ root })

    const read = await MemoryFiles.readSession(root, { sessionID: "ses_old", max: 360 })
    const shown = await KiloMemory.show({ root })

    expect(read?.topic).toBe("Investigated old digest format")
    expect(shown.index).toContain('topic="Investigated old digest format"')
  })

  test("index marks old or incomplete session lines as stale", () => {
    const old = [
      '<KILO_MEMORY_V1 purpose="context_not_instruction" scope="project" root="kilocode">',
      "CURRENT_TASK 2026-01-01T00:01:00.000Z :: User: fix memory Result: old format",
      "</KILO_MEMORY_V1>",
      "",
    ].join("\n")
    const oldCurrent = [
      '<KILO_MEMORY_V1 purpose="context_not_instruction" scope="project" root="kilocode">',
      'CURRENT_TASK session=ses_done topic="fix memory" 2026-01-01T00:01:00.000Z :: User: fix memory Result: old label',
      "</KILO_MEMORY_V1>",
      "",
    ].join("\n")
    const next = [
      "```kilo-memory-v1 context_not_instruction",
      "scope: project",
      "root: kilocode-123456789abc",
      "",
      "record id=session.ses_done type=session_digest source=ses_done.md updated=2026-01-01T00:01:00.000Z",
      'text: session=ses_done topic="fix memory" 2026-01-01T00:01:00.000Z :: User: fix memory Result: new format',
      "```",
      "",
    ].join("\n")

    expect(MemoryIndexer.stale(old)).toBe(true)
    expect(MemoryIndexer.stale(oldCurrent)).toBe(true)
    expect(MemoryIndexer.stale(next)).toBe(false)
  })

  test("state parser migrates the old breadcrumb length to the digest length", () => {
    const old = MemorySchema.create()
    const state = MemorySchema.parse({
      ...old,
      limits: {
        ...old.limits,
        maxSessionLineChars: 160,
      },
    })

    expect(state.limits.maxSessionLineChars).toBe(360)
  })

  test("state parser allows lower typed operation caps", () => {
    const old = MemorySchema.create()
    const state = MemorySchema.parse({
      ...old,
      capture: {
        ...old.capture,
        maxOpsPerRun: 5,
      },
    })

    expect(state.capture.maxOpsPerRun).toBe(5)
  })

  test("index filters vague continuation session summaries", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_continue",
      summary: "User: i wanna continue Result: I'll inspect the worktree and recent context.",
      time: Date.UTC(2026, 0, 1, 0, 0),
    })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_done",
      summary: "User: fix memory Result: Committed the memory continuation fix.",
      time: Date.UTC(2026, 0, 1, 0, 1),
    })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_empty",
      summary: 'That session was empty, just another "continue recent work" request with no substantive work done.',
      time: Date.UTC(2026, 0, 1, 0, 2),
    })
    await KiloMemory.recordSession({
      root,
      sessionID: "ses_setup",
      topic: "Initial Session Setup",
      summary: "Session started in packages/opencode on branch johnnyeric/kilo-memory-v0-slim-v3. Working tree is currently clean. No tasks have been initiated yet.",
      time: Date.UTC(2026, 0, 1, 0, 3),
    })

    const shown = await KiloMemory.show({ root })

    expect(shown.index).toContain("type=session_digest")
    expect(shown.index).toContain("session=ses_done")
    expect(shown.index).toContain("fix memory")
    expect(shown.index).not.toContain("i wanna continue")
    expect(shown.index).not.toContain("session=ses_empty")
    expect(shown.index).not.toContain("session=ses_setup")
  })

  test("session digest classifier recognizes empty continuation summaries", () => {
    expect(MemoryDigest.empty("User: i wanna continue Result: I'll inspect the worktree.")).toBe(true)
    expect(
      MemoryDigest.empty('That session was empty, just another "continue recent work" request with no actual work done.'),
    ).toBe(true)
    expect(
      MemoryDigest.empty({
        topic: "Initial Session Setup",
        summary:
          "Session started in packages/opencode on branch johnnyeric/kilo-memory-v0-slim-v3. Working tree is currently clean. No tasks have been initiated yet.",
      }),
    ).toBe(true)
    expect(
      MemoryDigest.empty({
        topic: "Memory Updates",
        summary:
          "Recent state: Latest commit: e83a920622 feat(cli): add project memory v0. Working tree has untracked .plans and memory docs. Last saved focus: memory v0 behavior.",
      }),
    ).toBe(true)
    expect(MemoryDigest.empty("Objective: implement recall. Next: wire prompt injection.")).toBe(false)
  })

  test("environment prompt rebuilds stale session index format", async () => {
    await using tmp = await tmpdir()
    await withConfig(path.join(tmp.path, "global", ".kilo"), async () => {
      const context = ctx(tmp.path)
      const enabled = await KiloMemory.enable({ ctx: context })
      const root = enabled.root
      await KiloMemory.recordSession({
        root,
        sessionID: "ses_done",
        summary: "User: fix memory Result: Committed the memory continuation fix.",
        time: Date.UTC(2026, 0, 1, 0, 1),
      })
      await Filesystem.write(
        MemoryPaths.files(root).index,
        [
          '<KILO_MEMORY_V1 purpose="context_not_instruction" scope="project" root="kilocode">',
          "SESSION 2026-01-01T00:01:00.000Z :: User: fix memory Result: old format",
          "</KILO_MEMORY_V1>",
          "",
        ].join("\n"),
      )

      const env = await Effect.runPromise(KilocodeSystemPrompt.environment({ ctx: context, model: model() }))
      const text = env.join("\n")

      expect(text).toContain("type=session_digest")
      expect(text).toContain("session=ses_done")
      expect(text).not.toContain("\nSESSION ")
    })
  })

  test("environment prompt rebuilds index that lacks latest session marker", async () => {
    await using tmp = await tmpdir()
    await withConfig(path.join(tmp.path, "global", ".kilo"), async () => {
      const context = ctx(tmp.path)
      const enabled = await KiloMemory.enable({ ctx: context })
      const root = enabled.root
      await KiloMemory.recordSession({
        root,
        sessionID: "ses_done",
        summary: "User: fix memory Result: Committed the memory continuation fix.",
        time: Date.UTC(2026, 0, 1, 0, 1),
      })
      await Filesystem.write(
        MemoryPaths.files(root).index,
        [
          '<KILO_MEMORY_V1 purpose="context_not_instruction" scope="project" root="kilocode">',
          "RECENT_SESSION 2026-01-01T00:01:00.000Z :: User: fix memory Result: old format",
          "</KILO_MEMORY_V1>",
          "",
        ].join("\n"),
      )

      const env = await Effect.runPromise(
        KilocodeSystemPrompt.environment({ ctx: context, model: model(), sessionID: "session-memory" }),
      )
      const text = env.join("\n")

      expect(text).toContain("type=session_digest")
      expect(text).toContain("session=ses_done")
      expect(text).not.toContain("old format")
    })
  })

  test("serializes concurrent operations for one root", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })

    const ops: MemoryOperations.Op[] = [
      { action: "add", key: "one", text: "first durable fact" },
      { action: "add", key: "two", text: "second durable fact" },
    ]
    await Promise.all(ops.map((op) => KiloMemory.apply({ root, ops: [op] })))

    const shown = await KiloMemory.show({ root })

    expect(shown.sources.project).toContain("- one :: first durable fact")
    expect(shown.sources.project).toContain("- two :: second durable fact")
  })

  test("environment prompt skips missing and empty memory", async () => {
    await using tmp = await tmpdir()
    await withConfig(path.join(tmp.path, "global", ".kilo"), async () => {
      const context = ctx(tmp.path)
      const missing = await Effect.runPromise(KilocodeSystemPrompt.environment({ ctx: context, model: model() }))
      expect(missing.join("\n")).not.toContain("kilo-memory-v1")

      await KiloMemory.enable({ ctx: context })
      const empty = await Effect.runPromise(KilocodeSystemPrompt.environment({ ctx: context, model: model() }))
      expect(empty.join("\n")).not.toContain("kilo-memory-v1")
    })
  })

  test("environment prompt injects non-empty memory with token metadata", async () => {
    await using tmp = await tmpdir()
    await withConfig(path.join(tmp.path, "global", ".kilo"), async () => {
      const context = ctx(tmp.path)
      const enabled = await KiloMemory.enable({ ctx: context })
      const root = enabled.root
      await KiloMemory.apply({
        root,
        ops: [{ action: "add", key: "repo_fact", text: "Use the CLI package test runner for CLI changes." }],
      })

      const env = await Effect.runPromise(
        KilocodeSystemPrompt.environment({ ctx: context, model: model(), sessionID: "session-memory" }),
      )
      const text = env.join("\n")
      const state = await MemoryFiles.readState(root)

      expect(text).toContain("```kilo-memory-v1 context_not_instruction")
      expect(text).toContain("type=project_fact")
      expect(text).toContain("repo_fact :: Use the CLI package test runner")
      expect(text).toContain("newest relevant session_digest record")
      expect(text).toContain("reconcile it with memory")
      expect(text).toContain("current repo state as fresher")
      expect(text).toContain("kilo_memory_recall with mode=digest")
      expect(text).toContain("For topic-specific memory, use kilo_memory_recall")
      expect(text).toContain("Use kilo_local_recall with mode=read only when")
      expect(text).toContain("Legacy Beads/bd task tracking: disabled")
      expect(state.stats.lastInjectedTokens).toBeGreaterThan(0)
      expect(state.stats.lastInjectedSessionID).toBe("session-memory")
    })
  })

  test("environment prompt injection stats do not clobber queued memory stats", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [{ action: "add", key: "repo_fact", text: "Use the CLI package test runner for CLI changes." }],
    })
    const gate = {} as { resolve: () => void }
    const hold = new Promise<void>((resolve) => {
      gate.resolve = resolve
    })
    const queued = MemoryFiles.queue(root, async () => {
      await hold
      const state = await MemoryFiles.readState(root)
      await MemoryFiles.writeState(root, {
        ...state,
        stats: {
          ...state.stats,
          lastOperationCount: 7,
        },
      })
    })

    const env = KiloMemory.context({ root })
    gate.resolve()
    await Promise.all([queued, env])
    const state = await MemoryFiles.readState(root)

    expect(state.stats.lastOperationCount).toBe(7)
    expect(state.stats.lastInjectedTokens).toBeGreaterThan(0)
  })

  test("unrecorded context reads do not clobber session injection stats", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await KiloMemory.enable({ root })
    await KiloMemory.apply({
      root,
      ops: [{ action: "add", key: "repo_fact", text: "Use the CLI package test runner for CLI changes." }],
    })

    await KiloMemory.context({ root, sessionID: "visible-session" })
    await KiloMemory.context({ root, record: false })
    const state = await MemoryFiles.readState(root)

    expect(state.stats.lastInjectedSessionID).toBe("visible-session")
    expect(state.stats.lastInjectedTokens).toBeGreaterThan(0)
  })
})
