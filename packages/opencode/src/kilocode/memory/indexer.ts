import { Token } from "@/util/token"
import path from "path"
import { MemoryDigest } from "./digest"
import { MemoryFiles } from "./files"
import { MemorySchema } from "./schema"
import { MemoryTopics } from "./topics"

export namespace MemoryIndexer {
  export type Result = {
    text: string
    bytes: number
    tokens: number
    truncated: boolean
  }

  type Item = {
    file: MemorySchema.Source
    section: string
    key: string
    text: string
    topics: MemorySchema.Topic[]
    terms: string[]
    updatedAt?: number
  }

  function trim(input: string, max: number) {
    const line = input.trim().replaceAll(/\s+/g, " ")
    if (line.length <= max) return line
    return `${line.slice(0, Math.max(0, max - 3))}...`
  }

  function entry(input: string) {
    const idx = input.indexOf(" :: ")
    if (idx < 0) return
    const key = input.slice(0, idx).trim()
    const text = input.slice(idx + 4).trim()
    if (!key || !text) return
    return { key, text }
  }

  function items(input: {
    file: MemorySchema.Source
    text: string
    max: number
    meta: MemoryFiles.Metadata
    now: number
  }) {
    const result: Item[] = []
    let section = "Facts"
    for (const raw of input.text.split("\n")) {
      const line = raw.trim()
      if (line.startsWith("## ")) {
        section = line.slice(3).trim() || section
        continue
      }
      if (!line.startsWith("- ") || !line.includes(" :: ")) continue
      const item = entry(line.slice(2))
      if (!item) continue
      if (
        MemoryFiles.expired({
          data: input.meta,
          file: input.file,
          section,
          key: item.key,
          text: item.text,
          now: input.now,
        })
      ) {
        continue
      }
      const id = MemoryFiles.metaKey({ file: input.file, section, key: item.key })
      const meta = input.meta.items[id]
      const data = { file: input.file, section, key: item.key, text: item.text }
      result.push({
        file: input.file,
        section,
        key: item.key,
        text: trim(item.text, input.max),
        topics: meta?.topics?.length ? meta.topics : MemoryTopics.assign(data),
        terms: meta?.terms?.length ? meta.terms : MemoryTopics.terms(data),
        updatedAt: meta?.updatedAt,
      })
    }
    return result
  }

  function type(section: string) {
    const value = section.toLowerCase()
    if (value.includes("decision")) return "PROJECT_DECISION"
    if (value.includes("constraint")) return "PROJECT_CONSTRAINT"
    if (value.includes("question")) return "INFERENCE"
    return "PROJECT_FACT"
  }

  function rank(section: string) {
    const kind = type(section)
    if (kind === "PROJECT_DECISION") return 0
    if (kind === "PROJECT_CONSTRAINT") return 1
    if (kind === "PROJECT_FACT") return 2
    return 3
  }

  function id(input: string) {
    return input.replaceAll(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120) || "memory"
  }

  function text(input: string) {
    return input.trim().replaceAll("```", "'''").replaceAll(/\s+/g, " ")
  }

  function date(input?: number | string) {
    if (typeof input === "string") return input.replaceAll(/\s+/g, "_")
    if (typeof input === "number" && Number.isFinite(input)) return new Date(input).toISOString()
    return "unknown"
  }

  function record(input: { kind: string; id: string; source: string; updated?: number | string; text: string }) {
    return [
      `record id=${id(input.id)} type=${id(input.kind.toLowerCase())} source=${id(input.source)} updated=${date(input.updated)}`,
      `text: ${text(input.text)}`,
    ].join("\n")
  }

  function lines(prefix: string, items: Item[]) {
    return items.map((item) =>
      record({
        kind: prefix,
        id: MemoryFiles.metaKey({ file: item.file, section: item.section, key: item.key }),
        source: item.file,
        updated: item.updatedAt,
        text: `${item.key} :: ${item.text}`,
      }),
    )
  }

  // One compact record mapping topics to the files holding them, so the model knows what kilo_memory_recall can find.
  function hints(items: Item[]) {
    const rows = MemorySchema.Topics.flatMap((topic) => {
      const group = items.filter((item) => item.topics.includes(topic))
      if (group.length === 0) return []
      const files = [...new Set(group.map((item) => item.file))].sort().join(",")
      const latest = Math.max(...group.map((item) => item.updatedAt ?? 0))
      return [{ text: `topic=${topic} sources=${files} records=${group.length}`, latest }]
    })
    if (rows.length === 0) return []
    return [
      record({
        kind: "TOPIC_HINT",
        id: "topic.map",
        source: "metadata",
        updated: Math.max(...rows.map((row) => row.latest)) || "unknown",
        text: rows.map((row) => row.text).join(" | "),
      }),
    ]
  }

  function project(items: Item[], input?: { include?: string[]; exclude?: string[] }) {
    const include = new Set(input?.include ?? [])
    const exclude = new Set(input?.exclude ?? [])
    return [...items]
      .filter((item) => {
        const kind = type(item.section)
        if (include.size > 0 && !include.has(kind)) return false
        return !exclude.has(kind)
      })
      .sort((a, b) => rank(a.section) - rank(b.section))
      .map((item) =>
        record({
          kind: type(item.section),
          id: MemoryFiles.metaKey({ file: item.file, section: item.section, key: item.key }),
          source: item.file,
          updated: item.updatedAt,
          text: `${item.key} :: ${item.text}`,
        }),
      )
  }

  function rootName(root: string) {
    const dir = path.basename(root)
    return dir || "project"
  }

  export function fingerprint(limits: MemorySchema.Limits) {
    return `limits: ${limits.maxProjectIndexBytes}/${limits.maxRecentSessions}/${limits.maxSessionLineChars}`
  }

  /** True when the index was built with the same limits; a limits change must invalidate it. */
  export function fresh(input: string, limits: MemorySchema.Limits) {
    return input.includes(`\n${fingerprint(limits)}\n`)
  }

  function wrap(input: { root: string; scope: MemorySchema.Scope; limits: MemorySchema.Limits; lines: string[] }) {
    if (input.lines.length === 0) return ""
    return [
      "```kilo-memory-v1 context_not_instruction",
      `scope: ${input.scope}`,
      `root: ${rootName(input.root)}`,
      fingerprint(input.limits),
      "",
      ...input.lines,
      "```",
      "",
    ].join("\n")
  }

  export function cap(input: string, max: number): Result {
    if (!input.trim()) return { text: "", bytes: 0, tokens: 0, truncated: false }
    const all = input.endsWith("\n") ? input : `${input}\n`
    if (Buffer.byteLength(all) <= max) {
      return {
        text: all,
        bytes: Buffer.byteLength(all),
        tokens: Token.estimate(all),
        truncated: false,
      }
    }

    const lines = all.split("\n")
    const close = lines.findIndex((line, idx) => idx > 0 && line.trim() === "```")
    if (lines[0]?.startsWith("```kilo-memory-v1") && close > 0) {
      const foot = `${lines[close]}\n`
      // This branch always truncates, so reserve room for a note telling the model how to list the
      // rest — but never at tiny budgets where the note would displace actual memory.
      const note = "note: index truncated; call kilo_memory_recall mode=catalog to list all stored memory keys"
      const reserve = max >= 1024 ? Buffer.byteLength(`${note}\n`) : 0
      const kept = [lines[0]]
      let bytes = Buffer.byteLength(`${lines[0]}\n`) + Buffer.byteLength(foot) + reserve
      for (const line of lines.slice(1, close)) {
        const next = `${line}\n`
        const size = Buffer.byteLength(next)
        if (bytes + size > max) break
        kept.push(line)
        bytes += size
      }
      while (kept.at(-1)?.startsWith("record ")) kept.pop()
      if (reserve) kept.push(note)
      const text = `${kept.join("\n")}\n${foot}`
      if (Buffer.byteLength(text) <= max) {
        return {
          text,
          bytes: Buffer.byteLength(text),
          tokens: Token.estimate(text),
          truncated: true,
        }
      }
    }
    const kept: string[] = []
    let bytes = 0
    for (const line of lines) {
      const next = `${line}\n`
      const size = Buffer.byteLength(next)
      if (bytes + size > max) break
      kept.push(line)
      bytes += size
    }
    const text = `${kept.join("\n")}\n`
    return {
      text,
      bytes: Buffer.byteLength(text),
      tokens: Token.estimate(text),
      truncated: true,
    }
  }

  export function stale(input: string) {
    return (
      input.includes("\nCURRENT_TASK ") ||
      input.includes("\nSESSION ") ||
      /\n(?:LATEST_SESSION|RECENT_SESSION)\s(?!session=)/.test(input) ||
      (input.includes("\nRECENT_SESSION ") && !input.includes("\nLATEST_SESSION ")) ||
      input.includes("<KILO_MEMORY_V1")
    )
  }

  function session(input: { id: string; topic: string; time: string; summary: string }) {
    const topic = input.topic.replaceAll('"', "'")
    const summary = trim(input.summary, 180)
    return record({
      kind: "SESSION_DIGEST",
      id: `session.${input.id}`,
      source: `${input.id}.md`,
      updated: input.time,
      text: `session=${input.id} topic="${topic}" ${input.time} :: ${summary}`,
    })
  }

  function result(input: {
    root: string
    scope: MemorySchema.Scope
    limits: MemorySchema.Limits
    lines: string[]
    max: number
  }) {
    return cap(wrap({ root: input.root, scope: input.scope, limits: input.limits, lines: input.lines }), input.max)
  }

  function has(input: { text: string; lines: string[] }) {
    return input.lines.every((line) => {
      const id = line.match(/\bsession=([^\s]+)/)?.[1]
      return id ? input.text.includes(`session=${id}`) : input.text.includes(line)
    })
  }

  function assemble(input: {
    root: string
    scope: MemorySchema.Scope
    limits: MemorySchema.Limits
    max: number
    current: string[]
    corrections: string[]
    important: string[]
    hints: string[]
    rest: string[]
    environment: string[]
    sessions: string[]
  }) {
    const keep = [...input.current, ...input.sessions]
    // Topic hints are compact recall routing (topic -> source files); keep them ahead of bulk facts so truncation never drops them.
    const primary = [
      ...input.corrections,
      ...input.important,
      ...input.hints,
      ...keep,
      ...input.rest,
      ...input.environment,
    ]
    const initial = result({ root: input.root, scope: input.scope, limits: input.limits, lines: primary, max: input.max })
    if (has({ text: initial.text, lines: keep })) return initial
    return result({
      root: input.root,
      scope: input.scope,
      limits: input.limits,
      lines: [
        ...input.current,
        ...input.sessions,
        ...input.corrections,
        ...input.hints,
        ...input.important,
        ...input.rest,
        ...input.environment,
      ],
      max: input.max,
    })
  }

  export async function build(input: { root: string; state?: MemorySchema.State }): Promise<Result> {
    const state = input.state ?? (await MemoryFiles.readState(input.root))
    const max = state.limits.maxProjectIndexBytes
    const meta = await MemoryFiles.readMetadata(input.root)
    const now = Date.now()
    const correctionItems = items({
      file: "corrections.md",
      text: await MemoryFiles.readSource(input.root, "corrections.md"),
      max: state.limits.maxLineChars,
      meta,
      now,
    })
    const corrections = lines("CORRECTION", correctionItems)
    const projectItems = items({
      file: "project.md",
      text: await MemoryFiles.readSource(input.root, "project.md"),
      max: state.limits.maxLineChars,
      meta,
      now,
    })
    const important = project(projectItems, { include: ["PROJECT_DECISION", "PROJECT_CONSTRAINT"] })
    const facts = project(projectItems, { exclude: ["PROJECT_DECISION", "PROJECT_CONSTRAINT"] })
    const environmentItems = items({
      file: "environment.md",
      text: await MemoryFiles.readSource(input.root, "environment.md"),
      max: state.limits.maxLineChars,
      meta,
      now,
    })
    const environment = lines("ENV", environmentItems)
    const all = [...correctionItems, ...projectItems, ...environmentItems]
    const recent = (
      await MemoryFiles.recentSessions(input.root, state.limits.maxSessionFiles, state.limits.maxSessionLineChars)
    )
      .filter((item) => !MemoryDigest.empty(item))
      .slice(0, state.limits.maxRecentSessions)
    const current = recent[0] ? [session(recent[0])] : []
    const sessions = recent.slice(1).map((item) => session(item))
    return assemble({
      root: input.root,
      scope: state.scope,
      limits: state.limits,
      max,
      current,
      corrections,
      important,
      hints: hints(all),
      rest: facts,
      environment,
      sessions,
    })
  }

  export async function rebuild(input: { root: string; state?: MemorySchema.State }) {
    const result = await build(input)
    await MemoryFiles.writeIndex(input.root, result.text)
    await MemoryFiles.append(input.root, `regenerate index.kmem bytes=${result.bytes} tokens=${result.tokens}`)
    return result
  }
}
