import { MemoryFiles } from "./files"
import { MemoryIndexer } from "./indexer"
import { MemoryRedact } from "./redact"
import { MemorySchema } from "./schema"
import { MemoryTopics } from "./topics"

export namespace MemoryOperations {
  export type Add = {
    action: "add"
    file?: MemorySchema.Source
    section?: string
    key: string
    text: string
  }

  export type Remove = {
    action: "remove"
    query: string
  }

  export type Op = Add | Remove

  export type Result = {
    operationCount: number
    added: number
    removed: number
    index: MemoryIndexer.Result
  }

  const noise = new Set([
    "about",
    "across",
    "after",
    "before",
    "from",
    "have",
    "into",
    "needs",
    "should",
    "that",
    "the",
    "this",
    "when",
    "with",
    "work",
  ])

  function key(input: string) {
    return input
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9_.-]+/g, "_")
      .replaceAll(/^_+|_+$/g, "")
      .slice(0, 80)
  }

  function line(input: Add, max: number) {
    if (MemoryRedact.has(input.text) || MemoryRedact.has(input.key)) {
      throw new Error("memory operation rejected secret-like content")
    }
    const id = key(input.key)
    const text = input.text.trim().replaceAll(/\s+/g, " ")
    const body = text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text
    if (!id) throw new Error("memory operation key is required")
    if (!body) throw new Error("memory operation text is required")
    return { key: id, text: body, line: `- ${id} :: ${body}` }
  }

  type Prepared = {
    op: Add
    file: MemorySchema.Source
    section: string
    key: string
    text: string
    line: string
  }

  function end(input: number) {
    const date = new Date(input)
    date.setHours(23, 59, 59, 999)
    return date.getTime()
  }

  function plus(days: number, now: number) {
    return end(now + days * 24 * 60 * 60 * 1000)
  }

  function weekday(day: number, now: number) {
    const date = new Date(now)
    const diff = (day + 7 - date.getDay()) % 7 || 7
    return plus(diff, now)
  }

  function staleAfter(text: string, now: number) {
    const value = text.toLowerCase()
    if (/\btoday\b/.test(value)) return end(now)
    if (/\btomorrow\b/.test(value)) return plus(1, now)
    if (/\bnext week\b/.test(value)) return plus(14, now)
    if (/\bnext month\b/.test(value)) return plus(45, now)
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    const next = value.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/)
    if (!next?.[1]) return undefined
    return weekday(days.indexOf(next[1]), now)
  }

  function valid(scope: MemorySchema.Scope, source: MemorySchema.Source) {
    return (MemorySchema.sources(scope) as readonly MemorySchema.Source[]).includes(source)
  }

  function heading(input: Add, file = input.file) {
    if (input.section) return input.section
    if (file === "environment.md") return "Commands"
    if (file === "corrections.md") return "Corrections"
    return "Facts"
  }

  function source(scope: MemorySchema.Scope, input: Add) {
    if (input.file) return input.file
    return MemorySchema.defaultSource(scope)
  }

  function insert(input: { text: string; section: string; line: string }) {
    const marker = `## ${input.section}`
    const lines = input.text.split("\n")
    const idx = lines.findIndex((item) => item.trim() === marker)
    const prefix = input.line.split(" :: ")[0]
    const without = lines.filter((item) => !item.trim().startsWith(`${prefix} ::`))
    const at = without.findIndex((item) => item.trim() === marker)
    if (idx === -1 || at === -1) {
      const next = `${without.join("\n").trimEnd()}\n\n${marker}\n${input.line}\n`
      return { text: next, changed: next !== input.text }
    }
    const head = without.slice(0, at + 1)
    const tail = without.slice(at + 1)
    const next = [...head, input.line, ...tail].join("\n")
    return { text: next, changed: next !== input.text }
  }

  function remove(text: string, keys: Set<string>) {
    if (keys.size === 0) return { text, count: 0 }
    const lines = text.split("\n")
    const kept = lines.filter((item) => {
      const line = item.trim()
      if (!line.startsWith("- ") || !line.includes(" :: ")) return true
      const idx = line.indexOf(" :: ")
      const key = line.slice(2, idx).trim()
      return !keys.has(key)
    })
    return {
      text: kept.join("\n"),
      count: lines.length - kept.length,
    }
  }

  function target(input: { query: string; meta: MemoryFiles.Metadata }) {
    const query = input.query.trim()
    const slug = key(query)
    const keys = new Set<string>()
    const ids = new Set<string>()
    if (!query) return { keys, ids }
    for (const [id, item] of Object.entries(input.meta.items)) {
      const aliases = new Set([id, item.key, `${item.file}:${item.key}`, `${item.file}:${item.section}:${item.key}`])
      if (!aliases.has(query) && (!slug || !aliases.has(slug))) continue
      keys.add(item.key)
      ids.add(id)
    }
    if (ids.size === 0) keys.add(slug || query)
    return { keys, ids }
  }

  function prepare(input: { state: MemorySchema.State; ops: Op[]; max: number }) {
    return input.ops
      .filter((item) => item.action === "add")
      .map((op) => {
        const file = source(input.state.scope, op)
        if (!valid(input.state.scope, file)) throw new Error(`memory source ${file} is not valid for ${input.state.scope}`)
        const section = heading(op, file)
        const item = line(op, input.max)
        return {
          op,
          file,
          section,
          key: item.key,
          text: item.text,
          line: item.line,
        } satisfies Prepared
      })
  }

  function normalized(input: string) {
    return input
      .trim()
      .toLowerCase()
      .replaceAll(/[`'"“”‘’]/g, "")
      .replaceAll(/[^a-z0-9_.-]+/g, " ")
      .replaceAll(/\s+/g, " ")
      .trim()
  }

  function words(input: string) {
    return [
      ...new Set(
        normalized(input)
          .match(/[a-z0-9][a-z0-9_.-]{2,}/g)
          ?.filter((item) => !noise.has(item)) ?? [],
      ),
    ]
  }

  function similar(left: string, right: string) {
    const a = normalized(left)
    const b = normalized(right)
    if (!a || !b) return false
    if (a === b) return true
    if (Math.min(a.length, b.length) >= 24 && (a.includes(b) || b.includes(a))) return true
    const one = words(a)
    const two = words(b)
    const min = Math.min(one.length, two.length)
    if (min < 4) return false
    const overlap = one.filter((item) => two.includes(item)).length
    return overlap / min >= 0.85
  }

  function duplicate(input: { item: Prepared; meta: MemoryFiles.Metadata }) {
    return Object.values(input.meta.items).find(
      (item) =>
        item.file === input.item.file &&
        item.section === input.item.section &&
        (item.key === input.item.key || similar(item.text, input.item.text)),
    )
  }

  function rekey(input: { item: Prepared; key: string }) {
    return {
      ...input.item,
      key: input.key,
      line: `- ${input.key} :: ${input.item.text}`,
    } satisfies Prepared
  }

  export async function apply(input: { root: string; scope?: MemorySchema.Scope; ops: Op[] }) {
    return MemoryFiles.queue(input.root, async () => {
      const state = await MemoryFiles.readState(input.root, input.scope)
      if (!state.enabled) throw new Error(`${state.scope} memory is disabled`)
      const max = state.limits.maxLineChars
      const meta = await MemoryFiles.readMetadata(input.root)
      const ops = input.ops.slice(0, state.capture.maxOpsPerRun)
      const adds = prepare({ state, ops, max })
      let removed = 0
      let added = 0
      let count = 0
      for (const op of ops.filter((item) => item.action === "remove")) {
        const exact = target({ query: op.query, meta })
        for (const source of MemorySchema.sources(state.scope)) {
          const prior = await MemoryFiles.readSource(input.root, source)
          const next = remove(prior, exact.keys)
          removed += next.count
          if (next.count > 0) await MemoryFiles.writeSource(input.root, source, next.text)
        }
        for (const id of exact.ids) delete meta.items[id]
        for (const [id, item] of Object.entries(meta.items)) if (exact.keys.has(item.key)) delete meta.items[id]
        count++
      }

      for (const item of adds) {
        const found = duplicate({ item, meta })
        const nextItem = found ? rekey({ item, key: found.key }) : item
        const prior = await MemoryFiles.readSource(input.root, item.file)
        const next = insert({ text: prior, section: nextItem.section, line: nextItem.line })
        if (next.changed) await MemoryFiles.writeSource(input.root, nextItem.file, next.text)
        const id = MemoryFiles.metaKey({ file: nextItem.file, section: nextItem.section, key: nextItem.key })
        const priorMeta = meta.items[id]
        if (!next.changed && priorMeta) continue
        const now = Date.now()
        const stale = staleAfter(nextItem.text, now)
        const topics = MemoryTopics.assign({
          file: nextItem.file,
          section: nextItem.section,
          key: nextItem.key,
          text: nextItem.text,
        })
        const terms = MemoryTopics.terms({
          file: nextItem.file,
          section: nextItem.section,
          key: nextItem.key,
          text: nextItem.text,
        })
        meta.items[id] = {
          file: nextItem.file,
          section: nextItem.section,
          key: nextItem.key,
          text: nextItem.text,
          topics,
          terms,
          createdAt: priorMeta?.createdAt ?? now,
          updatedAt: now,
          ...(stale ? { staleAfter: stale } : {}),
        }
        added++
        count++
      }
      await MemoryFiles.writeMetadata(input.root, meta)
      const index = await MemoryIndexer.rebuild({ root: input.root, state })
      await MemoryFiles.writeState(input.root, {
        ...state,
        stats: {
          ...state.stats,
          lastOperationCount: count,
        },
      })
      await MemoryFiles.append(input.root, `apply ops=${count} removed=${removed}`)
      return { operationCount: count, added, removed, index } satisfies Result
    })
  }

  export async function forget(input: { root: string; scope?: MemorySchema.Scope; query: string }) {
    return apply({ root: input.root, scope: input.scope, ops: [{ action: "remove", query: input.query }] })
  }
}
