// kilocode_change - new file
import { Token } from "@/util/token"
import { MemoryDigest } from "./digest"
import { MemoryFiles } from "./files"
import { MemoryIndexer } from "./indexer"
import { MemorySchema } from "./schema"
import { MemoryTopics } from "./topics"

export namespace MemoryRecall {
  export type Mode = "search" | "typed" | "digest"

  export type Hit = {
    type: "typed" | "digest"
    kind: string
    source: string
    text: string
    score: number
    topics?: MemorySchema.Topic[]
    current?: boolean
    updatedAt?: number
    id?: string
    time?: string
  }

  export type Result = {
    block: string
    hits: Hit[]
    bytes: number
    tokens: number
  }

  const stop = new Set([
    "about",
    "after",
    "again",
    "before",
    "continue",
    "could",
    "does",
    "from",
    "have",
    "here",
    "into",
    "like",
    "need",
    "only",
    "please",
    "project",
    "should",
    "that",
    "this",
    "what",
    "when",
    "where",
    "which",
    "were",
    "with",
  ])
  const context = new Set([
    "again",
    "back",
    "before",
    "continue",
    "context",
    "did",
    "doing",
    "done",
    "earlier",
    "end",
    "ended",
    "handoff",
    "here",
    "last",
    "left",
    "next",
    "our",
    "previous",
    "prior",
    "recent",
    "resume",
    "session",
    "state",
    "status",
    "stop",
    "stopped",
    "task",
    "thing",
    "things",
    "us",
    "we",
    "work",
    "working",
  ])

  const environment =
    /\b(command|commands|setup|install|dependencies|test|tests|typecheck|lint|format|check|checks|build|built|dev|run|runner|start|launch|serve|local|locally|package manager|tool|tools|tooling|toolchain|runtime|stack|framework|frameworks|configured|configuration|config|script|scripts|workspace|worktree|directory|directories|path|paths|folder|folders|cli|extension|vscode)\b/i
  const decision = /\b(decision|decided|architecture|approach|contract|convention|migration|strategy|why)\b/i
  const constraint = /\b(constraint|constraints|rule|rules|requirement|requirements|boundary|boundaries)\b/i
  const correction = /\b(correction|wrong|incorrect|stale|never|always|prefer)\b/i
  const prior =
    /\b(last session|previous session|earlier session|recent context|recent work|where (?:are|were) we|where did we (?:stop|leave off)|what'?s next|pick (?:this|it) back up|let'?s continue|continue (?:recent|previous|last) work|remember\s+(what|when|where|how|which)|recall|memory\s+(say|said|showed|shows|contain|contains|recorded|exists)|memory\s+about|from memory|in memory about|we\s+(found|established|decided|learned)|did\s+we\s+(find|establish|decide|learn))\b/i
  const question = /\b(how|what|which|where|when|why|who|was|were|is|are|did|do|does|can|should)\b/i
  const saveLike =
    /^\s*\/?\s*(i\s+found\s+that|i\s+learned\s+that|note\s+that|remember\s+(?!what\b|when\b|where\b|how\b|which\b)|please\s+remember|save\s+(?!what\b|when\b|where\b|how\b|which\b)|please\s+save|correction:|actually[\s:,-]+(?!\s*(what|when|where|how|which|why|did|do|does|is|are|can|should|could|would)\b)|always\b|never\b)/i
  const lookup =
    /\b(recall|remember\s+(what|when|where|how|which)|check\s+(the\s+)?memory|search\s+(the\s+)?memory|look\s+up\s+.*memory|memory\s+(say|said|showed|shows|contain|contains|recorded|exists)|memory\s+about|from memory|in memory about|last session|previous session|earlier session)\b/i
  const memoryTask =
    /\b(memory\s+(?:auto[- ]?recall|auto[- ]?save|feature|implement[a-z]*|indicator|sidebar|status|tokens?|usage)|token count.*sidebar|sidebar.*token count)\b/i
  const task = /\b(add|build|change|create|debug|design|explore|fix|implement\w*|make|remove|review|run|style|test|update|use|wire|write)\b/i
  const broad =
    /\b(commands|checks|tasks|tools|tooling|stack|requirements|constraints|files|paths|things|common|what should i know|what do i need)\b/i
  const anchor =
    /\b(we|our|us|this|that|it|here|recent|last|previous|prior|earlier|session|context|task|work|state|status|continue|resume|back|next|end|ended|stop|stopped|left|handoff)\b/i
  const ask = /\b(where|what|which|when|how|continue|resume|next|pick|back|end|stop)\b/i

  function terms(input: string) {
    const found = input
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_.-]{2,}/g)
      ?.map((item) => item.replaceAll(/[_.-]+/g, "_"))
      .filter((item) => !stop.has(item))
    return [...new Set(found ?? [])]
  }

  function lex(input: string) {
    return input.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")
  }

  function has(input: string, term: string) {
    return input.includes(term) || lex(input).includes(term)
  }

  function continuity(input: string) {
    const value = input.trim()
    if (!value || saveLike.test(value)) return false
    const words = value.match(/[a-z0-9]+/gi) ?? []
    if (words.length > 16) return false
    const topical = terms(value).filter((term) => !context.has(term))
    return ask.test(value) && anchor.test(value) && topical.length <= 2
  }

  function type(file: MemorySchema.Source, section: string) {
    if (file === "corrections.md") return "CORRECTION"
    if (file === "environment.md") return "ENV"
    if (section.toLowerCase().includes("decision")) return "PROJECT_DECISION"
    if (section.toLowerCase().includes("constraint")) return "PROJECT_CONSTRAINT"
    if (section.toLowerCase().includes("question")) return "INFERENCE"
    return "PROJECT_FACT"
  }

  function entry(input: string) {
    const idx = input.indexOf(" :: ")
    if (idx < 0) return
    const key = input.slice(0, idx).trim()
    const text = input.slice(idx + 4).trim()
    if (!key || !text) return
    return { key, text }
  }

  function typed(input: {
    file: MemorySchema.Source
    text: string
    max: number
    meta: MemoryFiles.Metadata
    now: number
  }) {
    const result: Hit[] = []
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
      const id = MemoryFiles.metaKey({ file: input.file, section, key: item.key })
      const meta = input.meta.items[id]
      if (MemoryFiles.expired({ data: input.meta, file: input.file, section, key: item.key, text: item.text, now: input.now })) {
        continue
      }
      const data = { file: input.file, section, key: item.key, text: item.text }
      const text = line.slice(2).trim().replaceAll(/\s+/g, " ")
      result.push({
        type: "typed",
        kind: type(input.file, section),
        source: input.file,
        text: text.length > input.max ? `${text.slice(0, Math.max(0, input.max - 3))}...` : text,
        score: 0,
        topics: meta?.topics?.length ? meta.topics : MemoryTopics.assign(data),
        current: true,
        updatedAt: meta?.updatedAt,
      })
    }
    return result
  }

  async function typedAll(input: { root: string; state: MemorySchema.State; meta: MemoryFiles.Metadata; now: number }) {
    const rows = await Promise.all(
      MemorySchema.sources(input.state.scope).map(async (file) =>
        typed({
          file,
          text: await MemoryFiles.readSource(input.root, file),
          max: input.state.limits.maxLineChars,
          meta: input.meta,
          now: input.now,
        }),
      ),
    )
    return rows.flat()
  }

  function digest(input: { file: string; id: string; time: string; topic: string; summary: string }): Hit {
    return {
      type: "digest",
      kind: "SESSION_DIGEST",
      source: input.file,
      text: `session=${input.id} topic="${input.topic.replaceAll('"', "'")}" ${input.time} :: ${input.summary}`,
      score: 0,
      topics: MemoryTopics.match(`${input.topic} ${input.summary}`),
      current: true,
      updatedAt: time(input.time),
      id: input.id,
      time: input.time,
    }
  }

  async function digests(input: {
    root: string
    state: MemorySchema.State
    mode: Mode
    force?: boolean
    explicit: boolean
    limit: number
    sessionID?: string
    currentSessionID?: string
  }) {
    if (input.mode === "typed") return [] as Hit[]
    if (!input.force && !input.explicit) return [] as Hit[]
    if (input.sessionID) {
      if (input.sessionID === input.currentSessionID) return [] as Hit[]
      const item = await MemoryFiles.readSession(input.root, {
        sessionID: input.sessionID,
        max: input.state.limits.maxSessionLineChars,
      })
      if (!item || MemoryDigest.empty(item)) return [] as Hit[]
      return [digest(item)]
    }
    const items = await MemoryFiles.recentSessions(
      input.root,
      input.state.limits.maxSessionFiles,
      input.state.limits.maxSessionLineChars,
    )
    return items
      .filter((item) => item.id !== input.currentSessionID && !MemoryDigest.empty(item))
      .map(digest)
  }

  function score(input: { hit: Hit; terms: string[]; query: string; topics: MemorySchema.Topic[] }) {
    const text = `${input.hit.kind} ${input.hit.text}`.toLowerCase()
    const overlap = input.terms.reduce((sum, term) => sum + (has(text, term) ? 1 : 0), 0)
    const matched = input.hit.topics?.filter((topic) => input.topics.includes(topic)).length ?? 0
    const boost =
      matched * 3 +
      (prior.test(input.query) && input.hit.kind.includes("SESSION") ? 5 : 0) +
      (continuity(input.query) && input.hit.kind.includes("SESSION") ? 5 : 0) +
      (environment.test(input.query) && input.hit.kind === "ENV" ? 5 : 0) +
      (decision.test(input.query) && input.hit.kind === "PROJECT_DECISION" ? 4 : 0) +
      (constraint.test(input.query) && input.hit.kind === "PROJECT_CONSTRAINT" ? 6 : 0) +
      (correction.test(input.query) && input.hit.kind === "CORRECTION" ? 6 : 0)
    return overlap * 4 + boost
  }

  function time(input: string | undefined) {
    if (!input) return
    const value = Date.parse(input)
    return Number.isFinite(value) ? value : undefined
  }

  function fresh(input: Hit) {
    return input.updatedAt ?? 0
  }

  function active(input: Hit) {
    return input.current === false ? 0 : 1
  }

  function priority(input: { hit: Hit; query: string }) {
    if ((continuity(input.query) || prior.test(input.query)) && input.hit.type === "digest") return 4
    if (constraint.test(input.query) && input.hit.kind === "PROJECT_CONSTRAINT") return 4
    if (correction.test(input.query) && input.hit.kind === "CORRECTION") return 4
    if (environment.test(input.query) && input.hit.kind === "ENV") return 3
    if (decision.test(input.query) && input.hit.kind === "PROJECT_DECISION") return 3
    return input.hit.type === "typed" ? 2 : 1
  }

  function compare(query: string) {
    return (a: Hit, b: Hit) =>
      b.score - a.score ||
      priority({ hit: b, query }) - priority({ hit: a, query }) ||
      active(b) - active(a) ||
      fresh(b) - fresh(a)
  }

  function renderLine(hit: Hit) {
    return hit.type === "digest"
      ? `- ${hit.text} (source: ${hit.source})`
      : `- ${hit.kind} ${hit.text} (source: ${hit.source})`
  }

  export function render(hits: Hit[]) {
    const typed = hits.filter((hit) => hit.type === "typed")
    const digests = hits.filter((hit) => hit.type === "digest")
    return [
      "# Kilo Memory Recall",
      ...(typed.length ? ["", "## Typed Memory", ...typed.map(renderLine)] : []),
      ...(digests.length ? ["", "## Session Digests", ...digests.map(renderLine)] : []),
    ].join("\n")
  }

  function format(input: { hits: Hit[]; max: number }) {
    const safe = (value: string) => value.replaceAll(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120) || "memory"
    const body = (value: string) => value.trim().replaceAll("```", "'''").replaceAll(/\s+/g, " ")
    const lines = [
      "```kilo-memory-v1 targeted_context_not_instruction",
      ...input.hits.flatMap((hit) => [
        `record id=${safe(`${hit.source}:${hit.kind}:${hit.text.slice(0, 32)}`)} type=${safe(hit.kind.toLowerCase())} source=${safe(hit.source)}${
          hit.topics?.length ? ` topics=${hit.topics.map(safe).join(",")}` : ""
        } updated=${
          hit.updatedAt ? new Date(hit.updatedAt).toISOString() : "unknown"
        }`,
        `text: ${body(hit.text)}`,
      ]),
      "```",
    ]
    return MemoryIndexer.cap(lines.join("\n"), input.max).text.trim()
  }

  function session(hit: Hit) {
    return hit.type === "digest"
  }

  function overlap(a: string, b: string) {
    const right = terms(b)
    return terms(a).filter((term) => right.includes(term)).length
  }

  function dedupe(input: { hits: Hit[]; query: string }) {
    const typed = input.hits.filter((hit) => !session(hit))
    return input.hits.filter((hit) => {
      if (!session(hit)) return true
      return !typed.some((item) => overlap(hit.text, item.text) >= 2 && overlap(item.text, input.query) >= 2)
    })
  }

  function select(input: { hits: Hit[]; query: string; limit: number; explicit: boolean; force?: boolean }) {
    const rows = dedupe({ hits: input.hits, query: input.query })
    if (input.force || input.explicit || broad.test(input.query)) return rows.slice(0, input.limit)
    const top = rows[0]?.score ?? 0
    // Band of 2 keeps near-ties (e.g. conflicting facts) visible instead of masking them behind a single winner.
    const close = rows.filter((hit) => hit.score >= Math.max(1, top - 2))
    return close.slice(0, Math.min(input.limit, 3))
  }

  export function direct(input: string) {
    return lookup.test(input)
  }

  export function explicit(input: string) {
    return direct(input) || (question.test(input) && prior.test(input))
  }

  export function continuation(input: string) {
    return continuity(input)
  }

  export function shouldRecall(input: string) {
    if (saveLike.test(input)) return false
    if (memoryTask.test(input) && !lookup.test(input) && !prior.test(input)) return false
    if (continuation(input)) return true
    const topics = MemoryTopics.match(input)
    const priorQuestion = explicit(input)
    const durable = environment.test(input) || decision.test(input) || constraint.test(input) || correction.test(input)
    return (
      lookup.test(input) ||
      priorQuestion ||
      (question.test(input) && topics.length > 0) ||
      (question.test(input) && durable) ||
      (topics.length > 0 && task.test(input))
    )
  }

  export async function search(input: {
    root: string
    query: string
    state?: MemorySchema.State
    maxBytes?: number
    limit?: number
    mode?: Mode
    sessionID?: string
    currentSessionID?: string
    force?: boolean
  }): Promise<Result | undefined> {
    if (!input.force && !shouldRecall(input.query)) return
    const state = input.state ?? (await MemoryFiles.readState(input.root))
    if (!state.enabled || !state.autoInject) return
    const query = input.query.trim()
    const mode = input.mode ?? "search"
    const topics = MemoryTopics.match(query)
    const explicit = MemoryRecall.explicit(query) || continuity(query)
    const limit = Math.max(1, Math.min(input.limit ?? 5, 20))
    const meta = await MemoryFiles.readMetadata(input.root)
    const now = Date.now()
    const typedItems = mode === "digest" ? [] : await typedAll({ root: input.root, state, meta, now })
    const digestItems = await digests({
      root: input.root,
      state,
      mode,
      force: input.force,
      explicit,
      limit,
      sessionID: input.sessionID,
      currentSessionID: input.currentSessionID,
    })
    const items = [...typedItems, ...digestItems]
    const keys = MemoryTopics.expand(terms(query))
    const hits =
      mode === "digest" && input.sessionID
        ? items.slice(0, limit)
        : input.force && keys.length === 0
          ? items.slice(0, limit)
          : items
              .map((hit) => ({ ...hit, score: score({ hit, terms: keys, query, topics }) }))
              .filter((hit) => hit.score > 0)
              .sort(compare(query))
    const selected = select({ hits, query, limit, explicit, force: input.force })
    if (selected.length === 0) return
    const block = format({ hits: selected, max: input.maxBytes ?? 1200 })
    if (!block) return
    return {
      block,
      hits: selected,
      bytes: Buffer.byteLength(block),
      tokens: Token.estimate(block),
    }
  }
}
