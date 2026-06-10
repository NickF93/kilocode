export namespace MemoryRedact {
  const keys = new Set(["password", "apikey", "secret", "token"])
  const secret = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
    /["']?\b(password|api[_-]?key|secret|token)["']?\s*[:=]\s*["']?[^"'\s,}]+["']?/i,
  ]

  function sensitive(input: string) {
    return keys.has(input.replaceAll(/[_-]/g, "").toLowerCase())
  }

  export function has(input: string) {
    return secret.some((item) => item.test(input))
  }

  export function text(input: string) {
    return secret.reduce((next, item) => {
      const flags = item.flags.includes("g") ? item.flags : `${item.flags}g`
      return next.replace(new RegExp(item.source, flags), "[redacted]")
    }, input)
  }

  export function value(input: unknown, name?: string): unknown {
    if (name && sensitive(name)) return "[redacted]"
    if (typeof input === "string") return text(input)
    if (Array.isArray(input)) return input.map((item) => value(item))
    if (typeof input !== "object" || input === null) return input
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item, key)]))
  }
}
