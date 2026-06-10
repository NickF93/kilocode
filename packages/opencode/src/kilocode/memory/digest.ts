// kilocode_change - new file

export namespace MemoryDigest {
  export type Summary = {
    topic?: string
    summary: string
  }

  const continuation =
    /\b(continue|resume|keep going|pick up|where (?:did )?we (?:stop|were)|where are we|recent work|what'?s next)\b/i
  const none =
    /\b(empty session|continuation-only|no substantive|no actual work|no meaningful|no actionable|nothing (?:substantive )?(?:was )?(?:done|changed|happened|saved)|just another|just asked|only asked|asked only)\b/i
  const prompt = /\bUser:\s+.*\b(continue|resume|keep going|pick up|where (?:did )?we (?:stop|were)|recent work|what'?s next)\b/i
  const setup = /\b(initial session setup|session started|fresh session)\b/i
  const idle =
    /\b(no tasks? (?:has|have) been (?:started|initiated)|no task started|no tasks? started|ready for (?:the )?next task)\b/i
  const state = /\b(recent state|current state|current repo state|current worktree|repo state|latest commit)\b/i
  const tree = /\b(branch|worktree|working tree|untracked|git status|git log)\b/i
  const next = /\b(next(?: concrete)? step|remaining|blocker|todo|follow[ -]?up|continue by|resume by)\b/i

  function value(input: string | Summary) {
    const text = typeof input === "string" ? input : `${input.topic ?? ""} ${input.summary}`
    return text.trim().replaceAll(/\s+/g, " ")
  }

  export function empty(input: string | Summary) {
    const text = value(input)
    if (!text) return true
    if (text.length <= 260 && prompt.test(text)) return true
    if (setup.test(text) && idle.test(text)) return true
    if (state.test(text) && tree.test(text) && !next.test(text)) return true
    return continuation.test(text) && none.test(text)
  }
}
