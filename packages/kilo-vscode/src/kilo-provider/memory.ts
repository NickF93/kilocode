import * as vscode from "vscode"
import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import { retry } from "../services/cli-backend/retry"
import { getErrorMessage } from "../kilo-provider-utils"

type MemorySourceFile = "project.md" | "environment.md" | "corrections.md"
type MemoryOperation = "enable" | "disable" | "rebuild" | "remember" | "correct" | "forget" | "purge"

export type KiloProviderMemoryMessage = {
  operation: MemoryOperation
  sessionID?: string
  text?: string
  query?: string
  key?: string
  file?: MemorySourceFile
  section?: string
}

export type KiloProviderMemoryInput = {
  client(): KiloClient | undefined
  session(): Session | undefined
  dir(sessionID?: string): string
  post(message: unknown): void
}

function file(value: unknown): MemorySourceFile | undefined {
  if (value === "project.md" || value === "environment.md" || value === "corrections.md") return value
  return undefined
}

function operation(value: unknown): MemoryOperation | undefined {
  if (
    value === "enable" ||
    value === "disable" ||
    value === "rebuild" ||
    value === "remember" ||
    value === "correct" ||
    value === "forget" ||
    value === "purge"
  )
    return value
  return undefined
}

export class KiloProviderMemory {
  private readonly cached = new Map<string, unknown>()

  constructor(private readonly input: KiloProviderMemoryInput) {}

  async handle(message: Record<string, unknown>): Promise<boolean> {
    if (message.type === "requestMemory") {
      this.fetch(
        typeof message.sessionID === "string" ? message.sessionID : undefined,
        message.includeSources === true,
      ).catch((err: unknown) => console.error("[Kilo New] fetchAndSendMemory failed:", err))
      return true
    }
    if (message.type === "memoryInspect") {
      await this.inspect(typeof message.sessionID === "string" ? message.sessionID : undefined)
      return true
    }
    if (message.type === "memoryOperation") {
      const op = operation(message.operation)
      if (!op) return true
      await this.run({
        operation: op,
        sessionID: typeof message.sessionID === "string" ? message.sessionID : undefined,
        text: typeof message.text === "string" ? message.text : undefined,
        query: typeof message.query === "string" ? message.query : undefined,
        key: typeof message.key === "string" ? message.key : undefined,
        file: file(message.file),
        section: typeof message.section === "string" ? message.section : undefined,
      })
      return true
    }
    if (message.type === "memoryPrompt") {
      await this.prompt(message.operation, typeof message.sessionID === "string" ? message.sessionID : undefined)
      return true
    }
    return false
  }

  async fetch(sessionID?: string, includeSources = false): Promise<void> {
    const directory = this.input.dir(sessionID ?? this.input.session()?.id)
    const client = this.input.client()
    if (!client) {
      const cached = this.cached.get(directory)
      if (cached && typeof cached === "object" && !Array.isArray(cached)) this.input.post({ ...cached, sessionID })
      return
    }

    try {
      const { data: status } = await retry(() => client.memory.status({ directory }, { throwOnError: true }))
      const show = includeSources
        ? (await retry(() => client.memory.show({ directory }, { throwOnError: true }))).data
        : undefined
      const msg = {
        type: "memoryLoaded",
        sessionID,
        status,
        ...(show ? { show } : {}),
      }
      this.cached.set(directory, msg)
      this.input.post(msg)
    } catch (err) {
      console.error("[Kilo New] KiloProvider: Failed to fetch memory:", err)
      this.input.post({
        type: "memoryLoaded",
        sessionID,
        error: getErrorMessage(err) || "Failed to load memory",
      })
    }
  }

  async prompt(value: unknown, sessionID?: string): Promise<void> {
    if (value !== "remember" && value !== "forget") return
    const title = value === "remember" ? "Remember in project memory" : "Forget project memory"
    const placeHolder = value === "remember" ? "Project fact, command, or correction" : "Text to remove"
    const text = await vscode.window.showInputBox({ title, placeHolder, ignoreFocusOut: true })
    if (!text?.trim()) return
    await this.run({
      operation: value,
      sessionID,
      ...(value === "remember" ? { text: text.trim() } : { query: text.trim() }),
    })
  }

  async inspect(sessionID?: string): Promise<void> {
    const client = this.input.client()
    if (!client) {
      this.input.post({
        type: "memoryLoaded",
        sessionID,
        error: "Not connected to CLI backend",
      })
      return
    }

    try {
      const directory = this.input.dir(sessionID ?? this.input.session()?.id)
      const { data: show } = await client.memory.show({ directory }, { throwOnError: true })
      const { data: status } = await client.memory.status({ directory }, { throwOnError: true })
      const current = sessionID ?? this.input.session()?.id
      const startup =
        current && status.state.stats.lastInjectedSessionID === current ? status.state.stats.lastInjectedTokens : 0
      const content = [
        "# Kilo Memory",
        "",
        `Root: ${show.root}`,
        `Enabled: ${show.state.enabled ? "yes" : "no"}`,
        "Startup context: on",
        `Stored index tokens: ${status.index.estimatedTokens}`,
        `Startup context tokens for this session: ${startup}`,
        `Last auto-save model usage: ${status.state.stats.lastConsolidationTokens} tokens`,
        "",
        "## project.md",
        show.sources.project.trim(),
        "",
        "## environment.md",
        show.sources.environment.trim(),
        "",
        "## corrections.md",
        show.sources.corrections.trim(),
        "",
        "## index.kmem",
        show.index.trim(),
        "",
        "## items",
        show.items.trim(),
        "",
        "## changes.log",
        show.changes.trim(),
        "",
        "## decisions.jsonl",
        show.decisions.trim(),
        "",
      ].join("\n")
      await vscode.workspace
        .openTextDocument({ content, language: "markdown" })
        .then((doc) => vscode.window.showTextDocument(doc, { preview: true }))
      const msg = {
        type: "memoryLoaded",
        sessionID,
        status,
        show,
      }
      this.cached.set(directory, msg)
      this.input.post(msg)
    } catch (err) {
      console.error("[Kilo New] KiloProvider: Failed to inspect memory:", err)
      this.input.post({
        type: "memoryLoaded",
        sessionID,
        error: getErrorMessage(err) || "Failed to inspect memory",
      })
    }
  }

  async run(message: KiloProviderMemoryMessage): Promise<void> {
    const client = this.input.client()
    if (!client) {
      this.input.post({
        type: "memoryOperationResult",
        operation: message.operation,
        sessionID: message.sessionID,
        ok: false,
        error: "Not connected to CLI backend",
      })
      return
    }

    try {
      const directory = this.input.dir(message.sessionID ?? this.input.session()?.id)
      const data =
        message.operation === "enable"
          ? (await client.memory.enable({ directory }, { throwOnError: true })).data
          : message.operation === "disable"
            ? (await client.memory.disable({ directory }, { throwOnError: true })).data
            : message.operation === "rebuild"
              ? (await client.memory.rebuild({ directory }, { throwOnError: true })).data
              : message.operation === "purge"
                ? (await client.memory.purge({ directory }, { throwOnError: true })).data
                : message.operation === "remember"
                  ? await this.remember(client, directory, message)
                  : message.operation === "correct"
                    ? await this.correct(client, directory, message)
                    : await this.forget(client, directory, message)
      const [{ data: status }, { data: show }] = await Promise.all([
        client.memory.status({ directory }, { throwOnError: true }),
        client.memory.show({ directory }, { throwOnError: true }),
      ])
      const result = {
        type: "memoryOperationResult",
        operation: message.operation,
        sessionID: message.sessionID,
        ok: true,
        status,
        show,
        result: data,
      }
      const loaded = {
        type: "memoryLoaded",
        sessionID: message.sessionID,
        status,
        show,
      }
      this.cached.set(directory, loaded)
      this.input.post(result)
      this.input.post(loaded)
    } catch (err) {
      console.error("[Kilo New] KiloProvider: Failed memory operation:", err)
      this.input.post({
        type: "memoryOperationResult",
        operation: message.operation,
        sessionID: message.sessionID,
        ok: false,
        error: getErrorMessage(err) || "Memory operation failed",
      })
    }
  }

  private async remember(client: KiloClient, directory: string, message: KiloProviderMemoryMessage) {
    const text = message.text?.trim()
    if (!text) throw new Error("Memory text is required")
    return (
      await client.memory.remember(
        {
          directory,
          text,
          key: message.key,
          file: message.file,
          section: message.section,
          sessionID: message.sessionID,
        },
        { throwOnError: true },
      )
    ).data
  }

  private async correct(client: KiloClient, directory: string, message: KiloProviderMemoryMessage) {
    const text = message.text?.trim()
    if (!text) throw new Error("Correction text is required")
    return (
      await client.memory.correct(
        {
          directory,
          text,
          key: message.key,
          file: message.file,
          section: message.section,
          sessionID: message.sessionID,
        },
        { throwOnError: true },
      )
    ).data
  }

  private async forget(client: KiloClient, directory: string, message: KiloProviderMemoryMessage) {
    const query = message.query?.trim()
    if (!query) throw new Error("Forget query is required")
    return (await client.memory.forget({ directory, query, sessionID: message.sessionID }, { throwOnError: true })).data
  }
}
