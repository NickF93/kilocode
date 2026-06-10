import { MemorySchema } from "./schema"

export namespace MemoryTopics {
  export type Input = {
    file?: MemorySchema.Source
    section?: string
    key?: string
    text: string
  }

  const stop = new Set([
    "about",
    "after",
    "always",
    "and",
    "are",
    "before",
    "command",
    "commands",
    "could",
    "decisions",
    "facts",
    "from",
    "have",
    "into",
    "kilo",
    "memory",
    "project",
    "should",
    "that",
    "the",
    "this",
    "use",
    "uses",
    "with",
  ])

  const rules: [MemorySchema.Topic, RegExp][] = [
    ["corrections", /\b(correction|wrong|incorrect|stale|mistake|fix memory|not true)\b/i],
    ["constraints", /\b(always|never|must|should|prefer|avoid|require(?:d|ment)?|constraint|rule|policy|boundary|guard|do not|don't)\b/i],
    ["environment", /\b(command|commands|setup|install|dependencies|package manager|tool|tooling|toolchain|runtime|local|locally|path|paths|folder|folders|directory|directories|worktree|workspace|script|scripts|dev server)\b/i],
    ["quality", /\b(test|tests|unit|typecheck|lint|format|check|checks|ci|coverage|regression|flaky|compile|build command|bun run build)\b/i],
    [
      "ui",
      /\b(ui|ux|brand|branding|color|colors|palette|identity|theme|page|frontend|visual|style|design|css|html|solid|react|webview|sidebar|layout|yellow|black|white|red|green|blue|purple|orange|pink|gr[ae]y)\b|#[0-9a-f]{3,8}\b/i,
    ],
    ["integration", /\b(api|sdk|provider|extension|cli|server|http|sse|mcp|gateway|vscode|endpoint|client)\b/i],
    [
      "workflow",
      /\b(workflow|process|merge|rebase|commit|branch|pr|pull request|review|release|handoff|session|agent|worktree|upstream|shared|fork)\b/i,
    ],
  ]
  const aliases = new Map<string, string[]>([
    ["brand", ["branding", "color", "colors", "palette", "identity", "theme", "visual", "style", "yellow", "black"]],
    ["branding", ["brand", "color", "colors", "palette", "identity", "theme", "visual", "style", "yellow", "black"]],
    ["color", ["colors", "brand", "branding", "palette", "theme", "visual", "style", "yellow", "black"]],
    ["colors", ["color", "brand", "branding", "palette", "theme", "visual", "style", "yellow", "black"]],
    ["palette", ["color", "colors", "brand", "branding", "theme", "visual", "style", "yellow", "black"]],
    ["identity", ["brand", "branding", "visual", "style"]],
    ["theme", ["brand", "branding", "color", "colors", "style"]],
    ["vscode", ["vs_code", "extension", "webview"]],
    ["extension", ["vscode", "vs_code", "webview"]],
    ["webview", ["vscode", "vs_code", "extension"]],
    ["check", ["checks", "test", "tests", "typecheck", "lint"]],
    ["checks", ["check", "test", "tests", "typecheck", "lint"]],
    ["test", ["tests", "check", "checks"]],
    ["tests", ["test", "check", "checks"]],
    ["upstream", ["shared", "opencode", "fork", "merge"]],
    ["shared", ["upstream", "opencode", "fork", "merge"]],
  ])

  function uniq(input: MemorySchema.Topic[]): MemorySchema.Topic[] {
    return [...new Set(input)].slice(0, 3)
  }

  function body(input: Input) {
    return [input.file ?? "", input.section ?? "", input.key ?? "", input.text].join(" ")
  }

  function lex(input: Input) {
    return [input.key ?? "", input.text].join(" ")
  }

  function base(input: Input): MemorySchema.Topic[] {
    if (input.file === "corrections.md") return ["corrections"]
    if (input.file === "environment.md") return ["environment"]
    const section = input.section?.toLowerCase() ?? ""
    if (section.includes("constraint")) return ["constraints"]
    if (section.includes("decision")) return ["project"]
    if (input.file === "project.md") return ["project"]
    return []
  }

  export function assign(input: Input): MemorySchema.Topic[] {
    const text = body(input)
    const found = rules.flatMap(([topic, rule]) => (rule.test(text) ? [topic] : []))
    const topics = uniq([...base(input), ...found])
    return topics.length > 0 ? topics : ["project"]
  }

  export function match(input: string): MemorySchema.Topic[] {
    const text = input.trim()
    if (!text) return []
    return uniq(rules.flatMap(([topic, rule]) => (rule.test(text) ? [topic] : [])))
  }

  export function terms(input: Input, max = 6) {
    const found =
      lex(input)
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9_.-]{2,}/g)
        ?.map((item) => item.replaceAll(/[_.-]+/g, "_"))
        .filter((item) => !stop.has(item)) ?? []
    return [...new Set(found)].slice(0, max)
  }

  export function expand(input: string[], max = 24) {
    const result = new Set(input)
    if (result.has("vs") && result.has("code")) {
      result.add("vscode")
      result.add("vs_code")
      result.add("extension")
      result.add("webview")
    }
    for (const item of input) {
      for (const alias of aliases.get(item) ?? []) result.add(alias)
    }
    return [...result].slice(0, max)
  }
}
