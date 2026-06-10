import { describe, expect, test } from "bun:test"
import path from "path"
import { KiloMemory, MemoryRecall } from "../../../src/kilocode/memory"
import { tmpdir } from "../../fixture/fixture"

async function corpus(root: string) {
  await KiloMemory.enable({ root })
  await KiloMemory.apply({
    root,
    ops: [
      {
        action: "add",
        file: "project.md",
        section: "Facts",
        key: "kilo_branch_is_yellow_and",
        text: "kilo branch is yellow and black",
      },
      {
        action: "add",
        file: "environment.md",
        section: "Commands",
        key: "extension_unit_tests",
        text: "Run VS Code unit tests with bun run test:unit from packages/kilo-vscode.",
      },
      {
        action: "add",
        file: "project.md",
        section: "Constraints",
        key: "opencode_fork_boundary",
        text: "Prefer Kilo-owned paths; keep shared opencode edits minimal and mark required upstream changes.",
      },
      {
        action: "add",
        file: "project.md",
        section: "Facts",
        key: "kilo_sidebar_ui",
        text: "Kilo sidebar UI shows memory status and token estimates.",
      },
      {
        action: "add",
        file: "project.md",
        section: "Facts",
        key: "kilo_html_page",
        text: "Kilo has a standalone HTML page in packages/kilo-console/public/kilo.html.",
      },
    ],
  })
}

describe("memory recall quality", () => {
  test("alias and topic fallback find expected memories", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".kilo", "memory")
    await corpus(root)

    const cases = [
      {
        query: "what is Kilo brand?",
        key: "kilo_branch_is_yellow_and",
      },
      {
        query: "what palette should I use for Kilo UI?",
        key: "kilo_branch_is_yellow_and",
      },
      {
        query: "what checks apply to extension changes?",
        key: "extension_unit_tests",
      },
      {
        query: "what should I know before editing upstream files?",
        key: "opencode_fork_boundary",
      },
    ]

    for (const item of cases) {
      expect(MemoryRecall.shouldRecall(item.query), item.query).toBe(true)
      const result = await MemoryRecall.search({ root, query: item.query, limit: 3 })
      expect(result?.tokens ?? 0, item.query).toBeLessThanOrEqual(500)
      expect(
        result?.hits.some((hit) => hit.text.includes(item.key)),
        `${item.query} should recall ${item.key}`,
      ).toBe(true)
    }

    const brand = await MemoryRecall.search({ root, query: "what is Kilo brand?" })
    expect(brand?.hits.length ?? 0).toBeLessThanOrEqual(2)
  })
})
