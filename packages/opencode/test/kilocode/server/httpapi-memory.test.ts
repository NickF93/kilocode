import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import { MemoryPaths } from "../../../src/kilocode/server/httpapi/groups/memory"
import * as HttpApiServer from "../../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

type Json = Record<string, unknown>

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler

  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        HttpApiServer.context,
      )
    },
  }
}

function rec(input: unknown): Json {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected object")
  return input as Json
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi memory", () => {
  test("manages project memory through HTTP routes", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const api = app()
    const send = (method: string, route: string, body?: unknown) =>
      api.request(route, {
        method,
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const json = async (method: string, route: string, body?: unknown) => {
      const response = await send(method, route, body)
      expect(response.status).toBe(200)
      return rec(await response.json())
    }

    const status = await json("GET", MemoryPaths.status)
    expect(rec(status.state).enabled).toBe(false)
    expect(rec(status.index).estimatedTokens).toBe(0)
    const stats = rec(rec(status.state).stats)
    expect(stats.lastInjectedAt).toBe(0)
    expect(stats.lastInjectedSessionID).toBe("")
    expect(stats.lastConsolidatedAt).toBe(0)

    const enable = await json("POST", MemoryPaths.enable)
    expect(rec(enable.state).enabled).toBe(true)
    expect(rec(rec(enable.state).stats).lastInjectedSessionID).toBe("")

    const remembered = await json("POST", MemoryPaths.remember, {
      key: "httpapi_memory",
      text: "Use the memory HTTP API test as a stable project fact.",
      sessionID: "ses_http_memory",
    })
    expect(remembered.operationCount).toBe(1)
    expect(String(rec(remembered.index).text)).toContain("httpapi_memory")

    const corrected = await json("POST", MemoryPaths.correct, {
      key: "httpapi_correction",
      text: "Prefer correction memory over stale project facts.",
    })
    expect(corrected.operationCount).toBe(1)
    expect(String(rec(corrected.index).text)).toContain("httpapi_correction")

    const show = await json("GET", MemoryPaths.show)
    expect(String(show.index)).toContain("httpapi_memory")
    expect(String(rec(show.sources).project)).toContain("httpapi_memory")
    expect(typeof show.decisions).toBe("string")
    expect(String(show.decisions)).toContain('"sessionID":"ses_http_memory"')

    const forgotten = await json("POST", MemoryPaths.forget, { query: "httpapi_memory" })
    expect(forgotten.removed).toBe(1)
    expect(String(rec(forgotten.index).text)).not.toContain("httpapi_memory")

    const disable = await json("POST", MemoryPaths.disable)
    expect(rec(disable.state).enabled).toBe(false)

    const purge = await json("POST", MemoryPaths.purge)
    expect(purge.purged).toBe(true)
  })
})
