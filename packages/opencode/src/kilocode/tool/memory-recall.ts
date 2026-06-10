import { Effect, Schema } from "effect"
import { Instance } from "@/project/instance"
import * as Tool from "@/tool/tool"
import { Token } from "@/util/token"
import { KiloMemory, MemoryFiles, MemoryRecall, MemorySchema } from "@/kilocode/memory"
import DESCRIPTION from "./memory-recall.txt"

const Parameters = Schema.Struct({
  mode: Schema.Literals(["search", "typed", "digest", "catalog"]).annotate({
    description:
      "'typed' to search durable memory, 'digest' to read saved session digests, 'search' to search both, 'catalog' to list all stored memory keys (use when the injected index or a search missed)",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Topic query for typed memory or digest search; optional substring filter for catalog",
  }),
  sessionID: Schema.optional(Schema.String).annotate({
    description: "Session ID for digest mode when startup memory shows session=<id>",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum memories to return (default: 5, max: 20)",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

export const MemoryRecallTool = Tool.define(
  "kilo_memory_recall",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context) =>
      Effect.tryPromise({ try: () => run(params, ctx), catch: (err) => err }).pipe(
        Effect.catch((err) =>
          Effect.succeed({
            title: "Kilo memory: error",
            output: `Kilo memory recall failed: ${message(err)}`,
            metadata: { files: [] as string[] },
          }),
        ),
      ),
  }),
)

function message(err: unknown) {
  if (err instanceof Error) return err.message
  return String(err)
}

async function audit(input: {
  root: string
  params: Params
  current: string
  hits: MemoryRecall.Hit[]
  skipped?: string
  output: string
}) {
  const files = [...new Set(input.hits.map((hit) => hit.source))]
  const topics = [...new Set(input.hits.flatMap((hit) => (hit.topics?.length ? hit.topics : [hit.kind])))]
  const query =
    input.params.query ??
    (input.params.sessionID
      ? `sessionID=${input.params.sessionID}`
      : input.params.mode === "digest"
        ? "recent digests"
        : undefined)
  await MemoryFiles.queue(input.root, () =>
    MemoryFiles.decide(input.root, {
      kind: "recall",
      trigger: "targeted-recall",
      sessionID: input.current,
      result: input.hits.length ? "recalled" : "skipped",
      llm: false,
      parsed: false,
      fallback: false,
      reason: input.skipped,
      query,
      topics,
      files,
      tokens: Token.estimate(input.output),
      operationCount: input.hits.length,
      skippedCount: input.hits.length ? 0 : 1,
      summary: input.hits.length
        ? `memory recall returned ${input.hits.length} ${input.params.mode} hits`
        : `memory recall found no ${input.params.mode} hits`,
    }),
  )
}

function miss(input: { params: Params; current: string }) {
  const self = input.params.sessionID === input.current
  if (self && input.params.mode === "digest") {
    return `Session "${input.params.sessionID}" is the active session, so it has no saved memory digest yet. Do not read the active session transcript as memory; use injected memory or search recent saved digests.`
  }
  if (input.params.sessionID && input.params.mode === "digest") {
    return `No useful saved memory digest found for session "${input.params.sessionID}".`
  }
  return `No ${input.params.mode} memory matched the query.`
}

function prompt(messages: Tool.Context["messages"]) {
  return messages
    .slice()
    .reverse()
    .find((item) => item.info.role === "user")
    ?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
}

function resolve(input: { params: Params; prompt?: string }) {
  const query = input.params.query?.trim() ?? ""
  const stale =
    input.params.mode === "digest" &&
    !!input.params.sessionID &&
    !query &&
    !!input.prompt &&
    MemoryRecall.continuation(input.prompt)
  if (!stale) return input.params
  return { ...input.params, sessionID: undefined }
}

const CATALOG_MAX_BYTES = 8192

/** Compact keys listing so the model can semantically scan everything that did not fit the injected index. */
async function catalog(input: { root: string; query: string }) {
  const meta = await MemoryFiles.readMetadata(input.root)
  const now = Date.now()
  const filter = input.query.toLowerCase()
  const lines: string[] = []
  const files: string[] = []
  let count = 0
  for (const file of MemorySchema.sources()) {
    const text = await MemoryFiles.readSource(input.root, file)
    let section = "Facts"
    const rows: string[] = []
    for (const raw of text.split("\n")) {
      const line = raw.trim()
      if (line.startsWith("## ")) {
        section = line.slice(3).trim() || section
        continue
      }
      const idx = line.indexOf(" :: ")
      if (!line.startsWith("- ") || idx < 0) continue
      const key = line.slice(2, idx).trim()
      const value = line.slice(idx + 4).trim()
      if (!key || !value) continue
      if (MemoryFiles.expired({ data: meta, file, section, key, text: value, now })) continue
      if (filter && !`${key} ${value}`.toLowerCase().includes(filter)) continue
      rows.push(`- ${key} :: ${value.length > 60 ? `${value.slice(0, 57)}...` : value}`)
    }
    if (rows.length === 0) continue
    files.push(file)
    lines.push(`## ${file}`, ...rows)
    count += rows.length
  }
  const head = `# Kilo Memory Catalog (${count} entr${count === 1 ? "y" : "ies"}${filter ? `, filter "${input.query}"` : ""})`
  const body = [head, ...lines].join("\n")
  const output =
    Buffer.byteLength(body) > CATALOG_MAX_BYTES
      ? `${body.slice(0, CATALOG_MAX_BYTES)}\n[truncated: refine with a query filter]`
      : body
  return { output: count ? output : "No stored memory entries matched.", count, files }
}

async function run(initial: Params, ctx: Tool.Context) {
  const params = resolve({ params: initial, prompt: prompt(ctx.messages) })
  const current = ctx.sessionID
  const root = await KiloMemory.prepare({ ctx: { directory: Instance.directory, worktree: Instance.worktree } })
  const state = await MemoryFiles.readState(root)
  if (!state.enabled) {
    return {
      title: "Kilo memory: disabled",
      output: "Kilo memory is disabled for this project.",
      metadata: { files: [] as string[] },
    }
  }

  const query = params.query?.trim() ?? ""
  if (params.mode === "catalog") {
    const result = await catalog({ root, query })
    await MemoryFiles.queue(root, () =>
      MemoryFiles.decide(root, {
        kind: "recall",
        trigger: "targeted-recall",
        sessionID: current,
        result: result.count ? "recalled" : "skipped",
        llm: false,
        parsed: false,
        fallback: false,
        query: query || "all keys",
        files: result.files,
        tokens: Token.estimate(result.output),
        operationCount: result.count,
        skippedCount: result.count ? 0 : 1,
        summary: `memory catalog listed ${result.count} entries`,
      }),
    )
    return {
      title: `Kilo memory catalog: ${result.count} entr${result.count === 1 ? "y" : "ies"}`,
      output: result.output,
      metadata: { files: result.files },
    }
  }
  const missing = params.mode !== "digest" && !query
  if (missing) {
    const output = "Provide a topic query for typed/search memory recall."
    await audit({ root, params, current, hits: [], skipped: "missing_query", output })
    return {
      title: `Kilo memory ${params.mode}: no query`,
      output,
      metadata: { files: [] as string[] },
    }
  }

  const limit = Math.max(1, Math.min(params.limit ?? 5, 20))
  const result = await MemoryRecall.search({
    root,
    state,
    mode: params.mode,
    query,
    sessionID: params.sessionID,
    currentSessionID: current,
    limit,
    force: true,
  })
  const hits = result?.hits ?? []
  const self = params.sessionID === current
  const skipped =
    params.sessionID && params.mode === "digest" && hits.length === 0
      ? self
        ? "current_session_digest"
        : "missing_session_digest"
      : undefined
  const output = hits.length ? MemoryRecall.render(hits) : miss({ params, current })
  await audit({ root, params, current, hits, skipped, output })

  if (hits.length === 0) {
    return {
      title: `Kilo memory ${params.mode}: no results`,
      output,
      metadata: { files: [] as string[] },
    }
  }

  return {
    title: `Kilo memory ${params.mode}: ${hits.length} hit${hits.length === 1 ? "" : "s"}`,
    output,
    metadata: { files: [...new Set(hits.map((hit) => hit.source))] },
  }
}
