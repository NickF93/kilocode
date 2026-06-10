import type { MemoryOperation } from "../types/messages/memory"

type Inspect = {
  kind: "inspect"
}

type Operation = {
  kind: "operation"
  operation: MemoryOperation
  text?: string
  query?: string
}

type Usage = {
  kind: "usage"
  reason: string
}

export type ParsedMemoryCommand = Inspect | Operation | Usage

const usage =
  "/memory [project] enable|status|show|inspect|remember <text>|correct <text>|forget <query>|purge|rebuild|disable"

function split(input: string) {
  const match = input.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/)
  return {
    head: match?.[1]?.toLowerCase(),
    tail: (match?.[2] ?? "").trim(),
  }
}

function target(input: string) {
  const parts = split(input)
  if (parts.head === "project") return { rest: parts.tail }
  if (parts.head === "personal") return { rest: parts.tail, error: "Personal memory is not supported in v0." }
  return { rest: input.trim() }
}

function operation(verb: string, text: string): ParsedMemoryCommand | undefined {
  if (verb === "enable" || verb === "disable" || verb === "rebuild" || verb === "purge") {
    return { kind: "operation", operation: verb }
  }
  if (verb === "remember" || verb === "correct") {
    if (text) return { kind: "operation", operation: verb, text }
    return { kind: "usage", reason: `Missing ${verb === "remember" ? "text" : "correction"}.\n${usage}` }
  }
  if (verb === "forget") {
    if (text) return { kind: "operation", operation: "forget", query: text }
    return { kind: "usage", reason: `Missing query.\n${usage}` }
  }
}

function blocked(verb: string): ParsedMemoryCommand | undefined {
  if (verb === "use-personal" || verb === "personal-context" || verb === "personal-in-project")
    return { kind: "usage", reason: `Personal memory is not supported in v0.\n${usage}` }
}

export function parseMemoryCommand(input: string): ParsedMemoryCommand | undefined {
  const match = input.trim().match(/^\/(?:memory|mem)(?:\s+([\s\S]*))?$/i)
  if (!match) return
  const body = (match[1] ?? "").trim()
  if (!body) return { kind: "inspect" }

  const picked = target(body)
  if (picked.error) return { kind: "usage", reason: `${picked.error}\n${usage}` }
  const parts = split(picked.rest)
  const verb = parts.head
  if (!verb) return { kind: "inspect" }
  if (verb === "status" || verb === "show" || verb === "inspect") return { kind: "inspect" }

  const op = operation(verb, parts.tail)
  if (op) return op
  const denied = blocked(verb)
  if (denied) return denied
  return { kind: "usage", reason: `Unknown memory action: ${verb}.\n${usage}` }
}
