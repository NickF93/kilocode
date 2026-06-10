import { generateText, streamText } from "ai"
import { Cause, Effect } from "effect"
import z from "zod"
import * as Log from "@opencode-ai/core/util/log"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { InstanceState } from "@/effect/instance-state"
import type { Provider } from "@/provider/provider"
import type { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import type { SessionSummary } from "@/session/summary"
import type { Snapshot } from "@/snapshot"
import { Token } from "@/util/token"
import { ProviderTransform } from "@/provider/transform"
import { KiloMemory, MemoryEvents, MemoryFiles, MemoryOperations, MemoryPaths, MemorySchema } from "."
import { MemoryDigest } from "./digest"
import { MemoryEval } from "./eval"
import { MemoryRedact } from "./redact"

const log = Log.create({ service: "memory.capture" })

const skipReason = z
  .enum([
    "duplicate",
    "transient",
    "unsupported",
    "secret",
    "too_specific",
    "in_progress",
    "policy_belongs_in_docs",
    "quota_guard",
    "rate_limit_guard",
  ])
  .catch("unsupported")

const typedSchema = z.object({
  operations: z
    .array(
      z.object({
        op: z.enum([
          "upsert_project_fact",
          "upsert_project_decision",
          "upsert_project_constraint",
          "upsert_environment_fact",
          "append_correction",
          "remove_memory",
          "noop",
        ]),
        key: z.string().optional(),
        value: z.string().optional(),
        query: z.string().optional(),
        section: z.string().optional(),
      }),
    )
    .max(16),
  skipped: z
    .array(
      z.object({
        reason: skipReason,
        text: z.string().optional(),
        duplicateOf: z.string().optional(),
      }),
    )
    .default([]),
})

const digestSchema = z.object({
  topic: z.string().default(""),
  summary: z.string().default(""),
})

function clean(input: string) {
  return input
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
}

export function parseJson<T>(schema: z.ZodType<T>, input: string) {
  return schema.parse(JSON.parse(clean(input)))
}

const typedPrompt = `You are Kilo's typed memory consolidation step.

Your job is to decide whether the latest session window contains durable, reusable memory worth saving.
Return JSON only. Do not explain.

Memory is expensive because it is injected into future model context. Prefer saving nothing over saving weak or transient details.

Save only information that is likely to help future Kilo sessions in this same project.
Session summaries are saved by a separate digest path. Do not summarize the turn.

High-value project memory:
- User corrections about how Kilo should understand this project.
- Stable project facts: package manager, test commands, build commands, dev commands, important directories, generated-file rules, tech stack, recurring workflows, project conventions, and known pitfalls.
- Stable decisions: chosen architecture, rejected approach with reason, API contract, migration strategy.
- Stable constraints: standing project rules, boundaries, or requirements future Kilo sessions should respect unless current user/repo instructions override them.
- Durable local environment facts that affect this project: sibling repos, local vs remote testing constraints, generated paths, and repo-adjacent fixtures future Kilo sessions may need.

Authority rule:
Memory is local recall context, not policy. Current user instructions, AGENTS.md, checked-in documentation, repo state, and tool output win over memory.
If guidance must always apply to a team, it belongs in AGENTS.md or checked-in docs. Do not rely on memory as the only source for mandatory rules.

Do not save:
- Secrets, tokens, credentials, env values.
- Temporary task status.
- Active, short-lived, or still-in-progress session details.
- One-off file names unless they define a durable convention.
- Exact command output.
- Large code snippets.
- Guesses not supported by the supplied context.
- Anything the user may reasonably consider personal.
- Implementation details that will be obvious from current repo files.
- Facts already present in typed source memory with the same meaning.

Correction rule:
If the user says existing memory is wrong, stale, or should be forgotten, prioritize a correction or removal. Corrections are more important than new facts.

Conflict rule:
If supplied memory conflicts with the current user/repo context, prefer the current user/repo context and output a correction or removal.

Session context rule:
Recent session digests and latest-session context are continuity hints, not durable typed source memory. Do not skip a durable project fact as duplicate merely because it appears in recent session context.
If a durable fact appears in multiple recent session digests and is absent from typed source memory, promote it to typed memory.

Output schema:
{
  "operations": [
    {
      "op": "upsert_project_fact" | "upsert_project_decision" | "upsert_project_constraint" | "upsert_environment_fact" | "append_correction" | "remove_memory" | "noop",
      "key": "stable_key_when_required",
      "value": "short durable value when required",
      "query": "forget query when op is remove_memory",
      "section": "Commands" | "Paths" | "Tooling"
    }
  ],
  "skipped": [
    {
      "reason": "duplicate" | "transient" | "unsupported" | "secret" | "too_specific" | "in_progress" | "policy_belongs_in_docs" | "quota_guard" | "rate_limit_guard",
      "text": "short description",
      "duplicateOf": "source.md:key when the duplicate source is known"
    }
  ]
}

Rules:
- Return at most 16 operations.
- Return {"operations":[],"skipped":[]} when there is nothing worth saving.
- Each key must be lowercase with dots or underscores.
- Each value must be one concise sentence or phrase.
- Use skipped reason "in_progress" for active or short-lived session details.
- Use skipped reason "policy_belongs_in_docs" when a mandatory team rule should be in AGENTS.md or checked-in docs instead of only memory.
- Use skipped reason "quota_guard" or "rate_limit_guard" if the evidence says memory generation should avoid spending limited quota.
- For upsert_environment_fact, use section "Commands" for runnable commands, "Paths" for important directories/files, and "Tooling" for package managers, runtimes, build systems, or test frameworks.
- Omit section for other operations.
- Do not include markdown.
- Do not include commentary outside JSON.

Examples:
- User says tests run from packages/opencode, not repo root: output append_correction with key "test_command".
- Assistant establishes that v0 memory is project-only and stored under the global repo memory folder: output upsert_project_decision.
- User or assistant establishes a standing project requirement such as "memory should stay project-only for v0": output upsert_project_constraint.
- Assistant lists setup commands such as bun install or bun run dev: output upsert_environment_fact with section "Commands".
- Assistant identifies important local paths: output upsert_environment_fact with section "Paths".
- Assistant identifies durable tools such as Bun, Turbo, or Java 21: output upsert_environment_fact with section "Tooling".
- Assistant only says it checked git status or continued a task: output no operations.`

const digestPrompt = `You are Kilo's session digest updater.

Your job is to update one compact handoff digest for the current session.
Return JSON only. Do not explain.

The digest helps a future Kilo turn answer "where did we stop?" or "continue" without reading the full transcript.

Use the previous digest plus the latest completed turn. Preserve useful continuity:
- current objective
- completed work
- important files or areas touched
- important decisions or constraints from this session
- next concrete step
- blockers or failed checks

Do not copy transcript text, command output, logs, secrets, raw failure output, or large code snippets.
Preserve transient failure details only when they remain a real blocker or next step.
Do not summarize branch names, git status, latest commits, current working directory, or untracked files as handoff state unless the user's actual task is about git/rebase/commit history and there is a concrete next step.
If the latest turn only reconciles current repo status against memory, keep the previous digest. If there is no previous digest, return an empty summary.
Do not create durable project memory here; typed memory consolidation handles project facts, decisions, and corrections separately.

Output schema:
{
  "topic": "2-6 word label for this session",
  "summary": "one compact paragraph, no markdown"
}

Rules:
- Keep topic short and specific enough to choose between recent sessions.
- Keep the summary within the supplied max characters.
- Prefer concrete file names, decisions, and next steps over generic progress.
- If the latest turn is vague and adds no useful state, preserve the previous digest.
- Return an empty summary only when both previous digest and latest turn are empty.`

const words = [
  "remember",
  "save",
  "forget",
  "memory",
  "note that",
  "always",
  "never",
  "actually",
  "correction",
  "correct",
  "wrong",
  "stale",
  "incorrect",
  "prefer",
  "we use",
  "run tests?",
  "command",
  "commands",
  "setup",
  "set up",
  "install",
  "dependencies",
  "package manager",
  "decision",
  "decided",
  "architecture",
  "architectural",
  "approach",
  "contract",
  "convention",
  "migration",
  "strategy",
  "constraint",
  "constraints",
  "requirement",
  "requirements",
  "boundary",
  "boundaries",
  "must",
  "do not",
  "generated-file",
  "generated file",
  "generated files",
  "important directory",
  "test command",
  "build command",
  "dev command",
  "run dev",
  "start app",
  "use bun",
  "use pnpm",
  "use npm",
  "bun install",
  "bun run",
  "pnpm install",
  "npm install",
  "yarn install",
  "local",
  "remote",
  "outside the repo",
  "sibling repos?",
  "workspace",
  "directory",
  "paths?",
]
const signals = [new RegExp(`\\b(${words.join("|")})\\b`, "i"), /~\/|\/Users\//]
const outputs = [
  new RegExp(
    `\\b(bun install|bun run|pnpm install|npm install|yarn install|package manager|package scripts|workspace uses|uses bun|use bun|turborepo|turbo|java 21|decision|decided|architecture|architectural|approach|contract|convention|migration|strategy|constraint|constraints|requirement|requirements|boundary|boundaries|test command|typecheck command|lint command|build command|dev command)\\b`,
    "i",
  ),
  /(^|\n)\s*(bun|pnpm|npm|yarn|cargo|go|python|pytest|make)\s+/im,
]
const intent = /\b(remember|save|forget|memory|note that|always|never|actually|correction|correct|wrong|stale|incorrect)\b/i
const durable =
  /(^|\/)(AGENTS\.md|README|docs?\/|package\.json|bun\.lock|pnpm-lock\.yaml|package-lock\.json|turbo\.json|tsconfig[^/]*\.json|vite\.config|eslint|biome|prettier|kilo\.json|\.kilo\/|[^/]*(test|spec|config|command|agent|workflow)[^/]*\.(ts|tsx|js|json|md|yml|yaml))$/i
const vague = /\b(continue|resume|keep going|pick up|where were we)\b/i
const action = /\b(add|build|change|commit|debug|fix|implement\w*|make|remove|review|run|test|update|write)\b/i

function text(parts: MessageV2.Part[]) {
  return parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

function output(parts: MessageV2.Part[]) {
  return parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text.trim()]
      if (part.type === "tool") return [toolSummary(part)]
      return []
    })
    .filter(Boolean)
    .join("\n")
}

function hidden(input: string) {
  const text = input.trim().replaceAll(/\s+/g, " ")
  if (!text) return ""
  if (MemoryRedact.has(text)) return "[redacted]"
  return brief(text, 220)
}

function field(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" ? hidden(value) : ""
}

function exit(input: Record<string, unknown> | undefined) {
  const value = input?.exit
  if (typeof value !== "number" && typeof value !== "string") return ""
  return String(value)
}

export function toolSummary(part: MessageV2.ToolPart) {
  const state = part.state
  const pieces = [`Tool ${part.tool} ${state.status}`]
  const command = field(state.input, "command")
  const file = field(state.input, "filePath")
  const pattern = field(state.input, "pattern")
  const query = field(state.input, "query")
  if (state.status === "completed" || state.status === "running") {
    const title = state.title ? hidden(state.title) : ""
    if (title) pieces.push(`title=${title}`)
  }
  if (command) pieces.push(`command=${command}`)
  if (file) pieces.push(`file=${file}`)
  if (pattern) pieces.push(`pattern=${pattern}`)
  if (query) pieces.push(`query=${query}`)
  if (state.status === "completed") {
    const code = exit(state.metadata)
    if (code) pieces.push(`exit=${code}`)
  }
  if (state.status === "error") {
    const error = hidden(state.error)
    if (error) pieces.push(`error=${error}`)
  }
  return pieces.join(" | ")
}

type UserTurn = MessageV2.WithParts & { info: MessageV2.User }
type AssistantTurn = MessageV2.WithParts & { info: MessageV2.Assistant }
type Reason = "completed" | "error" | "interrupted"

function trace(messages: MessageV2.WithParts[], max: number) {
  return messages
    .flatMap((item) => {
      if (item.info.role === "user") {
        const body = text(item.parts)
        return body ? [`User: ${body}`] : []
      }
      if (item.info.role !== "assistant" || item.info.summary === true || item.info.error) return []
      const body = output(item.parts)
      return body ? [`Assistant: ${body}`] : []
    })
    .slice(-max)
    .join("\n\n")
}

function latest(messages: MessageV2.WithParts[]) {
  const assistant = messages.findLast(
    (item): item is AssistantTurn =>
      item.info.role === "assistant" &&
      Boolean(item.info.finish) &&
      item.info.summary !== true &&
      !item.info.error &&
      Boolean(item.info.parentID),
  )
  if (!assistant) return
  const user = messages.find((item) => item.info.id === assistant.info.parentID)
  if (!user || user.info.role !== "user") return
  return { user: user as UserTurn, assistant }
}

/** True when the turn was answered from memory (targeted recall ran); digesting it would echo memory back into itself. */
function recalledMemory(turn: { user: MessageV2.WithParts; assistant: MessageV2.WithParts }) {
  return [...turn.user.parts, ...turn.assistant.parts].some((part) => {
    if (part.type === "tool") return part.tool === "kilo_memory_recall"
    if (part.type !== "text") return false
    const marker = (part.metadata as { kiloMemory?: { type?: string; count?: number } } | undefined)?.kiloMemory
    return marker?.type === "recall" && (marker.count ?? 0) > 0
  })
}

export function shouldConsider(input: string) {
  return signals.some((item) => item.test(input))
}

export function shouldConsiderOutput(input: string) {
  return outputs.some((item) => item.test(input))
}

export function shouldBypassInterval(input: string) {
  return intent.test(input)
}

export function isVagueContinuation(input: string) {
  const value = input.trim()
  if (value.length > 120) return false
  return vague.test(value) && !action.test(value)
}

export function hasDurableDiff(diffs: Pick<Snapshot.FileDiff, "file" | "additions" | "deletions">[]) {
  return diffs.some((item) => {
    const file = item.file ?? ""
    if (!file) return false
    if (durable.test(file)) return true
    return item.additions + item.deletions >= 20 && /\.(md|json|ya?ml|toml|ts|tsx|js)$/.test(file)
  })
}

export function summarizeDiffs(diffs: Pick<Snapshot.FileDiff, "file" | "status" | "additions" | "deletions">[]) {
  return diffs
    .filter((item) => item.file)
    .slice(0, 20)
    .map((item) => {
      const status = item.status ?? "modified"
      return `${status} ${item.file} +${item.additions} -${item.deletions}`
    })
    .join("\n")
}

type Raw = z.infer<typeof typedSchema>["operations"][number]

function add(op: Raw, file: MemoryOperations.Add["file"], section?: string) {
  const key = op.key?.trim()
  const body = op.value?.trim()
  if (!key || !body) return []
  return [{ action: "add", file, section, key, text: body }] satisfies MemoryOperations.Op[]
}

function envSection(input: string | undefined) {
  const text = input?.trim().toLowerCase()
  if (text === "paths" || text === "path") return "Paths"
  if (text === "tooling" || text === "tools" || text === "tool") return "Tooling"
  return "Commands"
}

function op(file: MemoryOperations.Add["file"], section: string, key: string, text: string) {
  return { action: "add", file, section, key, text } satisfies MemoryOperations.Op
}

export function inferOps(input: { user: string; assistant: string; changed?: string }) {
  const body = [input.user, input.assistant, input.changed ?? ""].join("\n")
  const root = /\b(?:repo|repository|workspace|project)\s+root\b|\bfrom\s+(?:the\s+)?(?:repo\s+)?root\b/i.test(body)
  const run = (command: string) => `Run ${command}${root ? " from the repo root" : ""}.`
  const ops: MemoryOperations.Op[] = []
  const add = (item: MemoryOperations.Op) => {
    if (item.action === "remove") {
      if (!ops.some((prior) => prior.action === "remove" && prior.query === item.query)) ops.push(item)
      return
    }
    if (
      !ops.some(
        (prior) =>
          prior.action === "add" &&
          prior.file === item.file &&
          prior.section === item.section &&
          prior.key === item.key,
      )
    ) {
      ops.push(item)
    }
  }
  const cmd = (key: string, text: string) => add(op("environment.md", "Commands", key, text))
  const tooling = (key: string, text: string) => add(op("environment.md", "Tooling", key, text))
  const correction = (key: string, text: string) => add(op("corrections.md", "Corrections", key, text))

  if (
    /\b(?:use|uses|with)\s+bun\b|\bbun\s+workspaces?\b|\bbun\.lock\b|\bpackage manager\b[^\n.]{0,80}\bbun\b/i.test(body)
  ) {
    tooling("package_manager", "Use Bun for package management and package scripts.")
  }
  if (/\bturborepo\b|\bturbo\b|\bbun turbo\b/i.test(body)) {
    tooling("build_orchestration", "Use Turborepo/Turbo for workspace orchestration.")
  }
  if (/\bjava\s+21\b/i.test(body)) {
    tooling("java_21", "Use Java 21 for project checks or tooling that require it.")
  }
  if (/\bbun install\b/i.test(body)) cmd("install_dependencies", run("bun install"))
  if (/\bbun run dev\b/i.test(body)) cmd("dev_command", run("bun run dev"))
  if (/\bbun turbo typecheck\b/i.test(body)) cmd("typecheck_command", run("bun turbo typecheck"))
  if (/packages\/opencode/i.test(body) && /\bbun test\b/i.test(body)) {
    cmd("cli_tests", "Run bun test from packages/opencode for CLI tests.")
  }
  if (/packages\/kilo-vscode/i.test(body) && /\bbun run (typecheck|lint|test:unit|test)\b/i.test(body)) {
    cmd("vscode_tests", "Run VS Code extension checks from packages/kilo-vscode.")
  }
  if (
    /\b(?:do not|don't|never)\s+(?:run|use)\s+(?:root\s+|the\s+root\s+)?`?bun test`?/i.test(body) ||
    /\bbun test\b[^\n.]{0,100}\bnot\s+from\s+(?:the\s+)?(?:repo\s+)?root\b/i.test(body)
  ) {
    correction("root_bun_test", "Do not run root bun test; run package-level tests instead.")
  }
  return ops
}

export function mergeOps(ops: MemoryOperations.Op[]) {
  const result: MemoryOperations.Op[] = []
  for (const item of ops) {
    if (item.action === "remove") {
      if (!result.some((prior) => prior.action === "remove" && prior.query === item.query)) result.push(item)
      continue
    }
    if (
      !result.some(
        (prior) =>
          prior.action === "add" &&
          prior.file === item.file &&
          prior.section === item.section &&
          prior.key === item.key,
      )
    ) {
      result.push(item)
    }
  }
  return result
}

export function parseOps(input: z.infer<typeof typedSchema>): MemoryOperations.Op[] {
  return input.operations.flatMap((op): MemoryOperations.Op[] => {
    if (op.op === "remove_memory") {
      const query = op.query?.trim() || op.value?.trim() || op.key?.trim()
      return query ? [{ action: "remove", query }] : []
    }
    if (op.op === "append_correction") return add(op, "corrections.md", "Corrections")
    if (op.op === "upsert_project_decision") return add(op, "project.md", "Decisions")
    if (op.op === "upsert_project_constraint") return add(op, "project.md", "Constraints")
    if (op.op === "upsert_project_fact") return add(op, "project.md", "Facts")
    if (op.op === "upsert_environment_fact") return add(op, "environment.md", envSection(op.section))
    return []
  })
}

function cap(input: string, max: number) {
  if (Buffer.byteLength(input) <= max) return input
  const chars: string[] = []
  let bytes = 0
  for (const char of input) {
    const size = Buffer.byteLength(char)
    if (bytes + size > max) break
    chars.push(char)
    bytes += size
  }
  return chars.join("")
}

function body(input: string | undefined, fallback = "(empty)") {
  const text = MemoryRedact.text(input?.trim().replaceAll("```", "'''") ?? "")
  return text || fallback
}

function evidence(sections: { title: string; body?: string }[]) {
  return [
    "```kilo-memory-evidence-v1",
    ...sections.flatMap((section) => [`## ${section.title}`, body(section.body)]),
    "```",
  ].join("\n")
}

function brief(input: string, max: number) {
  const text = input.trim().replaceAll(/\s+/g, " ")
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 3))}...`
}

export function summarize(input: { user: string; assistant: string; max: number }) {
  const user = brief(MemoryRedact.text(input.user), Math.max(24, Math.floor(input.max * 0.45)))
  const assistant = brief(MemoryRedact.text(input.assistant), Math.max(24, Math.floor(input.max * 0.45)))
  const text = [user ? `User: ${user}` : "", assistant ? `Result: ${assistant}` : ""].filter(Boolean).join(" ")
  return brief(text, input.max)
}

export function fallbackDigest(input: { prior?: string; summary: string; max: number }) {
  if (!input.prior?.trim()) return brief(input.summary, input.max)
  const prior = brief(input.prior ?? "", Math.max(0, Math.floor(input.max * 0.55)))
  const latest = brief(input.summary, Math.max(0, input.max - prior.length - 9))
  return brief([prior, latest ? `Latest: ${latest}` : ""].filter(Boolean).join(" "), input.max)
}

export function parseDigest(input: z.infer<typeof digestSchema>, fallback: string, max: number) {
  const summary = brief(input.summary.trim() || fallback, max)
  const topic = brief(input.topic.trim() || summary.split(/[.;:]/)[0] || summary, 80)
  if (MemoryDigest.empty({ topic, summary })) return { topic: "", summary: "" }
  return { topic, summary }
}

export function typedCapture(input: {
  reason?: Reason
  signal: boolean
  interval: boolean
  inferred: number
}) {
  const completed = !input.reason || input.reason === "completed"
  const due = input.signal || input.inferred > 0
  const fresh = !input.interval || input.inferred > 0
  return {
    call: completed && due && fresh,
    work: completed && due && fresh,
  }
}

export function consolidationOptions(model: Provider.Model) {
  if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai") return { store: false }
  return ProviderTransform.smallOptions(model)
}

export function consolidationPrompt(input: {
  model: Provider.Model
  options: Record<string, unknown>
  system: string
}) {
  const openai = input.model.providerID === "openai" && input.model.api.npm === "@ai-sdk/openai"
  const options = openai ? { ...input.options, instructions: input.system } : input.options
  return {
    providerOptions: ProviderTransform.providerOptions(input.model, options),
    system: openai ? undefined : input.system,
  }
}

async function memoryText(input: {
  source: Provider.Model
  language: LanguageModelV3
  options: Record<string, unknown>
  system: string
  prompt: string
  maxOutputTokens: number | undefined
  timeoutMs: number
  temperature?: number
  topP?: number
  topK?: number
}) {
  const ctl = new AbortController()
  const ms = Math.max(1, input.timeoutMs)
  const params = consolidationPrompt({ model: input.source, options: input.options, system: input.system })
  const openai = input.source.providerID === "openai" && input.source.api.npm === "@ai-sdk/openai"
  const common = {
    model: input.language,
    ...(params.system ? { system: params.system } : {}),
    prompt: input.prompt,
    providerOptions: params.providerOptions,
    maxOutputTokens: input.maxOutputTokens,
    abortSignal: ctl.signal,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
  }
  const work = async () => {
    if (!openai) return generateText(common)

    const result = streamText(common)
    const text: string[] = []
    let usage: unknown
    for await (const part of result.fullStream) {
      if (part.type === "text-delta" && part.text) text.push(part.text)
      if (part.type === "finish-step") usage = part.usage
      if (part.type === "finish") usage = part.totalUsage
      if (part.type === "error") throw part.error
    }
    return { text: text.join(""), usage }
  }
  const timeout = Bun.sleep(ms).then(() => {
    ctl.abort()
    throw new Error("memory model timed out")
  })
  try {
    return await Promise.race([work(), timeout])
  } finally {
    ctl.abort()
  }
}

function usage(input: unknown) {
  if (!input || typeof input !== "object") return 0
  const value = input as { totalTokens?: unknown; inputTokens?: unknown; outputTokens?: unknown }
  const num = (item: unknown) => {
    if (typeof item === "number" && Number.isFinite(item)) return item
    if (typeof item !== "object" || item === null) return 0
    const nested = item as { total?: unknown }
    return typeof nested.total === "number" && Number.isFinite(nested.total) ? nested.total : 0
  }
  const total = num(value.totalTokens)
  if (total > 0) return total
  return num(value.inputTokens) + num(value.outputTokens)
}

function detail(input: unknown) {
  if (input === undefined || input === null) return ""
  if (typeof input === "string") return input
  if (input instanceof Error) return input.message
  try {
    return JSON.stringify(input)
  } catch (_error) {
    return String(input)
  }
}

function errorReason(err: unknown) {
  if (!(err instanceof Error)) return brief(String(err), 500)
  const value = err as Error & {
    cause?: unknown
    data?: unknown
    responseBody?: unknown
    response?: unknown
    status?: unknown
    statusCode?: unknown
  }
  const parts = [
    err.message,
    value.status === undefined ? "" : `status=${detail(value.status)}`,
    value.statusCode === undefined ? "" : `statusCode=${detail(value.statusCode)}`,
    value.data === undefined ? "" : `data=${detail(value.data)}`,
    value.responseBody === undefined ? "" : `body=${detail(value.responseBody)}`,
    value.response === undefined ? "" : `response=${detail(value.response)}`,
    value.cause === undefined ? "" : `cause=${detail(value.cause)}`,
  ].filter(Boolean)
  return brief(parts.join(" "), 500)
}

export function guardReason(input: string) {
  const value = input.toLowerCase()
  if (/\b(429|rate[_ -]?limit|too many requests)\b/.test(value)) return "rate_limit_guard"
  if (/\b(insufficient[_ -]?quota|quota exceeded|exceeded your quota|billing|credits?|credit balance)\b/.test(value))
    return "quota_guard"
  return undefined
}

function audit(ops: MemoryOperations.Op[]) {
  return ops.map((item): NonNullable<MemoryFiles.Decision["operations"]>[number] => {
    if (item.action === "remove") {
      return { action: "remove", query: item.query }
    }
    return {
      action: "add",
      file: item.file,
      section: item.section,
      key: item.key,
    }
  })
}

export function skipped(input: { sessionID: SessionID; reason: string }): MemoryFiles.Decision {
  return {
    kind: "typed",
    trigger: "turn-close",
    sessionID: input.sessionID,
    result: "skipped",
    llm: false,
    parsed: false,
    fallback: false,
    reason: input.reason,
    tokens: 0,
    operationCount: 0,
    skippedCount: 1,
    summary: `memory capture skipped: ${input.reason}`,
  }
}

async function typedExisting(root: string) {
  const files = ["project.md", "environment.md", "corrections.md"] as const
  const blocks = await Promise.all(
    files.map(async (file) => {
      const body = (await MemoryFiles.readSource(root, file)).trim()
      if (!body) return ""
      return [`### source ${file}`, body].join("\n")
    }),
  )
  return blocks.filter(Boolean).join("\n")
}

const common = new Set([
  "about",
  "already",
  "command",
  "commands",
  "from",
  "into",
  "project",
  "should",
  "that",
  "this",
  "with",
])

type Skip = z.infer<typeof typedSchema>["skipped"][number]
type SourceItem = { id: string; text: string }

function tokens(input: string) {
  const found = input
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_.-]{2,}/g)
    ?.map((item) => item.replaceAll(/[_.-]+/g, "_"))
    .filter((item) => !common.has(item))
  return [...new Set(found ?? [])]
}

function itemSource(file: MemorySchema.Source, text: string) {
  const result: SourceItem[] = []
  for (const raw of text.split("\n")) {
    const match = raw.trim().match(/^-\s*([^:]+?)\s*::\s*(.+)$/)
    if (!match) continue
    const key = match[1].trim()
    const body = match[2].trim()
    if (!key || !body) continue
    result.push({ id: `${file}:${key}`, text: `${key} ${body}` })
  }
  return result
}

async function typedItems(root: string) {
  const files = ["project.md", "environment.md", "corrections.md"] as const
  const lists = await Promise.all(files.map(async (file) => itemSource(file, await MemoryFiles.readSource(root, file))))
  return lists.flat()
}

function duplicate(text: string | undefined, items: SourceItem[]) {
  if (!text) return
  const query = tokens(text)
  if (query.length === 0) return
  // Majority overlap required: a few shared generic terms must not confirm a duplicate.
  const needed = Math.max(Math.min(3, query.length), Math.ceil(query.length / 2))
  const hits = items
    .map((item) => {
      const hay = tokens(item.text)
      const found = query.filter((term) => hay.includes(term)).length
      return { item, found }
    })
    .filter((item) => item.found >= needed)
    .sort((a, b) => b.found - a.found)
  return hits.at(0)?.item.id
}

function slug(text: string) {
  return (
    text
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "_")
      .replaceAll(/^_+|_+$/g, "")
      .split("_")
      .filter(Boolean)
      .slice(0, 5)
      .join("_") || "memory"
  )
}

/** Model-claimed duplicates are verified against stored entries; unconfirmed claims are rescued as ops instead of lost. */
function verifySkips(input: { skipped: Skip[]; items: SourceItem[] }) {
  const skipped: Skip[] = []
  const rescued: MemoryOperations.Op[] = []
  for (const item of input.skipped) {
    if (item.reason !== "duplicate" || !item.text) {
      skipped.push(item)
      continue
    }
    const source = duplicate(item.text, input.items)
    if (source) {
      skipped.push({ ...item, duplicateOf: item.duplicateOf ?? source })
      continue
    }
    rescued.push({ action: "add", file: "project.md", section: "Facts", key: slug(item.text), text: item.text })
  }
  return { skipped, rescued }
}

function duplicateOps(input: { ops: MemoryOperations.Op[]; skipped: Skip[]; items: SourceItem[] }) {
  const skipped = [...input.skipped]
  const ops = input.ops.filter((item) => {
    if (item.action !== "add") return true
    const source = duplicate(`${item.key} ${item.text}`, input.items)
    if (!source) return true
    skipped.push({ reason: "duplicate", text: item.text, duplicateOf: source })
    return false
  })
  return { ops, skipped }
}

function attr(input: string | undefined) {
  if (!input) return ""
  return input
    .replaceAll(/\s+/g, "_")
    .replaceAll(/[^A-Za-z0-9_.:/=-]/g, "")
    .slice(0, 160)
}

function skipLine(input: Skip[]) {
  const item = input.at(0)
  if (!item) return ""
  const reason = attr(item.reason)
  const source = attr(item.duplicateOf)
  return [reason ? `reason=${reason}` : "", source ? `duplicateOf=${source}` : ""].filter(Boolean).join(" ")
}

function refs(ops: MemoryOperations.Op[]) {
  return [
    ...new Set(
      ops.flatMap((item) => {
        if (item.action !== "add" || !item.file) return []
        return [`${item.file}:${item.key}`]
      }),
    ),
  ]
}

function files(ops: MemoryOperations.Op[]) {
  return [
    ...new Set(
      ops.flatMap((item) => {
        if (item.action !== "add" || !item.file) return []
        return [item.file]
      }),
    ),
  ]
}

function notice(input: {
  count: number
  ops: MemoryOperations.Op[]
  skipped: Skip[]
  tokens: number
}): MemoryEvents.Status["detail"] | undefined {
  const references = refs(input.ops)
  if (input.count > 0) {
    return {
      type: "saved",
      message: `Memory saved · ${references.join(", ") || `${input.count} ops`}`,
      tokens: input.tokens,
      operationCount: input.count,
      sources: references,
      files: files(input.ops),
    }
  }
  return undefined
}

export namespace MemoryCapture {
  export const turn = Effect.fn("MemoryCapture.turn")(function* (input: {
    sessionID: SessionID
    sessions: Session.Interface
    summary: SessionSummary.Interface
    provider: Provider.Interface
    reason?: Reason
  }) {
    const ctx = yield* InstanceState.context
    const root = MemoryPaths.root({ ctx })
    const started = Date.now()
    if (!MemoryEval.shouldCapture()) {
      const reason = `eval_${MemoryEval.mode()}_capture_disabled`
      MemoryEval.captured({ root, reason })
      return { skipped: true, reason }
    }
    yield* Effect.promise(() => KiloMemory.prepare({ ctx }))
    const state = yield* Effect.promise(() => MemoryFiles.readState(root))
    const skip = (reason: string) =>
      Effect.promise(async () => {
        MemoryEval.captured({ root, reason, ms: Date.now() - started })
        if (state.enabled) await MemoryFiles.decide(root, skipped({ sessionID: input.sessionID, reason }))
        await MemoryEvents.publish({
          event: "status",
          payload: MemoryEvents.status({
            root,
            state,
            phase: "skipped",
            reason,
            sessionID: input.sessionID,
          }),
        })
        return { skipped: true, reason }
      })
    if (!state.enabled || !state.capture.turnClose) return yield* skip("disabled")
    const now = Date.now()
    const messages = yield* input.sessions.messages({ sessionID: input.sessionID })
    const turn = latest(messages)
    if (!turn) return yield* skip("no_turn")
    const user = text(turn.user.parts)
    const assistant = output(turn.assistant.parts)
    const recent = trace(messages, 8)
    const summary = summarize({ user, assistant, max: state.limits.maxSessionLineChars })
    const diffs = yield* input.summary
      .computeDiff({ messages })
      .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
    const changed = summarizeDiffs(diffs)
    const durable = hasDurableDiff(diffs)
    const inferred = inferOps({ user, assistant, changed }).slice(0, state.capture.maxOpsPerRun)
    const completed = !input.reason || input.reason === "completed"
    // Echo = short lookup answered from memory with no file changes. Long recall-assisted answers
    // (research, investigations) carry new content and must still be digested.
    const echo = !durable && assistant.length < 1200 && recalledMemory(turn)
    const session = completed && !echo && Boolean(summary && (!isVagueContinuation(user) || durable))
    const prior = session
      ? yield* Effect.promise(() =>
          MemoryFiles.readSession(root, { sessionID: input.sessionID, max: state.limits.maxSessionLineChars }),
        )
      : undefined
    const priorTime = prior?.time ? Date.parse(prior.time) : 0
    const digestDue =
      session && (!prior || !Number.isFinite(priorTime) || now - priorTime >= state.capture.minIntervalMs || durable)
    const signal =
      shouldConsider(user) ||
      shouldConsiderOutput(assistant) ||
      shouldConsider(recent) ||
      shouldConsiderOutput(recent) ||
      durable
    const interval = Boolean(
      state.stats.lastConsolidatedAt &&
        now - state.stats.lastConsolidatedAt < state.capture.minIntervalMs &&
        !shouldBypassInterval(user) &&
        !durable,
    )
    const typed = typedCapture({ reason: input.reason, signal, interval, inferred: inferred.length })
    const typedCall = state.autoConsolidate && typed.call && !echo
    const typedWork = state.autoConsolidate && typed.work && !echo

    if (!digestDue && !typedWork) {
      if (echo && completed) return yield* skip("memory_echo")
      if (interval && signal && (input.reason === undefined || input.reason === "completed"))
        return yield* skip("interval")
      return yield* skip("no_signal")
    }
    yield* Effect.promise(() =>
      MemoryEvents.publish({
        event: "status",
        payload: MemoryEvents.status({ root, state, phase: "checking", sessionID: input.sessionID }),
      }),
    )

    const model =
      digestDue || typedCall
        ? yield* Effect.gen(function* () {
            const model = yield* input.provider.getModel(turn.user.info.model.providerID, turn.user.info.model.modelID)
            const language = yield* input.provider.getLanguage(model)
            const options = consolidationOptions(model)
            // No output cap for openai: the ChatGPT OAuth responses backend 400s on max_output_tokens.
            // No 1024 clamp elsewhere: reasoning models reject caps below the thinking budget.
            const maxOutputTokens =
              (model.providerID === "openai" && model.api.npm === "@ai-sdk/openai") ||
              (model.api.npm === "@ai-sdk/openai-compatible" && model.api.id.toLowerCase().includes("gpt-5"))
                ? undefined
                : ProviderTransform.maxOutputTokens(model)
            const temperature = ProviderTransform.temperature(model)
            const topP = ProviderTransform.topP(model)
            const topK = ProviderTransform.topK(model)
            return { source: model, language, options, maxOutputTokens, temperature, topP, topK }
          })
        : undefined
    const fallback = MemoryRedact.text(
      fallbackDigest({ prior: prior?.summary, summary, max: state.limits.maxSessionLineChars }),
    )
    const safe = MemoryDigest.empty(fallback) ? "" : fallback
    const digestEffect = digestDue
      ? Effect.gen(function* () {
          const body = cap(
            evidence([
              { title: "previous_digest", body: prior?.summary },
              { title: "latest_user", body: user },
              { title: "latest_assistant", body: assistant || "(no assistant text)" },
              { title: "diff_summary", body: changed || "(none)" },
              { title: "max_characters", body: String(state.limits.maxSessionLineChars) },
            ]),
            state.limits.maxConsolidationInputBytes,
          )
          const result = yield* Effect.tryPromise({
            try: () =>
              memoryText({
                source: model!.source,
                language: model!.language,
                options: model!.options,
                system: digestPrompt,
                prompt: body,
                maxOutputTokens: model!.maxOutputTokens,
                timeoutMs: state.capture.timeoutMs,
                temperature: model!.temperature,
                topP: model!.topP,
                topK: model!.topK,
              }),
            catch: (error) => error,
          }).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((err: unknown) =>
              Effect.gen(function* () {
                const raw = errorReason(err)
                const reason = MemoryRedact.text(guardReason(raw) ?? raw)
                yield* Effect.promise(() =>
                  MemoryEvents.publish({
                    event: "error",
                    payload: MemoryEvents.status({
                      root,
                      state,
                      phase: "error",
                      reason,
                      sessionID: input.sessionID,
                    }),
                  }),
                )
                yield* Effect.promise(() => MemoryFiles.append(root, `digest error=${brief(reason, 160)} fallback=1`))
                return { ok: false as const, reason }
              }),
            ),
          )
          if (!result.ok) {
            return {
              topic: "",
              summary: safe,
              tokens: 0,
              reason: result.reason,
            }
          }
          const parsed = yield* Effect.try({
            try: () => parseJson(digestSchema, result.result.text),
            catch: (error) => error,
          }).pipe(
            Effect.catch((err: unknown) =>
              Effect.gen(function* () {
                const reason = MemoryRedact.text(errorReason(err))
                yield* Effect.promise(() =>
                  MemoryFiles.append(root, `digest parse_error=${brief(reason, 160)} fallback=1`),
                )
                return undefined
              }),
            ),
          )
          if (!parsed) {
            return { topic: "", summary: safe, tokens: usage(result.result.usage), reason: "parse_error" }
          }
          const parsedDigest = parseDigest(parsed, fallback, state.limits.maxSessionLineChars)
          return {
            topic: MemoryRedact.text(parsedDigest.topic),
            summary: MemoryRedact.text(parsedDigest.summary),
            tokens: usage(result.result.usage),
            reason: undefined as string | undefined,
          }
        })
      : Effect.succeed({
          topic: "",
          summary: "",
          tokens: 0,
          reason: undefined as string | undefined,
        })
    const typedEffect = typedCall
      ? Effect.gen(function* () {
          const existing = yield* Effect.promise(() => typedExisting(root))
          const items = yield* Effect.promise(() => typedItems(root))
          const sessions = yield* Effect.promise(() =>
            MemoryFiles.recentSessions(root, state.limits.maxSessionFiles, state.limits.maxSessionLineChars),
          )
          const fallback = mergeOps(
            inferOps({
              user: recent,
              assistant: existing,
              changed,
            }),
          ).slice(0, state.capture.maxOpsPerRun)
          const body = cap(
            evidence([
              { title: "existing_memory", body: existing },
              { title: "close_reason", body: input.reason ?? "completed" },
              { title: "latest_user", body: user },
              { title: "latest_assistant", body: assistant || "(no assistant text)" },
              { title: "recent_session_context", body: recent },
              {
                title: "recent_memory_digests",
                body: sessions
                  .map((item) => `${item.file} session=${item.id} ${item.time} :: ${item.summary}`)
                  .join("\n"),
              },
              { title: "diff_summary", body: changed || "(none)" },
            ]),
            state.limits.maxConsolidationInputBytes,
          )
          const result = yield* Effect.tryPromise({
            try: () =>
              memoryText({
                source: model!.source,
                language: model!.language,
                options: model!.options,
                system: typedPrompt,
                prompt: body,
                maxOutputTokens: model!.maxOutputTokens,
                timeoutMs: state.capture.timeoutMs,
                temperature: model!.temperature,
                topP: model!.topP,
                topK: model!.topK,
              }),
            catch: (error) => error,
          }).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((err: unknown) =>
              Effect.gen(function* () {
                const raw = errorReason(err)
                const reason = MemoryRedact.text(guardReason(raw) ?? raw)
                yield* Effect.promise(() =>
                  MemoryEvents.publish({
                    event: "error",
                    payload: MemoryEvents.status({
                      root,
                      state,
                      phase: "error",
                      reason,
                      sessionID: input.sessionID,
                    }),
                  }),
                )
                yield* Effect.promise(() =>
                  MemoryFiles.append(root, `consolidate error=${brief(reason, 160)} fallbackOps=${fallback.length}`),
                )
                return { ok: false as const, reason }
              }),
            ),
          )
          if (!result.ok) {
            return {
              ops: [] as MemoryOperations.Op[],
              tokens: 0,
              fallback: true,
              reason: result.reason,
              skipped: [] as z.infer<typeof typedSchema>["skipped"],
              fallbackOperationCount: fallback.length,
            }
          }
          const parsed = yield* Effect.try({
            try: () => parseJson(typedSchema, result.result.text),
            catch: (error) => error,
          }).pipe(
            Effect.catch((err: unknown) =>
              Effect.gen(function* () {
                const reason = MemoryRedact.text(errorReason(err))
                yield* Effect.promise(() =>
                  MemoryFiles.append(
                    root,
                    `consolidate parse_error=${brief(reason, 160)} fallbackOps=${fallback.length}`,
                  ),
                )
                return undefined
              }),
            ),
          )
          if (!parsed) {
            return {
              ops: [] as MemoryOperations.Op[],
              tokens: usage(result.result.usage),
              fallback: true,
              reason: "parse_error",
              skipped: [] as z.infer<typeof typedSchema>["skipped"],
              fallbackOperationCount: fallback.length,
            }
          }
          const verified = verifySkips({ skipped: parsed.skipped, items })
          const deduped = duplicateOps({ ops: parseOps(parsed), skipped: verified.skipped, items })
          return {
            ops: [...deduped.ops, ...verified.rescued],
            tokens: usage(result.result.usage),
            fallback: false,
            reason: undefined as string | undefined,
            skipped: deduped.skipped,
            fallbackOperationCount: 0,
          }
        })
      : Effect.succeed({
          ops: [] as MemoryOperations.Op[],
          tokens: 0,
          fallback: false,
          reason: undefined as string | undefined,
          skipped: [] as z.infer<typeof typedSchema>["skipped"],
          fallbackOperationCount: 0,
        })
    // Digest and typed consolidation are independent model calls; run them concurrently.
    const [digest, generated] = yield* Effect.all([digestEffect, typedEffect], { concurrency: 2 })
    if (digest.summary) {
      yield* Effect.promise(() =>
        KiloMemory.recordSession({
          ctx,
          sessionID: input.sessionID,
          topic: digest.topic,
          summary: digest.summary,
          time: now,
          tokens: digest.tokens,
        }),
      )
    }
    if (digestDue) {
      yield* Effect.promise(() =>
        MemoryFiles.decide(root, {
          kind: "digest",
          trigger: "turn-close",
          sessionID: input.sessionID,
          result: digest.reason ? "fallback" : digest.summary ? "saved" : "skipped",
          llm: true,
          parsed: Boolean(digest.summary && !digest.reason),
          fallback: Boolean(digest.reason),
          reason: digest.reason,
          tokens: digest.tokens,
          operationCount: digest.summary ? 1 : 0,
          skippedCount: digest.summary ? 0 : 1,
          summary: digest.reason
            ? `session digest used fallback after ${digest.reason}`
            : digest.summary
              ? "session digest saved"
              : "session digest skipped",
        }),
      )
    }

    const ops = mergeOps(generated.ops).slice(0, state.capture.maxOpsPerRun)
    const project =
      ops.length > 0
        ? yield* Effect.promise(() => KiloMemory.apply({ ctx, ops, trigger: "turn-close", tokens: generated.tokens }))
        : undefined
    const count = project?.operationCount ?? 0
    if (typedCall) {
      yield* Effect.promise(() =>
        MemoryFiles.decide(root, {
          kind: "typed",
          trigger: "turn-close",
          sessionID: input.sessionID,
          result: generated.fallback ? "fallback" : count > 0 ? "saved" : "skipped",
          llm: true,
          parsed: !generated.fallback,
          fallback: generated.fallback,
          reason: generated.reason,
          tokens: generated.tokens,
          operationCount: count,
          skippedCount: generated.skipped.length,
          fallbackOperationCount: generated.fallbackOperationCount,
          skipped: generated.skipped,
          operations: audit(ops),
          files: [...new Set(ops.flatMap((item) => (item.action === "add" && item.file ? [item.file] : [])))],
          summary: generated.fallback
            ? `typed consolidation fallback skipped ${generated.fallbackOperationCount} inferred ops`
            : count > 0
              ? `typed consolidation saved ${count} ops`
              : `typed consolidation skipped ${generated.skipped.length} candidates`,
        }),
      )
    }
    const tokens = digest.tokens + generated.tokens
    if (!digest.summary && !typedCall && count === 0) return yield* skip("no_ops")
    MemoryEval.captured({ root, tokens, ops: count, ms: Date.now() - started })
    if (digestDue || typedCall || count > 0) {
      yield* Effect.promise(() =>
        MemoryFiles.queue(root, async () => {
          const latest = await MemoryFiles.readState(root)
          await MemoryFiles.writeState(root, {
            ...latest,
            stats: {
              ...latest.stats,
              lastConsolidatedAt: now,
              lastConsolidationCost: 0,
              lastConsolidationTokens: tokens,
              lastOperationCount: count,
            },
          })
          const skip = skipLine(generated.skipped)
          await MemoryFiles.append(
            root,
            [`consolidate trigger=turn-close digest=${digest.summary ? 1 : 0} ops=${count} tokens=${tokens}`, skip]
              .filter(Boolean)
              .join(" "),
          )
        }),
      )
    }
    const updated = yield* Effect.promise(() => MemoryFiles.readState(root))
    const index =
      project?.index ??
      (yield* Effect.promise(async () => {
        const text = await MemoryFiles.readIndex(root)
        return { bytes: Buffer.byteLength(text), tokens: Token.estimate(text), truncated: false }
      }))
    const detail = typedCall
      ? notice({
          count,
          ops,
          skipped: generated.skipped,
          tokens: generated.tokens,
        })
      : undefined
    yield* Effect.promise(() =>
      MemoryEvents.publish({
        event: "status",
        payload: MemoryEvents.status({
          root,
          state: updated,
          index,
          phase: "idle",
          sessionID: input.sessionID,
          consolidation: { trigger: "turn-close", operationCount: count, cost: 0, tokens },
          ...(detail ? { detail } : {}),
        }),
      }),
    )
    return { skipped: false, operationCount: count, tokens }
  })

  export function report(cause: Cause.Cause<unknown>) {
    // Brief message only: API errors carry response headers/bodies that would flood the TUI log.
    const err = Cause.squash(cause)
    log.warn("memory capture failed", {
      err: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    })
  }
}
