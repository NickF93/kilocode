// kilocode_change - new file
//
// Wires the built-in session commands (see `kilocode/session/builtin-commands.ts`)
// into `kilo run --command <name>`. They map to dedicated session endpoints
// (e.g. `/session/:sessionID/summarize`) and mirror the TUI's `/compact` and
// `/summarize` slash commands.
import type { KiloClient } from "@kilocode/sdk/v2"
import { Provider } from "@/provider/provider"
import { UI } from "@/cli/ui"
import { isBuiltinCommand, type BuiltinCommand } from "@/kilocode/session/builtin-commands"

export namespace KiloRun {
  export const isBuiltin = isBuiltinCommand

  export function validateBuiltin(args: { command?: string; continue?: boolean; session?: string }) {
    if (!isBuiltin(args.command)) return
    if (args.continue || args.session) return
    UI.error(`--command ${args.command} requires --continue or --session`)
    process.exit(1)
  }

  export async function runBuiltin(
    sdk: KiloClient,
    sessionID: string,
    command: BuiltinCommand,
    modelArg?: string,
    directory?: string,
  ) {
    const model = await resolveModel(sdk, modelArg)
    if (!model) {
      UI.error("No model specified and no default provider configured")
      process.exit(1)
    }
    // compact and summarize both map to the summarize endpoint
    if (command === "compact" || command === "summarize") {
      await sdk.session.summarize({
        sessionID,
        directory,
        providerID: model.providerID,
        modelID: model.modelID,
      })
    }
  }
}

async function resolveModel(sdk: KiloClient, modelArg?: string) {
  if (modelArg) {
    const parsed = Provider.parseModel(modelArg)
    return { providerID: parsed.providerID, modelID: parsed.modelID }
  }
  const result = await sdk.config.providers()
  const defaults = result.data?.default ?? {}
  const providerID = Object.keys(defaults)[0]
  if (!providerID) return undefined
  return { providerID, modelID: defaults[providerID] }
}
