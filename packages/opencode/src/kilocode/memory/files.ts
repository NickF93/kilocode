import { AsyncLocalStorage } from "async_hooks"
import { appendFile, chmod, cp, lstat, mkdir, readdir, rm, stat as follow, unlink } from "fs/promises"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Filesystem } from "@/util/filesystem"
import { MemoryPaths } from "./paths"
import { MemoryRedact } from "./redact"
import { MemorySchema } from "./schema"
import { MemoryTopics } from "./topics"

export namespace MemoryFiles {
  const log = Log.create({ service: "memory.files" })
  const locks = new Map<string, Promise<void>>()
  const DIR = 0o700
  const FILE = 0o600
  const STALE = 30_000
  const MAX_LOG = 128_000
  const LOG_MARGIN = 16_000
  const local = new AsyncLocalStorage<Set<string>>()
  export type Decision = {
    sessionID?: string
    kind: "digest" | "typed" | "recall"
    result: "saved" | "skipped" | "fallback" | "error" | "recalled"
    trigger?: "explicit" | "turn-close" | "targeted-recall" | "rebuild"
    llm?: boolean
    parsed?: boolean
    fallback?: boolean
    reason?: string
    tokens?: number
    operationCount?: number
    skippedCount?: number
    fallbackOperationCount?: number
    query?: string
    topics?: string[]
    files?: string[]
    summary?: string
    skipped?: { reason: string; text?: string; duplicateOf?: string }[]
    operations?: {
      action: "add" | "remove"
      file?: string
      section?: string
      key?: string
      query?: string
    }[]
  }

  export type ItemMeta = {
    file: MemorySchema.Source
    section: string
    key: string
    text: string
    topics?: MemorySchema.Topic[]
    terms?: string[]
    createdAt: number
    updatedAt: number
    staleAfter?: number
  }

  export type Metadata = {
    version: 1
    items: Record<string, ItemMeta>
  }

  const seed: Record<MemorySchema.Source, string> = {
    "project.md": "# Project Memory\n\n## Facts\n\n## Decisions\n\n## Constraints\n\n## Open Questions\n",
    "environment.md": "# Environment Memory\n\n## Commands\n\n## Paths\n\n## Tooling\n",
    "corrections.md": "# Corrective Memory\n\n## Corrections\n",
  }

  function miss(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  }

  function code(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
  }

  function parse(error: unknown) {
    return error instanceof SyntaxError
  }

  function brief(error: unknown) {
    return error instanceof Error ? error.message.replaceAll(/\s+/g, " ").slice(0, 160) : String(error).slice(0, 160)
  }

  function trusted(file: string) {
    if (process.platform !== "darwin") return false
    return file === "/var" || file === "/tmp" || file === "/etc"
  }

  async function guard(file: string) {
    const info = await lstat(file).catch((error: unknown) => {
      if (miss(error)) return
      throw error
    })
    if (info?.isSymbolicLink()) {
      if (trusted(path.resolve(file))) return follow(file)
      throw new Error(`memory path rejects symlink: ${file}`)
    }
    return info
  }

  async function parents(file: string) {
    const root = path.parse(path.resolve(file)).root
    const parts = path.resolve(file).slice(root.length).split(path.sep).filter(Boolean)
    await parts.reduce(async (prev, part) => {
      const base = await prev
      const next = path.join(base, part)
      const info = await guard(next)
      if (info && !info.isDirectory()) throw new Error(`memory parent is not a directory: ${next}`)
      return next
    }, Promise.resolve(root))
  }

  async function dir(file: string) {
    await parents(path.dirname(file))
    await guard(file)
    await mkdir(file, { recursive: true, mode: DIR })
    await chmod(file, DIR).catch((error: unknown) => {
      if (process.platform === "win32") return
      throw error
    })
    const info = await guard(file)
    if (!info?.isDirectory()) throw new Error(`memory path is not a directory: ${file}`)
  }

  async function write(file: string, text: string) {
    await dir(path.dirname(file))
    const info = await guard(file)
    if (info && !info.isFile()) throw new Error(`memory path is not a file: ${file}`)
    await Filesystem.write(file, text, FILE)
    await chmod(file, FILE).catch((error: unknown) => {
      if (process.platform === "win32") return
      throw error
    })
  }

  async function read(file: string) {
    const info = await guard(file)
    if (!info) return undefined
    if (!info.isFile()) throw new Error(`memory path is not a file: ${file}`)
    return Filesystem.readText(file)
  }

  async function json(file: string) {
    const text = await read(file)
    return text === undefined ? undefined : JSON.parse(text)
  }

  async function backup(file: string) {
    const text = await read(file).catch((error: unknown) => {
      if (miss(error)) return undefined
      throw error
    })
    if (text === undefined) return
    await write(`${file}.bad-${Date.now()}`, text)
    await rm(file, { force: true })
  }

  function cap(input: string) {
    if (Buffer.byteLength(input) <= MAX_LOG) return input
    const lines = input.split("\n").reverse()
    const kept: string[] = []
    lines.reduce((sum, line) => {
      if (sum >= MAX_LOG) return sum
      kept.push(line)
      return sum + Buffer.byteLength(`${line}\n`)
    }, 0)
    return kept.reverse().join("\n")
  }

  async function ensure(file: string, text: string) {
    if (await Filesystem.exists(file)) {
      const info = await guard(file)
      if (!info?.isFile()) throw new Error(`memory path is not a file: ${file}`)
      return
    }
    await write(file, text)
  }

  async function lock(root: string) {
    await dir(root)
    const file = path.join(root, ".lock")
    const acquire = async (left: number): Promise<() => Promise<void>> => {
      try {
        await mkdir(file, { mode: DIR })
        return () => rm(file, { recursive: true, force: true })
      } catch (error) {
        if (code(error) !== "EEXIST") throw error
        const info = await guard(file)
        if (!info?.isDirectory()) throw new Error(`memory lock is not a directory: ${file}`)
        if (Date.now() - info.mtimeMs > STALE) {
          await rm(file, { recursive: true, force: true })
          return acquire(left)
        }
        if (left <= 0) throw new Error(`timed out waiting for memory lock: ${root}`)
        await Bun.sleep(50)
        return acquire(left - 1)
      }
    }
    return acquire(100)
  }

  function nested(root: string) {
    return local.getStore()?.has(root) === true
  }

  export async function queue<T>(root: string, fn: () => Promise<T>): Promise<T> {
    if (nested(root)) return fn()
    const prev = locks.get(root) ?? Promise.resolve()
    const next = prev
      .catch((err: unknown) => {
        log.warn("previous memory queue operation failed", { root, err })
      })
      .then(async () => {
        const release = await lock(root)
        try {
          const roots = new Set(local.getStore() ?? [])
          roots.add(root)
          return await local.run(roots, fn)
        } finally {
          await release()
        }
      })
    const done = next.then(
      () => undefined,
      () => undefined,
    )
    locks.set(root, done)
    try {
      return await next
    } finally {
      if (locks.get(root) === done) locks.delete(root)
    }
  }

  async function copyMissing(from: string, to: string) {
    if (!(await Filesystem.exists(from))) return false
    if (await Filesystem.exists(to)) return false
    await dir(path.dirname(to))
    await cp(from, to, { recursive: true, force: false, errorOnExist: true })
    return true
  }

  async function copySource(from: string, to: string, name: MemorySchema.Source) {
    const source = await read(from).catch((error: unknown) => {
      if (miss(error)) return undefined
      throw error
    })
    if (source === undefined) return false
    const text = MemoryRedact.text(source)
    if (text.trim() === seed[name].trim()) return false
    if (await Filesystem.exists(to)) {
      if (!(await seeded(to, name))) return false
      await write(to, text)
      return true
    }
    await write(to, text)
    return true
  }

  async function copyText(from: string, to: string) {
    const text = await read(from).catch((error: unknown) => {
      if (miss(error)) return undefined
      throw error
    })
    if (text === undefined) return false
    if (await Filesystem.exists(to)) return false
    await write(to, MemoryRedact.text(text))
    return true
  }

  async function copyMetadata(from: string, to: string) {
    if (await Filesystem.exists(to)) return false
    const data = await json(from).catch((error: unknown) => {
      if (miss(error) || parse(error)) return undefined
      throw error
    })
    if (data === undefined) return false
    await write(to, `${JSON.stringify(scrub(metadata(data)), null, 2)}\n`)
    return true
  }

  function scrub(input: unknown, name?: string): unknown {
    const label = name?.replaceAll(/[_-]/g, "").toLowerCase()
    if (label && ["password", "apikey", "secret", "token"].includes(label)) return "[redacted]"
    if (typeof input === "string") return MemoryRedact.has(input) ? "[redacted]" : MemoryRedact.text(input)
    if (Array.isArray(input)) return input.map((item) => scrub(item))
    if (typeof input !== "object" || input === null) return input
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, scrub(item, key)]))
  }

  async function copyJsonl(from: string, to: string) {
    const text = await read(from).catch((error: unknown) => {
      if (miss(error)) return undefined
      throw error
    })
    if (text === undefined) return false
    if (await Filesystem.exists(to)) return false
    const lines = text.split("\n").map((line) => {
      if (!line.trim()) return ""
      try {
        return JSON.stringify(scrub(JSON.parse(line)))
      } catch (_error) {
        return MemoryRedact.text(line)
      }
    })
    const next = lines.join("\n")
    await write(to, next.endsWith("\n") ? next : `${next}\n`)
    return true
  }

  async function secure(file: string) {
    const info = await guard(file)
    if (!info) return
    if (info.isDirectory()) {
      await chmod(file, DIR).catch((error: unknown) => {
        if (process.platform === "win32") return
        throw error
      })
      const entries = await readdir(file, { withFileTypes: true })
      await Promise.all(entries.map((entry) => secure(path.join(file, entry.name))))
      return
    }
    if (!info.isFile()) throw new Error(`memory path is not a file: ${file}`)
    await chmod(file, FILE).catch((error: unknown) => {
      if (process.platform === "win32") return
      throw error
    })
  }

  async function copySessions(from: string, to: string) {
    const src = MemoryPaths.files(from).sessions
    const dst = MemoryPaths.files(to).sessions
    const files = await readdir(src).catch((error: unknown) => {
      if (miss(error)) return [] as string[]
      throw error
    })
    const copied = await Promise.all(
      files
        .filter((file) => file.endsWith(".md"))
        .map((file) => copyText(path.join(src, file), path.join(dst, file))),
    )
    return copied.some(Boolean)
  }

  async function copyKnown(from: string, to: string) {
    const src = MemoryPaths.files(from)
    const dst = MemoryPaths.files(to)
    const copied = await Promise.all([
      copyMissing(src.state, dst.state),
      copyMetadata(src.metadata, dst.metadata),
      copySource(src.project, dst.project, "project.md"),
      copySource(src.environment, dst.environment, "environment.md"),
      copySource(src.corrections, dst.corrections, "corrections.md"),
      copyMissing(src.ignore, dst.ignore),
      copyText(src.changes, dst.changes),
      copyJsonl(src.decisions, dst.decisions),
      copySessions(from, to),
    ])
    return copied.some(Boolean)
  }

  async function empty(file: string) {
    const text = await read(file).catch((error: unknown) => {
      if (miss(error)) return ""
      throw error
    })
    return (text ?? "").trim() === ""
  }

  async function emptyMetadata(file: string) {
    const data = await json(file).catch((error: unknown) => {
      if (miss(error) || parse(error)) return undefined
      throw error
    })
    return Object.keys(metadata(data).items).length === 0
  }

  async function seeded(file: string, name: MemorySchema.Source) {
    const text = await read(file).catch((error: unknown) => {
      if (miss(error)) return seed[name]
      throw error
    })
    return (text ?? seed[name]).trim() === seed[name].trim()
  }

  async function hasFiles(dir: string) {
    const files = await readdir(dir).catch((error: unknown) => {
      if (miss(error)) return [] as string[]
      throw error
    })
    return files.length > 0
  }

  async function scaffoldOnly(root: string) {
    const paths = MemoryPaths.files(root)
    const names = await readdir(root).catch((error: unknown) => {
      if (miss(error)) return [] as string[]
      throw error
    })
    const allow = new Set([
      ".gitignore",
      "state.json",
      "index.kmem",
      "metadata.json",
      "project.md",
      "environment.md",
      "corrections.md",
      "changes.log",
      "decisions.jsonl",
      "sessions",
    ])
    if (names.some((name) => !allow.has(name))) return false
    if (await hasFiles(paths.sessions)) return false
    if (!(await emptyMetadata(paths.metadata))) return false
    if (!(await empty(paths.decisions))) return false
    return (
      (await seeded(paths.project, "project.md")) &&
      (await seeded(paths.environment, "environment.md")) &&
      (await seeded(paths.corrections, "corrections.md"))
    )
  }

  export async function migrate(input: { from: string; to: string }) {
    if (input.from === input.to) return { migrated: false }
    if (!(await Filesystem.exists(input.from))) return { migrated: false }
    const exists = await Filesystem.exists(input.to)
    const copied = await copyKnown(input.from, input.to)
    if (!copied) return { migrated: false }
    await secure(input.to)
    await append(input.to, exists ? `migrate missing from=${input.from}` : `migrate from=${input.from}`)
    return { migrated: true }
  }

  export async function cleanupLegacy(input: { root: string }) {
    if (!(await Filesystem.exists(input.root))) return false
    if (!(await scaffoldOnly(input.root))) return false
    await rm(input.root, { recursive: true, force: true })
    return true
  }

  export async function readState(root: string, scope: MemorySchema.Scope = "project") {
    const file = MemoryPaths.files(root).state
    const data = await json(file).catch(async (error: unknown) => {
      if (miss(error)) return undefined
      if (parse(error)) {
        await backup(file)
        const state = MemorySchema.missing(scope)
        await writeState(root, state)
        await append(root, `recover state.json error=${brief(error)}`).catch((err: unknown) =>
          log.warn("failed to audit memory state recovery", { err, root }),
        )
        return state
      }
      throw error
    })
    if (data === undefined) return MemorySchema.missing(scope)
    return MemorySchema.parse(data, scope)
  }

  export async function writeState(root: string, state: MemorySchema.State) {
    await write(MemoryPaths.files(root).state, `${JSON.stringify(state, null, 2)}\n`)
  }

  export function metaKey(input: { file: MemorySchema.Source; section: string; key: string }) {
    return [input.file, input.section, input.key].map((item) => item.replaceAll(/[^\w.-]+/g, "_")).join(":")
  }

  function source(input: unknown): input is MemorySchema.Source {
    return typeof input === "string" && (MemorySchema.Sources as readonly string[]).includes(input)
  }

  function metadata(input: unknown): Metadata {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { version: 1, items: {} }
    const items = "items" in input && typeof input.items === "object" && input.items !== null ? input.items : {}
    const result: Metadata["items"] = {}
    const stamp = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Date.now())
    for (const [id, value] of Object.entries(items)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue
      const item = value as Partial<ItemMeta>
      if (!source(item.file)) continue
      if (typeof item.section !== "string") continue
      if (typeof item.key !== "string") continue
      if (typeof item.text !== "string") continue
      const topics = MemorySchema.topics(item.topics)
      const terms = Array.isArray(item.terms)
        ? [...new Set(item.terms.filter((term): term is string => typeof term === "string"))].slice(0, 8)
        : []
      result[id] = {
        file: item.file,
        section: item.section,
        key: item.key,
        text: item.text,
        ...(topics.length > 0 ? { topics } : {}),
        ...(terms.length > 0 ? { terms } : {}),
        createdAt: stamp(item.createdAt),
        updatedAt: stamp(item.updatedAt),
        ...(typeof item.staleAfter === "number" && Number.isFinite(item.staleAfter) && item.staleAfter >= 0
          ? { staleAfter: item.staleAfter }
          : {}),
      }
    }
    return { version: 1, items: result }
  }

  export function expired(input: {
    data: Metadata
    file: MemorySchema.Source
    section: string
    key: string
    text: string
    now?: number
  }) {
    const item = input.data.items[metaKey({ file: input.file, section: input.section, key: input.key })]
    if (!item?.staleAfter) return false
    if (item.text !== input.text) return false
    return item.staleAfter <= (input.now ?? Date.now())
  }

  export async function readMetadata(root: string) {
    const file = MemoryPaths.files(root).metadata
    const data = await json(file).catch(async (error: unknown) => {
      if (miss(error)) return undefined
      if (parse(error)) {
        await backup(file)
        const data = metadata(undefined)
        await writeMetadata(root, data)
        await append(root, `recover metadata.json error=${brief(error)}`).catch((err: unknown) =>
          log.warn("failed to audit memory metadata recovery", { err, root }),
        )
        return data
      }
      throw error
    })
    return metadata(data)
  }

  export async function writeMetadata(root: string, data: Metadata) {
    await write(MemoryPaths.files(root).metadata, `${JSON.stringify(data, null, 2)}\n`)
  }

  export async function writeManifest(root: string, id?: MemoryPaths.Identity) {
    if (!id) return
    await write(
      MemoryPaths.files(root).manifest,
      `${JSON.stringify(
        {
          version: 1,
          display: id.display,
          canonical: id.canonical,
          folder: id.folder,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    )
  }

  async function line(file: string, text: string) {
    await dir(path.dirname(file))
    const info = await guard(file)
    if (info && !info.isFile()) throw new Error(`memory path is not a file: ${file}`)
    await appendFile(file, text, { mode: FILE })
    await chmod(file, FILE).catch((error: unknown) => {
      if (process.platform === "win32") return
      throw error
    })
    const next = await guard(file)
    if (!next?.isFile()) throw new Error(`memory path is not a file: ${file}`)
    if (next.size <= MAX_LOG + LOG_MARGIN) return
    await write(file, cap((await read(file)) ?? ""))
  }

  export async function append(root: string, text: string) {
    await queue(root, () =>
      line(MemoryPaths.files(root).changes, `${new Date().toISOString()} ${MemoryRedact.text(text)}\n`),
    )
  }

  export async function decide(root: string, input: Decision) {
    const data = MemoryRedact.value(input) as Decision
    await queue(root, () =>
      line(
        MemoryPaths.files(root).decisions,
        `${JSON.stringify({
          time: new Date().toISOString(),
          ...data,
        })}\n`,
      ),
    )
  }

  export async function readDecisions(root: string) {
    return read(MemoryPaths.files(root).decisions).then((text) => text ?? "").catch((error: unknown) => {
      if (miss(error)) return ""
      throw error
    })
  }

  async function mtime(file: string) {
    const info = await guard(file)
    if (!info) return 0
    if (!info.isFile()) throw new Error(`memory path is not a file: ${file}`)
    return info.mtimeMs
  }

  export async function indexExpired(root: string) {
    const paths = MemoryPaths.files(root)
    const index = await guard(paths.index)
    if (!index) return true
    if (!index.isFile()) throw new Error(`memory path is not a file: ${paths.index}`)
    const sources = [
      paths.project,
      paths.environment,
      paths.corrections,
      paths.metadata,
      ...(await readdir(paths.sessions).catch((error: unknown) => {
        if (miss(error)) return [] as string[]
        throw error
      })).map((file) => path.join(paths.sessions, file)).filter((file) => file.endsWith(".md")),
    ]
    const times = await Promise.all(
      sources.map((file) =>
        mtime(file).catch((error: unknown) => {
          if (miss(error)) return 0
          throw error
        }),
      ),
    )
    return times.some((time) => time > index.mtimeMs)
  }

  export async function scaffold(root: string, scope: MemorySchema.Scope = "project", id?: MemoryPaths.Identity) {
    const paths = MemoryPaths.files(root)
    await dir(root)
    await dir(paths.sessions)
    await ensure(paths.ignore, "*\n!.gitignore\n")
    await ensure(paths.project, seed["project.md"])
    await ensure(paths.environment, seed["environment.md"])
    await ensure(paths.corrections, seed["corrections.md"])
    await writeManifest(root, id)
    const exists = await Filesystem.exists(paths.state)
    const state = exists
      ? { ...(await readState(root, scope)), enabled: true, autoInject: true }
      : { ...MemorySchema.create(scope), enabled: true }
    await writeState(root, state)
    await append(root, `enable ${scope} source=command`)
    return state
  }

  function safe(input: string) {
    return input.replaceAll(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "session"
  }

  function stamp(input: number) {
    return new Date(input).toISOString().replaceAll(":", "-")
  }

  function session(file: string, content: string) {
    const header = content
      .split("\n")
      .find((line) => line.startsWith("# Session "))
      ?.slice("# Session ".length)
      .trim()
    if (header) return header
    const idx = file.indexOf("_")
    return idx === -1 ? file.replace(/\.md$/, "") : file.slice(idx + 1).replace(/\.md$/, "")
  }

  function trim(input: string, max: number) {
    const text = input.trim().replaceAll(/\s+/g, " ")
    if (text.length <= max) return text
    return `${text.slice(0, Math.max(0, max - 3))}...`
  }

  function topic(input: { summary: string; topic?: string }) {
    return trim(input.topic || input.summary.split(/[.;:]/)[0] || input.summary, 80)
  }

  async function removePrior(root: string, id: string) {
    const paths = MemoryPaths.files(root)
    const files = await readdir(paths.sessions).catch((error: unknown) => {
      if (miss(error)) return [] as string[]
      throw error
    })
    await Promise.all(
      files
        .filter((file) => file.endsWith(`_${id}.md`))
        .map((file) =>
          unlink(path.join(paths.sessions, file)).catch((error: unknown) => {
            if (miss(error)) return
            throw error
          }),
        ),
    )
  }

  export async function writeSession(
    root: string,
    input: { sessionID: string; topic?: string; summary: string; max: number; time?: number },
  ) {
    const paths = MemoryPaths.files(root)
    await dir(paths.sessions)
    const id = safe(input.sessionID)
    await removePrior(root, id)
    const time = input.time ?? Date.now()
    const file = path.join(paths.sessions, `${stamp(time)}_${id}.md`)
    const summary = trim(MemoryRedact.text(input.summary), input.max)
    const label = topic({ summary, topic: input.topic ? MemoryRedact.text(input.topic) : undefined })
    await write(
      file,
      [
        `# Session ${input.sessionID}`,
        "",
        `Updated: ${new Date(time).toISOString()}`,
        `Topic: ${label}`,
        "",
        "## Summary",
        summary,
        "",
      ].join("\n"),
    )
    return file
  }

  export async function readSession(root: string, input: { sessionID: string; max: number }) {
    const paths = MemoryPaths.files(root)
    const id = safe(input.sessionID)
    const files = await readdir(paths.sessions).catch((error: unknown) => {
      if (miss(error)) return [] as string[]
      throw error
    })
    const file = files
      .filter((item) => item.endsWith(`_${id}.md`))
      .sort()
      .reverse()
      .at(0)
    if (!file) return
    const content = await read(path.join(paths.sessions, file))
    if (!content) return
    const lines = content.split("\n")
    const idx = lines.findIndex((line) => line.trim() === "## Summary")
    if (idx < 0) return
    const time = lines.find((line) => line.startsWith("Updated: "))?.slice("Updated: ".length).trim() ?? file
    const label = lines.find((line) => line.startsWith("Topic: "))?.slice("Topic: ".length).trim()
    const summary = trim(lines.slice(idx + 1).find((line) => line.trim()) ?? "", input.max)
    if (!summary) return
    return { file, id: session(file, content), time, topic: topic({ summary, topic: label }), summary }
  }

  export async function pruneSessions(root: string, max: number) {
    const paths = MemoryPaths.files(root)
    const files = await readdir(paths.sessions).catch((error: unknown) => {
      if (miss(error)) return [] as string[]
      throw error
    })
    const keep = Math.max(0, max)
    await Promise.all(
      files
        .filter((file) => file.endsWith(".md"))
        .sort()
        .reverse()
        .slice(keep)
        .map((file) =>
          unlink(path.join(paths.sessions, file)).catch((error: unknown) => {
            if (miss(error)) return
            throw error
          }),
        ),
    )
  }

  export async function recentSessions(root: string, limit: number, max: number) {
    const paths = MemoryPaths.files(root)
    const files = await readdir(paths.sessions).catch((error: unknown) => {
      if (miss(error)) return [] as string[]
      throw error
    })
    const result: { file: string; id: string; time: string; topic: string; summary: string }[] = []
    for (const file of files
      .filter((item) => item.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit)) {
      const content = await read(path.join(paths.sessions, file))
      if (!content) continue
      const lines = content.split("\n")
      const idx = lines.findIndex((line) => line.trim() === "## Summary")
      if (idx < 0) continue
      const time = lines.find((line) => line.startsWith("Updated: "))?.slice("Updated: ".length).trim() ?? file
      const label = lines.find((line) => line.startsWith("Topic: "))?.slice("Topic: ".length).trim()
      const summary = trim(lines.slice(idx + 1).find((line) => line.trim()) ?? "", max)
      if (summary) result.push({ file, id: session(file, content), time, topic: topic({ summary, topic: label }), summary })
    }
    return result
  }

  export async function readSource(root: string, name: MemorySchema.Source) {
    const file = MemoryPaths.source(root, name)
    return read(file).then((text) => text ?? "").catch((error: unknown) => {
      if (miss(error)) return ""
      throw error
    })
  }

  export async function writeSource(root: string, name: MemorySchema.Source, text: string) {
    await write(MemoryPaths.source(root, name), text.endsWith("\n") ? text : `${text}\n`)
  }

  export async function readIndex(root: string) {
    const file = MemoryPaths.files(root).index
    return read(file).then((text) => text ?? "").catch((error: unknown) => {
      if (miss(error)) return ""
      throw error
    })
  }

  export async function writeIndex(root: string, text: string) {
    await write(MemoryPaths.files(root).index, text)
  }

  function kind(file: MemorySchema.Source, section: string) {
    if (file === "corrections.md") return "correction"
    if (file === "environment.md") return "environment"
    const value = section.toLowerCase()
    if (value.includes("decision")) return "project_decision"
    if (value.includes("constraint")) return "project_constraint"
    if (value.includes("question")) return "open_question"
    return "project_fact"
  }

  function iso(input?: number) {
    if (!input || !Number.isFinite(input)) return "unknown"
    return new Date(input).toISOString()
  }

  function expiry(input?: number) {
    if (!input || !Number.isFinite(input)) return "never"
    return iso(input)
  }

  async function inspect(root: string, scope: MemorySchema.Scope, data: Metadata) {
    const now = Date.now()
    const lines: string[] = []
    for (const file of MemorySchema.sources(scope)) {
      let section = ""
      const body = await readSource(root, file)
      for (const raw of body.split("\n")) {
        const line = raw.trim()
        if (line.startsWith("## ")) {
          section = line.slice(3).trim()
          continue
        }
        if (!line.startsWith("- ") || !line.includes(" :: ")) continue
        const idx = line.indexOf(" :: ")
        const key = line.slice(2, idx).trim()
        const text = line.slice(idx + 4).trim()
        if (!key || !text) continue
        const id = metaKey({ file, section, key })
        const meta = data.items[id]
        const stale = expired({ data, file, section, key, text, now })
        const topics = meta?.topics?.length ? meta.topics : MemoryTopics.assign({ file, section, key, text })
        const terms = meta?.terms?.length ? meta.terms : MemoryTopics.terms({ file, section, key, text })
        lines.push(
          [
            `- id=${id}`,
            `type=${kind(file, section)}`,
            `source=${file}`,
            `section=${section || "unknown"}`,
            `key=${key}`,
            `topics=${topics.join(",") || "unknown"}`,
            `terms=${terms.join(",") || "unknown"}`,
            `updated=${iso(meta?.updatedAt)}`,
            `created=${iso(meta?.createdAt)}`,
            `stale=${stale ? "yes" : "no"}`,
            `expires=${expiry(meta?.staleAfter)}`,
            `:: ${trim(text, 300)}`,
          ].join(" "),
        )
      }
    }
    return lines.join("\n")
  }

  export async function show(root: string, scope: MemorySchema.Scope = "project") {
    const state = await readState(root, scope)
    const metadata = await readMetadata(root)
    return {
      root,
      state,
      sources: {
        project: await readSource(root, "project.md"),
        environment: await readSource(root, "environment.md"),
        corrections: await readSource(root, "corrections.md"),
      },
      index: await readIndex(root),
      metadata,
      items: await inspect(root, scope, metadata),
      changes: await read(MemoryPaths.files(root).changes).then((text) => text ?? "").catch((error: unknown) => {
        if (miss(error)) return ""
        throw error
      }),
      decisions: await readDecisions(root),
    }
  }

  export async function purge(root: string) {
    const info = await guard(root)
    if (!info) return false
    if (!info.isDirectory()) throw new Error(`memory root is not a directory: ${root}`)
    await rm(root, { recursive: true, force: true })
    return true
  }
}
