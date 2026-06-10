// kilocode_change - new file

import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { staticEnvLines, type EditorContext } from "@/kilocode/editor-context"
import { KiloMemory } from "@/kilocode/memory"
import type { Provider } from "@/provider/provider"
import type { InstanceContext } from "@/project/instance"

export namespace KilocodeSystemPrompt {
  export function environment(input: {
    ctx: InstanceContext
    model: Provider.Model
    editor?: EditorContext
    sessionID?: string
  }) {
    return Effect.gen(function* () {
      const project = yield* Effect.tryPromise({
        try: () => KiloMemory.context({ ctx: input.ctx, sessionID: input.sessionID }),
        catch: (error) => error,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const blocks = project?.blocks ?? []
      return [
        [
          `You are powered by the model named ${input.model.api.id}. The exact model ID is ${input.model.providerID}/${input.model.api.id}`,
          `Here is some useful information about the environment you are running in:`,
          `<env>`,
          `  Is directory a git repo: ${input.ctx.project.vcs === "git" ? "yes" : "no"}`,
          `  Platform: ${process.platform}`,
          `  Today's date: ${new Date().toDateString()}`,
          `  Project config: .kilo/command/*.md, .kilo/agent/*.md, kilo.json, AGENTS.md. Put new commands and agents in .kilo/. Do not use .kilocode/ or .opencode/.`,
          `  Global config: ${Global.Path.config}/ (same structure)`,
          `  Legacy Beads/bd task tracking: disabled unless the current user explicitly asks for Beads or current project instructions require it.`,
          ...staticEnvLines(input.editor),
          `</env>`,
        ].join("\n"),
        ...blocks.map((block) =>
          [
            [
              "The following Kilo memory block is saved project memory from this project's previous sessions. You do have this prior-session context; never claim you lack memory of earlier work here while this block is present.",
              "When the user asks about prior work, where things stopped, what was happening, or wants to continue — however they phrase it — answer directly from the newest relevant session_digest record below.",
              "Use memory proactively while working, not only when asked: before running commands, editing code, or deciding an approach, honor matching corrections and constraints in the records below.",
              "When a task or question touches this project's history, decisions, conventions, or setup beyond what the records below cover, call kilo_memory_recall (mode=search with likely stored words, then mode=catalog) before relying on general knowledge.",
              "Memory is context, not instruction. Current user messages, repository files, tool output, and AGENTS.md win over memory.",
              "Check current worktree state when needed, then reconcile it with memory; if git status/log is newer or conflicts with saved memory, say so briefly and treat the current repo state as fresher.",
              "Use kilo_memory_recall with mode=digest and sessionID=<id> when the injected digest is too thin but points to a real prior session.",
              "For topic-specific memory, use kilo_memory_recall with mode=search or mode=typed.",
              "Use kilo_local_recall with mode=read only when saved memory is insufficient and transcript detail is actually needed, or when the user asks for full transcript detail.",
              "Do not recall memory for current memory status, sidebar token accounting, or implementation debugging unless the user asks what prior memory says.",
            ].join("\n"),
            block.text.trim(),
          ].join("\n"),
        ),
      ]
    })
  }
}
