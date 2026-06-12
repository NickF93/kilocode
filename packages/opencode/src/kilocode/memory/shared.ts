import type { MemoryOperations } from "./operations"
import { MemoryFiles } from "./files"
import { MemorySchema } from "./schema"
import { MemoryTopics } from "./topics"

export namespace MemoryShared {
  export type TypedItem = {
    file: MemorySchema.Source
    section: string
    key: string
    text: string
    topics: MemorySchema.Topic[]
    terms: string[]
    updatedAt?: number
  }

  export type SourceItem = {
    id: string
    text: string
  }

  export function brief(input: string, max: number) {
    const text = input.trim().replaceAll(/\s+/g, " ")
    if (text.length <= max) return text
    return `${text.slice(0, Math.max(0, max - 3))}...`
  }

  export function entry(input: string) {
    const idx = input.indexOf(" :: ")
    if (idx < 0) return
    const key = input.slice(0, idx).trim()
    const text = input.slice(idx + 4).trim()
    if (!key || !text) return
    return { key, text }
  }

  export function terms(input: string, noise = new Set<string>()) {
    const found = input
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_.-]{2,}/g)
      ?.map((item) => item.replaceAll(/[_.-]+/g, "_"))
      .filter((item) => !noise.has(item))
    return [...new Set(found ?? [])]
  }

  export function source(input: { file: MemorySchema.Source; text: string }): SourceItem[] {
    const result: SourceItem[] = []
    for (const raw of input.text.split("\n")) {
      const item = entry(raw.trim().replace(/^- /, ""))
      if (!item) continue
      result.push({ id: `${input.file}:${item.key}`, text: `${item.key} ${item.text}` })
    }
    return result
  }

  export function typed(input: {
    file: MemorySchema.Source
    text: string
    max: number
    meta: MemoryFiles.Metadata
    now: number
  }) {
    const result: TypedItem[] = []
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
        text: brief(item.text, input.max),
        topics: meta?.topics?.length ? meta.topics : MemoryTopics.assign(data),
        terms: meta?.terms?.length ? meta.terms : MemoryTopics.terms(data),
        updatedAt: meta?.updatedAt,
      })
    }
    return result
  }

  export function refs(ops: MemoryOperations.Op[]) {
    return [
      ...new Set(
        ops.flatMap((item) => {
          if (item.action !== "add" || !item.file) return []
          return [`${item.file}:${item.key}`]
        }),
      ),
    ]
  }

  export function files(ops: MemoryOperations.Op[]) {
    return [
      ...new Set(
        ops.flatMap((item) => {
          if (item.action !== "add" || !item.file) return []
          return [item.file]
        }),
      ),
    ]
  }

  export function audit(ops: MemoryOperations.Op[]) {
    return ops.map((item) =>
      item.action === "add"
        ? {
            action: item.action,
            file: item.file,
            section: item.section,
            key: item.key,
          }
        : {
            action: item.action,
            query: brief(item.query, 120),
          },
    )
  }
}
