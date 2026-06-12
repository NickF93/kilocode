type Event = {
  on(type: "memory.status" | "memory.updated" | "memory.error", fn: (event: MemoryEvent) => void): void
}

type MemoryEvent = {
  properties: {
    sessionID?: string
    detail?: unknown
  }
}

type Toast = {
  show(input: { message: string; variant: "info" | "success"; duration: number }): void
}

export namespace MemoryTuiEvents {
  export function attach(input: { event: Event; toast: Toast; sessionID: string }) {
    const seen = { last: "" }
    const handler = (event: MemoryEvent) => {
      if (event.properties.sessionID && event.properties.sessionID !== input.sessionID) return
      const detail = event.properties.detail
      if (!detail || typeof detail !== "object") return
      const item = detail as { type?: unknown; message?: unknown }
      if (item.type === "skipped") return
      if (typeof item.message !== "string") return
      const key = `${event.properties.sessionID ?? ""}:${String(item.type)}:${item.message}`
      if (key === seen.last) return
      seen.last = key
      input.toast.show({
        message: item.message,
        variant: item.type === "saved" ? "success" : "info",
        duration: 3500,
      })
    }
    input.event.on("memory.status", handler)
    input.event.on("memory.updated", handler)
    input.event.on("memory.error", handler)
  }
}
