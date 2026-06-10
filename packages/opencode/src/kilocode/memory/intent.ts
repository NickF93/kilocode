import type { MessageV2 } from "@/session/message-v2"
import { KiloMemory } from "."
import { MemoryFiles } from "./files"
import { MemoryEval } from "./eval"
import { MemoryOperations } from "./operations"
import { MemoryPaths } from "./paths"
import type { MemorySchema } from "./schema"

export namespace MemoryIntent {
  export type Kind = "remember" | "forget" | "correct"

  export type Parsed = {
    kind: Kind
    ops: MemoryOperations.Op[]
  }

  const remember =
    /^\s*(?:please\s+)?(?:remember|note that|save)\b(?:\s+(?:that|this|to|for\s+(?:this\s+)?project))?[\s:,-]+([\s\S]+)$/i
  const rememberQuestion = /^\s*(?:please\s+)?(?:remember|save)\s+(?:what|where|how|which|why)\b/i
  const rememberWhenQuestion = /^\s*(?:please\s+)?(?:remember|save)\s+when\b[\s\S]*\?\s*$/i
  const forget =
    /^\s*(?:please\s+)?(?:forget|remove(?:\s+(?:this|that))?\s+from\s+memory|delete(?:\s+(?:this|that))?\s+from\s+memory)\b[\s:,-]+([\s\S]+)$/i
  const lead = /^(?:actually|correction)[\s:,-]+/i
  const correctionLead = /^correction[\s:,-]+/i
  const require = /^\s*always\b[\s:,-]+([\s\S]+)$/i
  const deny = /^\s*never\b[\s:,-]+([\s\S]+)$/i
  const constraint = /\b(always|must|should|prefer|avoid|never)\b|^when\b[\s\S]+\b(add|run|use|avoid|prefer|keep|do not|don't)\b/i
  const bad = /\b(?:memory|remembered(?:\s+fact)?|stored(?:\s+fact)?)\b[\s\S]*\b(?:wrong|incorrect|stale|outdated)\b/i
  const stale =
    /\b(?:memory|remembered(?:\s+fact)?|stored(?:\s+fact)?)(?:\s+(?:about|for|that))?\s+(.+?)\s+(?:is|was|seems|looks)?\s*(?:wrong|incorrect|stale|outdated)\b/i
  const env =
    /\b(package manager|test command|tests? run|build command|dev command|local|remote|outside the repo|sibling repos?|workspace|directory|path)\b|~\/|\/Users\//i
  const colors = ["yellow", "black", "white", "red", "green", "blue", "purple", "orange", "pink", "gray", "grey"] as const
  const color = /\b(yellow|black|white|red|green|blue|purple|orange|pink|gr[ae]y)\b|#[0-9a-f]{3,8}\b/i
  const kilo = /\bkilo(?:code)?\b/i
  const noise = new Set([
    "that",
    "this",
    "memory",
    "remember",
    "remembered",
    "save",
    "saved",
    "wrong",
    "incorrect",
    "stale",
    "outdated",
    "actually",
    "instead",
    "please",
    "project",
  ])
  const common = new Set(["use", "run", "here", "this", "project", "with", "from"])
  const applied = new Set<string>()
  const order: string[] = []
  const max = 512

  function clean(input: string) {
    const text = input.trim()
    const quoted =
      (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))
        ? text.slice(1, -1)
        : text
    return quoted.trim().replaceAll(/\s+/g, " ")
  }

  function command(input: string) {
    return input.replace(
      /^\/(?=(remember|note\b|forget|remove\b|delete\b|actually\b|correction\b|always\b|never\b))/i,
      "",
    )
  }

  function key(input: string) {
    const semantic = colorKey(input)
    if (semantic) return semantic
    const words = input
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((word) => !noise.has(word))
    return words?.slice(0, 8).join("_").slice(0, 80) || "memory"
  }

  function colorKey(input: string) {
    if (!kilo.test(input) || !color.test(input)) return
    const body = input.toLowerCase()
    const found = colors
      .filter((item) => new RegExp(`\\b${item}\\b`).test(body))
      .map((item) => (item === "grey" ? "gray" : item))
    const names = [...new Set(found)]
    return ["kilo", "brand", ...(names.length ? names : ["colors"])].join("_").slice(0, 80)
  }

  function source(input: string, kind: Kind): MemorySchema.Source {
    if (kind === "correct") return "corrections.md"
    if (env.test(input)) return "environment.md"
    return "project.md"
  }

  function value(input: string) {
    const parts = input
      .split(/\b(?:actually|instead)\b|[:;]/i)
      .map(clean)
      .filter(Boolean)
    return parts.at(-1) ?? clean(input)
  }

  function query(input: string) {
    const words = input.match(/[A-Za-z0-9_.-]+/g)?.filter((word) => !common.has(word.toLowerCase()))
    return words?.[0] ?? clean(input)
  }

  function correction(input: string): MemoryOperations.Op[] {
    const text = value(input)
    const hit = stale.exec(input)
    const query = clean(hit?.[1] ?? "")
    const add: MemoryOperations.Op = {
      action: "add",
      file: "corrections.md",
      section: "Corrections",
      key: key(text),
      text,
    }
    if (!query) return [add]
    return [{ action: "remove", query }, add]
  }

  function text(parts: MessageV2.Part[]) {
    return parts
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .filter((part) => !part.synthetic && !part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
  }

  function mark(id: string) {
    applied.add(id)
    order.push(id)
    while (order.length > max) {
      const old = order.shift()
      if (old) applied.delete(old)
    }
  }

  export function parse(input: string): Parsed | undefined {
    const body = command(clean(input))
    const plain = clean(body.replace(lead, ""))
    const forgotten = forget.exec(plain)
    if (forgotten?.[1]) {
      return {
        kind: "forget",
        ops: [{ action: "remove", query: clean(forgotten[1]) }],
      }
    }

    if (bad.test(body)) {
      return {
        kind: "correct",
        ops: correction(body),
      }
    }

    if (correctionLead.test(body)) {
      const item = clean(body.replace(correctionLead, ""))
      if (item) {
        return {
          kind: "correct",
          ops: [
            {
              action: "add",
              file: "corrections.md",
              section: "Corrections",
              key: key(item),
              text: item,
            },
          ],
        }
      }
    }

    const denied = deny.exec(plain)
    if (denied?.[1]) {
      const item = clean(denied[1])
      return {
        kind: "correct",
        ops: [
          {
            action: "add",
            file: "corrections.md",
            section: "Corrections",
            key: query(item),
            text: `Never ${item}.`,
          },
        ],
      }
    }

    const required = require.exec(plain)
    if (required?.[1]) {
      const item = clean(required[1])
      return {
        kind: "remember",
        ops: [
          {
            action: "add",
            file: "project.md",
            section: "Constraints",
            key: key(item),
            text: `Always ${item}.`,
          },
        ],
      }
    }

    const remembered = remember.exec(plain)
    if (remembered?.[1] && (rememberQuestion.test(plain) || rememberWhenQuestion.test(plain))) return
    if (!remembered?.[1]) return
    const item = clean(remembered[1])
    const fixed = constraint.test(item)
    return {
      kind: "remember",
      ops: [
        {
          action: "add",
          file: fixed ? "project.md" : source(item, "remember"),
          ...(fixed ? { section: "Constraints" } : {}),
          key: key(item),
          text: item,
        },
      ],
    }
  }

  export async function apply(input: { ctx: MemoryPaths.Ctx; message: MessageV2.WithParts; sessionID?: string }) {
    const parsed = parse(text(input.message.parts))
    if (!parsed || parsed.ops.length === 0) return { skipped: true, reason: "no_intent" }
    if (!MemoryEval.shouldCapture()) return { skipped: true, reason: `eval_${MemoryEval.mode()}_capture_disabled` }
    const root = await KiloMemory.prepare({ ctx: input.ctx })
    const state = await MemoryFiles.readState(root)
    if (!state.enabled || !state.capture.explicit) return { skipped: true, reason: "disabled" }
    const id = `${root}:${input.message.info.id}`
    if (applied.has(id)) return { skipped: true, reason: "duplicate" }
    const started = Date.now()
    const result = await KiloMemory.apply({
      ctx: input.ctx,
      ops: parsed.ops,
      trigger: "explicit",
      sessionID: input.sessionID,
    })
    mark(id)
    MemoryEval.captured({ root, ops: result.operationCount, ms: Date.now() - started })
    await MemoryFiles.append(root, `intent kind=${parsed.kind} ops=${result.operationCount}`)
    return { skipped: false, kind: parsed.kind, operationCount: result.operationCount }
  }
}
