export namespace MemorySchema {
  export const VERSION = 1

  export const Sources = ["project.md", "environment.md", "corrections.md"] as const
  export const Topics = [
    "project",
    "constraints",
    "workflow",
    "environment",
    "quality",
    "ui",
    "integration",
    "corrections",
  ] as const

  export type Source = (typeof Sources)[number]
  export type Topic = (typeof Topics)[number]

  export type Capture = {
    mode: "selective"
    turnClose: boolean
    explicit: boolean
    maxOpsPerRun: number
    minIntervalMs: number
    timeoutMs: number
  }

  export type Limits = {
    maxProjectIndexBytes: number
    maxSessionFiles: number
    maxRecentSessions: number
    maxConsolidationInputBytes: number
    maxLineChars: number
    maxSessionLineChars: number
  }

  export type Stats = {
    lastInjectedAt: number | null
    lastInjectedBytes: number
    lastInjectedTokens: number
    lastInjectedSessionID: string | null
    lastConsolidatedAt: number | null
    lastConsolidationCost: number
    lastConsolidationTokens: number
    lastOperationCount: number
  }

  export type State = {
    version: 1
    enabled: boolean
    scope: "project"
    autoInject: boolean
    autoConsolidate: boolean
    capture: Capture
    limits: Limits
    stats: Stats
  }

  const capture: Capture = {
    mode: "selective",
    turnClose: true,
    explicit: true,
    maxOpsPerRun: 16,
    minIntervalMs: 300_000,
    timeoutMs: 30_000,
  }

  const limits: Limits = {
    maxProjectIndexBytes: 8192,
    maxSessionFiles: 50,
    maxRecentSessions: 10,
    maxConsolidationInputBytes: 24_000,
    maxLineChars: 240,
    maxSessionLineChars: 360,
  }

  const stats: Stats = {
    lastInjectedAt: null,
    lastInjectedBytes: 0,
    lastInjectedTokens: 0,
    lastInjectedSessionID: null,
    lastConsolidatedAt: null,
    lastConsolidationCost: 0,
    lastConsolidationTokens: 0,
    lastOperationCount: 0,
  }

  function rec(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
  }

  function bool(input: unknown, fallback: boolean) {
    return typeof input === "boolean" ? input : fallback
  }

  function num(input: unknown, fallback: number) {
    return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : fallback
  }

  function nullable(input: unknown, fallback: number | null) {
    if (input === null) return null
    return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : fallback
  }

  function str(input: unknown, fallback: string | null) {
    return input === null || typeof input === "string" ? input : fallback
  }

  export function topic(input: unknown): Topic | undefined {
    if (typeof input !== "string") return
    return (Topics as readonly string[]).includes(input) ? (input as Topic) : undefined
  }

  export function topics(input: unknown): Topic[] {
    if (!Array.isArray(input)) return []
    return [...new Set(input.flatMap((item) => topic(item) ?? []))].slice(0, 3)
  }

  export function kind(file: Source, section: string) {
    if (file === "corrections.md") return "correction"
    if (file === "environment.md") return "environment"
    const value = section.toLowerCase()
    if (value.includes("decision")) return "project_decision"
    if (value.includes("constraint")) return "project_constraint"
    if (value.includes("question")) return "open_question"
    return "project_fact"
  }

  export function recordKind(file: Source, section: string) {
    if (file === "corrections.md") return "CORRECTION"
    if (file === "environment.md") return "ENV"
    const value = section.toLowerCase()
    if (value.includes("decision")) return "PROJECT_DECISION"
    if (value.includes("constraint")) return "PROJECT_CONSTRAINT"
    if (value.includes("question")) return "INFERENCE"
    return "PROJECT_FACT"
  }

  export function create(): State {
    return {
      version: VERSION,
      enabled: false,
      scope: "project",
      autoInject: true,
      autoConsolidate: false,
      capture: { ...capture },
      limits: { ...limits },
      stats: { ...stats },
    }
  }

  export function missing(): State {
    return { ...create(), enabled: false, autoConsolidate: false }
  }

  export function parse(input: unknown): State {
    const base = create()
    if (!rec(input)) return base

    const cap = rec(input.capture) ? input.capture : {}
    const lim = rec(input.limits) ? input.limits : {}
    const stat = rec(input.stats) ? input.stats : {}
    const session = num(lim.maxSessionLineChars, base.limits.maxSessionLineChars)
    return {
      version: VERSION,
      enabled: bool(input.enabled, base.enabled),
      scope: "project",
      autoInject: true,
      autoConsolidate: bool(input.autoConsolidate, base.autoConsolidate),
      capture: {
        mode: "selective",
        turnClose: bool(cap.turnClose, base.capture.turnClose),
        explicit: bool(cap.explicit, base.capture.explicit),
        maxOpsPerRun: Math.max(1, num(cap.maxOpsPerRun, base.capture.maxOpsPerRun)),
        minIntervalMs: num(cap.minIntervalMs, base.capture.minIntervalMs),
        timeoutMs: num(cap.timeoutMs, base.capture.timeoutMs),
      },
      limits: {
        maxProjectIndexBytes: num(lim.maxProjectIndexBytes, base.limits.maxProjectIndexBytes),
        maxSessionFiles: num(lim.maxSessionFiles, base.limits.maxSessionFiles),
        maxRecentSessions: num(lim.maxRecentSessions, base.limits.maxRecentSessions),
        maxConsolidationInputBytes: num(lim.maxConsolidationInputBytes, base.limits.maxConsolidationInputBytes),
        maxLineChars: num(lim.maxLineChars, base.limits.maxLineChars),
        maxSessionLineChars: session === 160 ? base.limits.maxSessionLineChars : session,
      },
      stats: {
        lastInjectedAt: nullable(stat.lastInjectedAt, base.stats.lastInjectedAt),
        lastInjectedBytes: num(stat.lastInjectedBytes, base.stats.lastInjectedBytes),
        lastInjectedTokens: num(stat.lastInjectedTokens, base.stats.lastInjectedTokens),
        lastInjectedSessionID: str(stat.lastInjectedSessionID, base.stats.lastInjectedSessionID),
        lastConsolidatedAt: nullable(stat.lastConsolidatedAt, base.stats.lastConsolidatedAt),
        lastConsolidationCost: num(stat.lastConsolidationCost, base.stats.lastConsolidationCost),
        lastConsolidationTokens: num(stat.lastConsolidationTokens, base.stats.lastConsolidationTokens),
        lastOperationCount: num(stat.lastOperationCount, base.stats.lastOperationCount),
      },
    }
  }
}
