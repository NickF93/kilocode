import type { KiloClient } from "@kilocode/sdk/v2"

export const MEMORY_USAGE =
  "/memory [project] enable|status|show|inspect|remember <text>|correct <text>|forget <key>|purge|rebuild|disable"

type MemoryOperation = "enable" | "disable" | "rebuild" | "remember" | "correct" | "forget" | "purge"
type MemoryMutation =
  | { kind: "operation"; operation: "remember" | "correct"; text: string }
  | { kind: "operation"; operation: "forget"; query: string }
  | { kind: "operation"; operation: Exclude<MemoryOperation, "remember" | "correct" | "forget"> }

export type MemoryCommand =
  | { kind: "inspect" }
  | MemoryMutation
  | { kind: "usage"; reason: string }

type Toast = {
  show(input: { message: string; variant: "error" | "info" | "success" }): void
}

type Result<T> = {
  data?: T
  error?: unknown
}

function msg(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch (_error) {
    return String(error)
  }
}

function read<T>(result: Result<T>) {
  if (result.error) throw new Error(msg(result.error))
  if (result.data === undefined) throw new Error("Memory command returned no data")
  return result.data
}

function route(workspace?: string) {
  return {
    ...(workspace ? { workspace } : {}),
  }
}

function tokens(count: number) {
  return `${count.toLocaleString()} memory ${count === 1 ? "token" : "tokens"}`
}

function ops(count: number) {
  return `${count} ${count === 1 ? "op" : "ops"}`
}

export function parseMemoryInput(input: string): MemoryCommand | undefined {
  // Keep command semantics aligned with packages/kilo-vscode/webview-ui/src/utils/memory-command.ts.
  // Shared cases live in packages/opencode/test/kilocode/memory/memory-command-cases.json.
  const match = input.trim().match(/^\/(?:memory|mem)(?:\s+([\s\S]*))?$/i)
  if (!match) return
  const body = (match[1] ?? "").trim()
  if (!body) return { kind: "inspect" }

  const first = body.match(/^(\S+)(?:\s+([\s\S]*))?$/)
  const picked = first?.[1]?.toLowerCase()
  if (picked === "personal") return { kind: "usage", reason: "Personal memory is not supported in v0." }
  const scoped = picked === "project"
  const rest = (scoped ? first?.[2] : body)?.trim() ?? ""
  const parts = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/)
  const verb = parts?.[1]?.toLowerCase()
  const text = (parts?.[2] ?? "").trim()
  if (!verb) return { kind: "inspect" }
  if (verb === "status" || verb === "show" || verb === "inspect") return { kind: "inspect" }
  if (verb === "enable" || verb === "disable" || verb === "rebuild" || verb === "purge")
    return { kind: "operation", operation: verb }
  if (verb === "use-personal" || verb === "personal-context" || verb === "personal-in-project")
    return { kind: "usage", reason: "Personal memory is not supported in v0." }
  if (verb === "remember")
    return text ? { kind: "operation", operation: "remember", text } : { kind: "usage", reason: "Missing text." }
  if (verb === "correct")
    return text
      ? { kind: "operation", operation: "correct", text }
      : { kind: "usage", reason: "Missing correction." }
  if (verb === "forget")
    return text ? { kind: "operation", operation: "forget", query: text } : { kind: "usage", reason: "Missing query." }
  return { kind: "usage", reason: `Unknown memory action: ${verb ?? ""}` }
}

export async function runMemoryCommand(input: {
  text: string
  client: KiloClient
  workspace?: string
  toast: Toast
  show(): void
  usage(message: string): void
}) {
  const parsed = parseMemoryInput(input.text)
  if (!parsed) return false

  try {
    if (parsed.kind === "inspect") {
      input.show()
      return true
    }
    if (parsed.kind === "usage") {
      input.usage(`${parsed.reason}\n${MEMORY_USAGE}`)
      return true
    }
    const name = "Memory"
    if (parsed.operation === "enable") {
      const result = read(await input.client.memory.enable(route(input.workspace)))
      input.toast.show({ variant: "success", message: `${name} enabled (${tokens(result.index.tokens)})` })
      return true
    }
    if (parsed.operation === "disable") {
      read(await input.client.memory.disable(route(input.workspace)))
      input.toast.show({ variant: "info", message: `${name} disabled` })
      return true
    }
    if (parsed.operation === "rebuild") {
      const result = read(await input.client.memory.rebuild(route(input.workspace)))
      input.toast.show({ variant: "success", message: `${name} rebuilt (${tokens(result.index.tokens)})` })
      return true
    }
    if (parsed.operation === "purge") {
      read(await input.client.memory.purge(route(input.workspace)))
      input.toast.show({ variant: "success", message: `${name} purged` })
      return true
    }
    // Wording mirrors the server memory event messages so chat-intent and command saves read the same.
    if (parsed.operation === "remember") {
      const result = read(await input.client.memory.remember({ ...route(input.workspace), text: parsed.text }))
      input.toast.show({ variant: "success", message: `Memory saved · ${ops(result.operationCount)}` })
      return true
    }
    if (parsed.operation === "correct") {
      const result = read(await input.client.memory.correct({ ...route(input.workspace), text: parsed.text }))
      input.toast.show({ variant: "success", message: `Correction saved · ${ops(result.operationCount)}` })
      return true
    }

    if (parsed.operation === "forget") {
      const result = read(await input.client.memory.forget({ ...route(input.workspace), query: parsed.query }))
      input.toast.show({ variant: "success", message: `Memory updated · ${result.removed.toLocaleString()} removed` })
    }
    return true
  } catch (error) {
    input.toast.show({ variant: "error", message: `Memory command failed: ${msg(error)}` })
    return true
  }
}
