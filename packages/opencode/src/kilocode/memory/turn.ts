import { Cause, Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { Provider } from "@/provider/provider"
import type { Session } from "@/session/session"
import type { SessionSummary } from "@/session/summary"
import type { SessionID } from "@/session/schema"
import { MemoryCapture } from "./capture"

const log = Log.create({ service: "memory.turn" })

// Brief message only: API errors carry response headers/bodies that would flood the TUI log.
function brief(cause: Cause.Cause<unknown>) {
  const err = Cause.squash(cause)
  return (err instanceof Error ? err.message : String(err)).slice(0, 200)
}

export namespace MemoryTurn {
  export type Reason = "completed" | "error" | "interrupted"

  export function open(_input: { sessionID: SessionID }) {}

  export const close = Effect.fn("MemoryTurn.close")(function* (input: {
    sessionID: SessionID
    reason: Reason
    sessions: Session.Interface
    summary: SessionSummary.Interface
    provider: Provider.Interface
  }) {
    yield* Effect.gen(function* () {
      const info = yield* input.sessions.get(input.sessionID).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.warn("memory session lookup failed", { err: brief(cause) })
            return undefined
          }),
        ),
      )
      if (info?.parentID) return
      yield* MemoryCapture.turn({
        sessionID: input.sessionID,
        sessions: input.sessions,
        summary: input.summary,
        provider: input.provider,
        reason: input.reason,
      }).pipe(Effect.catchCause((cause) => Effect.sync(() => MemoryCapture.report(cause))))
    }).pipe(
      Effect.catchCause((cause) => Effect.sync(() => log.warn("memory turn-close hook failed", { err: brief(cause) }))),
    )
  })
}
