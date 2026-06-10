import type { KiloClient } from "@kilocode/sdk/v2"

export const MEMORY_USAGE =
  "/memory [project] enable|status|show|inspect|remember <text>|correct <text>|forget <key>|purge|rebuild|disable"

export type Scope = "project"

export type MemoryCommand =
  | { action: "show"; scope?: Scope }
  | { action: "enable"; scope?: Scope }
  | { action: "disable"; scope?: Scope }
  | { action: "rebuild"; scope?: Scope }
  | { action: "purge"; scope?: Scope }
  | { action: "remember"; scope?: Scope; text: string }
  | { action: "correct"; scope?: Scope; text: string }
  | { action: "forget"; scope?: Scope; text: string }
  | { action: "usage"; reason: string }

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

function withScope(input: MemoryCommand, scope?: Scope): MemoryCommand {
  if (!scope || input.action === "usage") return input
  return { ...input, scope }
}

export function parseMemoryInput(input: string): MemoryCommand | undefined {
  const match = input.trim().match(/^\/(?:memory|mem)(?:\s+([\s\S]*))?$/i)
  if (!match) return
  const body = (match[1] ?? "").trim()
  if (!body) return { action: "show" }

  const first = body.match(/^(\S+)(?:\s+([\s\S]*))?$/)
  const picked = first?.[1]?.toLowerCase()
  if (picked === "personal") return { action: "usage", reason: "Personal memory is not supported in v0." }
  const scoped = picked === "project"
  const scope = scoped ? picked : undefined
  const rest = (scoped ? first?.[2] : body)?.trim() ?? ""
  const parts = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/)
  const verb = parts?.[1]?.toLowerCase()
  const text = (parts?.[2] ?? "").trim()
  if (!verb) return withScope({ action: "show" }, scope)
  if (verb === "status" || verb === "show" || verb === "inspect")
    return withScope({ action: "show" }, scope)
  if (verb === "enable") return withScope({ action: "enable" }, scope)
  if (verb === "disable") return withScope({ action: "disable" }, scope)
  if (verb === "rebuild") return withScope({ action: "rebuild" }, scope)
  if (verb === "purge") return withScope({ action: "purge" }, scope)
  if (verb === "use-personal" || verb === "personal-context" || verb === "personal-in-project")
    return { action: "usage", reason: "Personal memory is not supported in v0." }
  if (verb === "remember")
    return text ? withScope({ action: "remember", text }, scope) : { action: "usage", reason: "Missing text." }
  if (verb === "correct")
    return text ? withScope({ action: "correct", text }, scope) : { action: "usage", reason: "Missing correction." }
  if (verb === "forget")
    return text ? withScope({ action: "forget", text }, scope) : { action: "usage", reason: "Missing query." }
  return { action: "usage", reason: `Unknown memory action: ${verb ?? ""}` }
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
    if (parsed.action === "show") {
      input.show()
      return true
    }
    if (parsed.action === "usage") {
      input.usage(`${parsed.reason}\n${MEMORY_USAGE}`)
      return true
    }
    const name = "Memory"
    if (parsed.action === "enable") {
      const result = read(await input.client.memory.enable(route(input.workspace)))
      input.toast.show({ variant: "success", message: `${name} enabled (${tokens(result.index.tokens)})` })
      return true
    }
    if (parsed.action === "disable") {
      read(await input.client.memory.disable(route(input.workspace)))
      input.toast.show({ variant: "info", message: `${name} disabled` })
      return true
    }
    if (parsed.action === "rebuild") {
      const result = read(await input.client.memory.rebuild(route(input.workspace)))
      input.toast.show({ variant: "success", message: `${name} rebuilt (${tokens(result.index.tokens)})` })
      return true
    }
    if (parsed.action === "purge") {
      read(await input.client.memory.purge(route(input.workspace)))
      input.toast.show({ variant: "success", message: `${name} purged` })
      return true
    }
    // Wording mirrors the server memory event messages so chat-intent and command saves read the same.
    if (parsed.action === "remember") {
      const result = read(await input.client.memory.remember({ ...route(input.workspace), text: parsed.text }))
      input.toast.show({ variant: "success", message: `Memory saved · ${ops(result.operationCount)}` })
      return true
    }
    if (parsed.action === "correct") {
      const result = read(await input.client.memory.correct({ ...route(input.workspace), text: parsed.text }))
      input.toast.show({ variant: "success", message: `Correction saved · ${ops(result.operationCount)}` })
      return true
    }

    const result = read(await input.client.memory.forget({ ...route(input.workspace), query: parsed.text }))
    input.toast.show({ variant: "success", message: `Memory updated · ${result.removed.toLocaleString()} removed` })
    return true
  } catch (error) {
    input.toast.show({ variant: "error", message: `Memory command failed: ${msg(error)}` })
    return true
  }
}
