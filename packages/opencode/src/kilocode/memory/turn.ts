import { Cause, Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceState } from "@/effect/instance-state"
import type { Provider } from "@/provider/provider"
import type { Session } from "@/session/session"
import type { SessionSummary } from "@/session/summary"
import type { SessionID } from "@/session/schema"
import { MemoryCapture } from "./capture"
import { MemoryEval } from "./eval"

const log = Log.create({ service: "memory.turn" })

// Brief message only: API errors carry response headers/bodies that would flood the TUI log.
function brief(cause: Cause.Cause<unknown>) {
  const err = Cause.squash(cause)
  return (err instanceof Error ? err.message : String(err)).slice(0, 200)
}

export namespace MemoryTurn {
  export type Reason = "completed" | "error" | "interrupted"

  export function open(input: { sessionID: SessionID }) {
    MemoryEval.open(input)
  }

  export const close = Effect.fn("MemoryTurn.close")(function* (input: {
    sessionID: SessionID
    reason: Reason
    sessions: Session.Interface
    summary: SessionSummary.Interface
    provider: Provider.Interface
  }) {
    yield* Effect.gen(function* () {
      const ctx = yield* InstanceState.context
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
      if (MemoryEval.active()) {
        const messages = yield* input.sessions.messages({ sessionID: input.sessionID })
        yield* Effect.promise(() =>
          MemoryEval.close({
            ctx,
            sessionID: input.sessionID,
            reason: input.reason,
            messages,
          }),
        )
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => log.warn("memory turn-close hook failed", { err: brief(cause) })),
      ),
    )
  })
}
