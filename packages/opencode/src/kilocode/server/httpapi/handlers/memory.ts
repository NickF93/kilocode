import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceState } from "@/effect/instance-state"
import { KiloMemory, MemorySchema } from "@/kilocode/memory"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import {
  MemoryForgetPayload,
  MemoryQuery,
  MemoryRememberPayload,
  MemorySettingsPayload,
} from "../groups/memory"

type ApiState = Omit<MemorySchema.State, "stats"> & {
  stats: Omit<MemorySchema.Stats, "lastInjectedAt" | "lastInjectedSessionID" | "lastConsolidatedAt"> & {
    lastInjectedAt: number
    lastInjectedSessionID: string
    lastConsolidatedAt: number
  }
}

function state(input: MemorySchema.State): ApiState {
  return {
    ...input,
    stats: {
      ...input.stats,
      lastInjectedAt: input.stats.lastInjectedAt ?? 0,
      lastInjectedSessionID: input.stats.lastInjectedSessionID ?? "",
      lastConsolidatedAt: input.stats.lastConsolidatedAt ?? 0,
    },
  }
}

function output<T extends { state: MemorySchema.State }>(input: T): Omit<T, "state"> & { state: ApiState } {
  return { ...input, state: state(input.state) }
}

function key(text: string) {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .split("_")
    .filter(Boolean)
    .slice(0, 5)
    .join("_")
  return slug || "memory"
}

function run<T>(fn: () => Promise<T>) {
  return Effect.tryPromise({
    try: fn,
    catch: () => new HttpApiError.BadRequest({}),
  })
}

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const status = Effect.fn("MemoryHttpApi.status")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return output(yield* run(() => KiloMemory.status({ ctx })))
    })

    const show = Effect.fn("MemoryHttpApi.show")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return output(yield* run(() => KiloMemory.show({ ctx })))
    })

    const enable = Effect.fn("MemoryHttpApi.enable")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return output(yield* run(() => KiloMemory.enable({ ctx })))
    })

    const disable = Effect.fn("MemoryHttpApi.disable")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return output(yield* run(() => KiloMemory.disable({ ctx })))
    })

    const rebuild = Effect.fn("MemoryHttpApi.rebuild")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return output(yield* run(() => KiloMemory.rebuild({ ctx })))
    })

    const remember = Effect.fn("MemoryHttpApi.remember")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryRememberPayload.Type
    }) {
      const state = yield* InstanceState.context
      return yield* run(() =>
        KiloMemory.apply({
          ctx: state,
          sessionID: req.payload.sessionID,
          ops: [
            {
              action: "add",
              file: req.payload.file,
              section: req.payload.section,
              key: req.payload.key ?? key(req.payload.text),
              text: req.payload.text,
            },
          ],
        }),
      )
    })

    const correct = Effect.fn("MemoryHttpApi.correct")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryRememberPayload.Type
    }) {
      const state = yield* InstanceState.context
      return yield* run(() =>
        KiloMemory.apply({
          ctx: state,
          sessionID: req.payload.sessionID,
          ops: [
            {
              action: "add",
              file: "corrections.md",
              section: "Corrections",
              key: req.payload.key ?? key(req.payload.text),
              text: req.payload.text,
            },
          ],
        }),
      )
    })

    const forget = Effect.fn("MemoryHttpApi.forget")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryForgetPayload.Type
    }) {
      const state = yield* InstanceState.context
      return yield* run(() =>
        KiloMemory.forget({ ctx: state, query: req.payload.query, sessionID: req.payload.sessionID }),
      )
    })

    const purge = Effect.fn("MemoryHttpApi.purge")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return yield* run(() => KiloMemory.purge({ ctx }))
    })

    const settings = Effect.fn("MemoryHttpApi.settings")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemorySettingsPayload.Type
    }) {
      const state = yield* InstanceState.context
      return output(
        yield* run(() =>
          KiloMemory.configure({
            ctx: state,
            settings: {
              autoInject: req.payload.autoInject,
              autoConsolidate: req.payload.autoConsolidate,
            },
          }),
        ),
      )
    })

    return handlers
      .handle("status", status)
      .handle("show", show)
      .handle("enable", enable)
      .handle("disable", disable)
      .handle("rebuild", rebuild)
      .handle("remember", remember)
      .handle("correct", correct)
      .handle("forget", forget)
      .handle("purge", purge)
      .handle("settings", settings)
  }),
)
