import { Filesystem } from "@/util/filesystem"
import { Token } from "@/util/token"
import * as Log from "@opencode-ai/core/util/log"
import { MemoryEvents } from "./events"
import { MemoryFiles } from "./files"
import { MemoryIndexer } from "./indexer"
import { MemoryOperations } from "./operations"
import { MemoryPaths } from "./paths"
import { MemoryRecall } from "./recall"
import { MemorySchema } from "./schema"
import { MemoryEval } from "./eval"

const log = Log.create({ service: "memory" })

export namespace KiloMemory {
  export type Input =
    | {
        root: string
        scope?: MemorySchema.Scope
        sessionID?: string
        record?: boolean
      }
    | {
        ctx: MemoryPaths.Ctx
        scope?: MemorySchema.Scope
        sessionID?: string
        record?: boolean
      }

  export type Block = {
    scope: MemorySchema.Scope
    text: string
    bytes: number
    estimatedTokens: number
    truncated: boolean
  }

  function root(input: Input) {
    return "root" in input ? input.root : MemoryPaths.root(input)
  }

  export async function prepare(input: Input) {
    const dir = root(input)
    if (!("ctx" in input)) return dir
    const id = MemoryPaths.identity({ ctx: input.ctx })
    let migrated = false
    for (const old of MemoryPaths.legacyRoots({ ctx: input.ctx })) {
      if (old === dir) continue
      const result = await MemoryFiles.migrate({ from: old, to: dir }).catch((error: unknown) => {
        log.warn("legacy memory migration failed", { from: old, to: dir, error })
        return undefined
      })
      if (result?.migrated) migrated = true
      if (result) {
        await MemoryFiles.cleanupLegacy({ root: old }).catch((error: unknown) => {
          log.warn("legacy memory cleanup failed", { root: old, error })
          return false
        })
      }
    }
    const paths = MemoryPaths.files(dir)
    if (migrated || ((await Filesystem.exists(dir)) && !(await Filesystem.exists(paths.manifest)))) {
      await MemoryFiles.writeManifest(dir, id).catch((error: unknown) =>
        log.warn("memory manifest write failed", { root: dir, error }),
      )
    }
    if (migrated) {
      const has = await Filesystem.exists(paths.state)
      const state = has ? await MemoryFiles.readState(dir) : { ...MemorySchema.create("project"), enabled: true }
      if (!has) await MemoryFiles.writeState(dir, state)
      await MemoryIndexer.rebuild({ root: dir, state }).catch((error: unknown) =>
        log.warn("memory index rebuild after migration failed", { root: dir, error }),
      )
    }
    return dir
  }

  function scope(input: Input): MemorySchema.Scope {
    return input.scope ?? "project"
  }

  function brief(input: string, max: number) {
    const text = input.trim().replaceAll(/\s+/g, " ")
    if (text.length <= max) return text
    return `${text.slice(0, Math.max(0, max - 3))}...`
  }

  function refs(ops: MemoryOperations.Op[]) {
    return [
      ...new Set(
        ops.flatMap((item) => {
          if (item.action !== "add" || !item.file) return []
          return [`${item.file}:${item.key}`]
        }),
      ),
    ]
  }

  function files(ops: MemoryOperations.Op[]) {
    return [
      ...new Set(
        ops.flatMap((item) => {
          if (item.action !== "add" || !item.file) return []
          return [item.file]
        }),
      ),
    ]
  }

  function audit(ops: MemoryOperations.Op[]) {
    return ops.map((item) =>
      item.action === "add"
        ? {
            action: item.action,
            file: item.file,
            section: item.section,
            key: item.key,
          }
        : {
            action: item.action,
            query: brief(item.query, 120),
          },
    )
  }

  function saved(input: { added: number; removed: number }) {
    return input.removed > 0 || input.added > 0
  }

  function summary(input: { added: number; removed: number; count: number }) {
    if (input.added > 0 && input.removed > 0) {
      return `explicit memory operation saved ${input.added} and removed ${input.removed}`
    }
    if (input.added > 0) return `explicit memory operation saved ${input.added} ops`
    if (input.removed > 0) return `explicit memory operation removed ${input.removed} entries`
    if (input.count > 0) return "explicit memory operation matched no source memory"
    return "explicit memory operation had no accepted ops"
  }

  function message(input: { ops: MemoryOperations.Op[]; added: number; removed: number; count: number }) {
    const references = refs(input.ops)
    if (input.added > 0 && input.removed > 0) return `Memory updated · ${input.added} saved, ${input.removed} removed`
    if (input.added > 0) return `Memory saved · ${references.join(", ") || `${input.added} ops`}`
    if (input.removed > 0) return `Memory updated · ${input.removed} removed`
    return `Memory unchanged · ${input.count} ops`
  }

  async function injected(input: {
    root: string
    state: MemorySchema.State
    index: MemoryIndexer.Result
    sessionID?: string
  }) {
    return MemoryFiles.queue(input.root, async () => {
      const latest = await MemoryFiles.readState(input.root, input.state.scope)
      const next = {
        ...latest,
        stats: {
          ...latest.stats,
          lastInjectedAt: Date.now(),
          lastInjectedBytes: input.index.bytes,
          lastInjectedTokens: input.index.tokens,
          lastInjectedSessionID: input.sessionID ?? null,
        },
      }
      await MemoryFiles.writeState(input.root, next)
      return next
    })
  }

  export async function status(input: Input) {
    const dir = await prepare(input)
    const state = await MemoryFiles.readState(dir, scope(input))
    const paths = MemoryPaths.files(dir)
    const index = await MemoryFiles.readIndex(dir)
    return {
      root: dir,
      state,
      exists: {
        state: await Filesystem.exists(paths.state),
        index: await Filesystem.exists(paths.index),
      },
      index: {
        bytes: Buffer.byteLength(index),
        estimatedTokens: Token.estimate(index),
        preview: index,
      },
    }
  }

  export async function enable(input: Input) {
    const dir = await prepare(input)
    const id = "ctx" in input ? MemoryPaths.identity({ ctx: input.ctx }) : undefined
    const state = await MemoryFiles.scaffold(dir, scope(input), id)
    const index = await MemoryIndexer.rebuild({ root: dir, state })
    await MemoryEvents.publish({
      event: "updated",
      payload: MemoryEvents.status({
        root: dir,
        state,
        index,
        phase: "idle",
        consolidation: { trigger: "rebuild", operationCount: 0, cost: 0, tokens: index.tokens },
      }),
    })
    return { root: dir, state, index }
  }

  export async function disable(input: Input) {
    const dir = await prepare(input)
    const result = await MemoryFiles.queue(dir, async () => {
      const state = await MemoryFiles.readState(dir, scope(input))
      const next = { ...state, enabled: false }
      await MemoryFiles.writeState(dir, next)
      await MemoryFiles.append(dir, `disable ${next.scope} source=command`)
      return { root: dir, state: next }
    })
    await MemoryEvents.publish({
      event: "status",
      payload: MemoryEvents.status({ root: dir, state: result.state, phase: "idle" }),
    })
    return result
  }

  export async function show(input: Input) {
    const dir = await prepare(input)
    return MemoryFiles.show(dir, scope(input))
  }

  export async function rebuild(input: Input) {
    const dir = await prepare(input)
    const state = await MemoryFiles.readState(dir, scope(input))
    const index = await MemoryIndexer.rebuild({ root: dir, state })
    await MemoryEvents.publish({
      event: "updated",
      payload: MemoryEvents.status({
        root: dir,
        state,
        index,
        phase: "idle",
        consolidation: { trigger: "rebuild", operationCount: 0, cost: 0, tokens: index.tokens },
      }),
    })
    return { root: dir, state, index }
  }

  export async function configure(
    input: Input & {
      settings: Partial<Pick<MemorySchema.State, "autoInject" | "autoConsolidate">>
    },
  ) {
    const dir = await prepare(input)
    const result = await MemoryFiles.queue(dir, async () => {
      const state = await MemoryFiles.readState(dir, scope(input))
      const next = {
        ...state,
        ...(input.settings.autoInject === undefined ? {} : { autoInject: input.settings.autoInject }),
        ...(input.settings.autoConsolidate === undefined ? {} : { autoConsolidate: input.settings.autoConsolidate }),
      }
      await MemoryFiles.writeState(dir, next)
      await MemoryFiles.append(
        dir,
        [
          `settings ${next.scope}`,
          input.settings.autoInject === undefined ? "" : `autoInject=${next.autoInject}`,
          input.settings.autoConsolidate === undefined ? "" : `autoConsolidate=${next.autoConsolidate}`,
        ]
          .filter(Boolean)
          .join(" "),
      )
      return { root: dir, state: next }
    })
    await MemoryEvents.publish({
      event: "status",
      payload: MemoryEvents.status({ root: dir, state: result.state, phase: "idle" }),
    })
    return result
  }

  export async function context(input: Input) {
    const dir = root(input)
    if (!MemoryEval.shouldInject()) {
      MemoryEval.injected({ root: dir, bytes: 0, tokens: 0, truncated: false, ms: 0 })
      return {
        root: dir,
        blocks: [] as Block[],
        meta: { enabled: false, estimatedTokens: 0, bytes: 0, truncated: false },
      }
    }
    const ready = await prepare(input)
    const started = Date.now()
    const state = await MemoryFiles.readState(ready, scope(input))
    const record = input.record ?? true
    if (!state.enabled || !state.autoInject) {
      MemoryEval.injected({ root: ready, bytes: 0, tokens: 0, truncated: false, ms: Date.now() - started })
      return {
        root: ready,
        blocks: [] as Block[],
        meta: { enabled: state.enabled, estimatedTokens: 0, bytes: 0, truncated: false },
      }
    }

    const paths = MemoryPaths.files(ready)
    const prior = (await Filesystem.exists(paths.index)) ? await MemoryFiles.readIndex(ready) : undefined
    const expired = prior ? await MemoryFiles.indexExpired(ready) : true
    const index =
      prior && !MemoryIndexer.stale(prior) && !expired && MemoryIndexer.fresh(prior, state.limits)
        ? prior
        : (await rebuild(input)).index.text
    const max = MemoryEval.maxBytes(state.limits.maxProjectIndexBytes)
    const capped = MemoryIndexer.cap(index, max)
    if (!record) {
      return {
        root: ready,
        blocks: capped.text.trim()
          ? [
              {
                scope: state.scope,
                text: capped.text,
                bytes: capped.bytes,
                estimatedTokens: capped.tokens,
                truncated: capped.truncated,
              },
            ]
          : [],
        meta: {
          enabled: true,
          estimatedTokens: capped.tokens,
          bytes: capped.bytes,
          truncated: capped.truncated,
        },
      }
    }
    if (!capped.text.trim()) {
      const next = await injected({ root: ready, state, index: capped, sessionID: input.sessionID })
      MemoryEval.injected({ root: ready, bytes: 0, tokens: 0, truncated: false, ms: Date.now() - started })
      await MemoryEvents.publish({
        event: "status",
        payload: MemoryEvents.status({
          root: ready,
          state: next,
          index: capped,
          phase: "injecting",
          sessionID: input.sessionID,
        }),
      })
      return {
        root: ready,
        blocks: [] as Block[],
        meta: { enabled: true, estimatedTokens: 0, bytes: 0, truncated: false },
      }
    }
    const next = await injected({ root: ready, state, index: capped, sessionID: input.sessionID })
    MemoryEval.injected({
      root: ready,
      bytes: capped.bytes,
      tokens: capped.tokens,
      truncated: capped.truncated,
      ms: Date.now() - started,
    })
    await MemoryEvents.publish({
      event: "status",
      payload: MemoryEvents.status({
        root: ready,
        state: next,
        index: capped,
        phase: "injecting",
        sessionID: input.sessionID,
      }),
    })
    return {
      root: ready,
      blocks: [
        {
          scope: state.scope,
          text: capped.text,
          bytes: capped.bytes,
          estimatedTokens: capped.tokens,
          truncated: capped.truncated,
        },
      ] as Block[],
      meta: {
        enabled: true,
        estimatedTokens: capped.tokens,
        bytes: capped.bytes,
        truncated: capped.truncated,
      },
    }
  }

  export async function toolEnabled(input: Input) {
    if (!MemoryEval.shouldInject()) return false
    const dir = "ctx" in input ? await prepare(input) : root(input)
    const state = await MemoryFiles.readState(dir, scope(input))
    return state.enabled && state.autoInject
  }

  export async function apply(
    input: Input & {
      ops: MemoryOperations.Op[]
      trigger?: MemoryEvents.Trigger
      cost?: number
      tokens?: number
    },
  ) {
    const dir = await prepare(input)
    const result = await MemoryOperations.apply({ root: dir, scope: scope(input), ops: input.ops })
    const state = await MemoryFiles.readState(dir, scope(input))
    const trigger = input.trigger ?? "explicit"
    const ok = saved({ added: result.added, removed: result.removed })
    if (trigger === "explicit") {
      await MemoryFiles.decide(dir, {
        kind: "typed",
        trigger,
        sessionID: input.sessionID,
        result: ok ? "saved" : "skipped",
        llm: false,
        parsed: true,
        fallback: false,
        tokens: input.tokens ?? 0,
        operationCount: result.operationCount,
        skippedCount: ok ? 0 : 1,
        operations: audit(input.ops),
        files: files(input.ops),
        summary: summary({ added: result.added, removed: result.removed, count: result.operationCount }),
      })
    }
    await MemoryEvents.publish({
      event: "updated",
      payload: MemoryEvents.status({
        root: dir,
        state,
        index: result.index,
        phase: "updating",
        sessionID: input.sessionID,
        consolidation: {
          trigger,
          operationCount: result.operationCount,
          cost: input.cost ?? 0,
          tokens: input.tokens ?? 0,
        },
        // Auto (turn-close) saves carry the detail too so clients can notify about background memory writes.
        ...(ok
          ? {
              detail: {
                type: "saved" as const,
                message: message({
                  ops: input.ops,
                  added: result.added,
                  removed: result.removed,
                  count: result.operationCount,
                }),
                operationCount: result.operationCount,
                sources: refs(input.ops),
                files: files(input.ops),
              },
            }
          : {}),
      }),
    })
    return result
  }

  export async function forget(input: Input & { query: string }) {
    return apply({ ...input, ops: [{ action: "remove", query: input.query }] })
  }

  export async function purge(input: Input) {
    const dir = root(input)
    const removed = await MemoryFiles.purge(dir)
    await MemoryEvents.publish({
      event: "status",
      payload: MemoryEvents.status({
        root: dir,
        state: MemorySchema.missing(scope(input)),
        phase: "idle",
        reason: removed ? "purged" : "missing",
      }),
    })
    return { root: dir, purged: removed }
  }

  export async function recall(input: Input & { query: string; sessionID?: string }) {
    if (!MemoryEval.shouldInject()) return
    const ready = await prepare(input)
    const started = Date.now()
    const state = await MemoryFiles.readState(ready, scope(input))
    if (!state.enabled || !state.autoInject || !MemoryRecall.shouldRecall(input.query)) return
    const result = await MemoryRecall.search({
      root: ready,
      query: input.query,
      state,
      currentSessionID: input.sessionID,
    })
    const hits = result?.hits ?? []
    const files = [...new Set(hits.map((hit) => hit.source))]
    const topics = [...new Set(hits.flatMap((hit) => (hit.topics?.length ? hit.topics : [hit.kind])))]
    await MemoryFiles.decide(ready, {
      kind: "recall",
      trigger: "targeted-recall",
      sessionID: input.sessionID,
      result: result ? "recalled" : "skipped",
      llm: false,
      parsed: false,
      fallback: false,
      reason: result ? undefined : "no_matches",
      query: brief(input.query, 240),
      topics,
      files,
      tokens: result?.tokens ?? 0,
      operationCount: hits.length,
      skippedCount: result ? 0 : 1,
      summary: result ? `targeted recall matched ${hits.length} memories` : "targeted recall found no matches",
    })
    if (!result) {
      await MemoryEvents.publish({
        event: "status",
        payload: MemoryEvents.status({
          root: ready,
          state,
          phase: "skipped",
          sessionID: input.sessionID,
          detail: {
            type: "skipped",
            message: "Memory skipped · no recall matches",
            reason: "no_matches",
            skippedCount: 1,
          },
        }),
      })
      return
    }
    MemoryEval.injected({
      root: ready,
      bytes: result.bytes,
      tokens: result.tokens,
      truncated: false,
      ms: Date.now() - started,
    })
    await MemoryFiles.queue(ready, async () => {
      await MemoryFiles.append(
        ready,
        `recall session=${input.sessionID ?? ""} hits=${result.hits.length} tokens=${result.tokens} files=${files.join(",")}`,
      )
    })
    await MemoryEvents.publish({
      event: "status",
      payload: MemoryEvents.status({
        root: ready,
        state,
        phase: "injecting",
        sessionID: input.sessionID,
        detail: {
          type: "recalled",
          message: `Memory recalled · ${result.hits.length} ${result.hits.length === 1 ? "item" : "items"}`,
          tokens: result.tokens,
          operationCount: result.hits.length,
          sources: files,
          files,
        },
      }),
    })
    return { root: ready, ...result }
  }

  export async function recordSession(
    input: Input & { sessionID: string; topic?: string; summary: string; time?: number; tokens?: number },
  ) {
    const dir = await prepare(input)
    return MemoryFiles.queue(dir, async () => {
      const state = await MemoryFiles.readState(dir, scope(input))
      if (!state.enabled) {
        await MemoryEvents.publish({
          event: "status",
          payload: MemoryEvents.status({
            root: dir,
            state,
            phase: "skipped",
            reason: "memory_disabled",
            sessionID: input.sessionID,
          }),
        })
        return { skipped: true, reason: "memory_disabled" }
      }
      await MemoryFiles.writeSession(dir, {
        sessionID: input.sessionID,
        topic: input.topic,
        summary: input.summary,
        max: state.limits.maxSessionLineChars,
        time: input.time,
      })
      await MemoryFiles.pruneSessions(dir, state.limits.maxSessionFiles)
      const index = await MemoryIndexer.rebuild({ root: dir, state })
      await MemoryFiles.append(
        dir,
        `session digest session=${input.sessionID} tokens=${input.tokens ?? 0} indexTokens=${index.tokens}`,
      )
      await MemoryEvents.publish({
        event: "updated",
        payload: MemoryEvents.status({
          root: dir,
          state,
          index,
          phase: "updating",
          sessionID: input.sessionID,
          consolidation: { trigger: "turn-close", operationCount: 0, cost: 0, tokens: input.tokens ?? 0 },
        }),
      })
      return { skipped: false, index }
    })
  }
}

export { MemoryEvents } from "./events"
export { MemoryDigest } from "./digest"
export { MemoryFiles } from "./files"
export { MemoryIndexer } from "./indexer"
export { MemoryOperations } from "./operations"
export { MemoryPaths } from "./paths"
export { MemoryRecall } from "./recall"
export { MemorySchema } from "./schema"
export { MemoryTopics } from "./topics"
export { MemoryEval } from "./eval"
