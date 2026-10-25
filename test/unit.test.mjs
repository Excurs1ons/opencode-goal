import assert from "node:assert/strict"
import { classifyError, parseGoalMarker, computeBackoff, hashText } from "../.test-build/index.js"

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

const cls = (error) => classifyError(error)

test("plain 429 is retryable", () => {
  const c = cls({ type: "provider.rate-limit", message: "Too Many Requests", status: 429 })
  assert.equal(c.kind, "rate")
  assert.equal(c.retryable, true)
})

test("429 insufficient_quota is terminal quota", () => {
  const c = cls({ type: "provider.rate-limit", message: "429 insufficient_quota", status: 429 })
  assert.equal(c.kind, "quota")
  assert.equal(c.retryable, false)
  assert.equal(c.terminal, true)
})

test("402 is quota", () => {
  const c = cls({ type: "provider.error", message: "payment required", status: 402 })
  assert.equal(c.kind, "quota")
})

test("403 with credit balance is quota, not auth", () => {
  const c = cls({ type: "provider.error", message: "Your credit balance is too low", status: 403 })
  assert.equal(c.kind, "quota")
})

test("insufficient balance body is quota", () => {
  const c = cls({
    type: "provider.unknown",
    message: "request failed",
    status: 400,
    response: { body: '{"error":{"code":"insufficient_balance"}}' },
  })
  assert.equal(c.kind, "quota")
})

test("Chinese balance error is quota", () => {
  const c = cls({ type: "provider.error", message: "账户余额不足，请充值" })
  assert.equal(c.kind, "quota")
})

test("monthly subscription limit is quota", () => {
  const c = cls({ type: "provider.rate-limit", message: "monthly plan limit reached", status: 429 })
  assert.equal(c.kind, "quota")
})

test("per-minute quota wording stays a rate limit", () => {
  const c = cls({ type: "provider.rate-limit", message: "request quota exceeded per minute", status: 429 })
  assert.equal(c.kind, "rate")
  assert.equal(c.retryable, true)
})

test("generic quota exhaustion is terminal quota", () => {
  const c = cls({ type: "provider.rate-limit", message: "quota exceeded", status: 429 })
  assert.equal(c.kind, "quota")
})

test("rate limit exceeded is not quota", () => {
  const c = cls({ type: "provider.rate-limit", message: "rate limit exceeded", status: 429 })
  assert.equal(c.kind, "rate")
})

test("401 is auth", () => {
  const c = cls({ type: "provider.auth", message: "invalid api key", status: 401 })
  assert.equal(c.kind, "auth")
  assert.equal(c.retryable, false)
})

test("403 rate limit is retryable", () => {
  const c = cls({ type: "provider.error", message: "rate limit exceeded", status: 403 })
  assert.equal(c.kind, "rate")
  assert.equal(c.retryable, true)
})

test("403 plain auth is terminal", () => {
  const c = cls({ type: "provider.error", message: "invalid api token", status: 403 })
  assert.equal(c.kind, "auth")
  assert.equal(c.retryable, false)
})

test("500 is retryable server", () => {
  const c = cls({ type: "provider.internal", message: "internal server error", status: 503 })
  assert.equal(c.kind, "server")
  assert.equal(c.retryable, true)
})

test("transport / DNS is retryable network", () => {
  const c = cls({ type: "provider.transport", message: "getaddrinfo EAI_AGAIN" })
  assert.equal(c.kind, "network")
  assert.equal(c.retryable, true)
})

test("overloaded text is retryable", () => {
  const c = cls({ type: "provider.error", message: "upstream overloaded, try again later" })
  assert.equal(c.kind, "network")
  assert.equal(c.retryable, true)
})

test("context overflow is context, not retryable", () => {
  const c = cls({ type: "provider.invalid-request", message: "maximum context length exceeded", status: 400 })
  assert.equal(c.kind, "context")
  assert.equal(c.retryable, false)
})

test("400 invalid request is terminal invalid", () => {
  const c = cls({ type: "provider.invalid-request", message: "bad tool schema", status: 400 })
  assert.equal(c.kind, "invalid")
  assert.equal(c.retryable, false)
})

test("content filter is terminal", () => {
  const c = cls({ type: "provider.content-filter", message: "blocked by policy", status: 400 })
  assert.equal(c.kind, "content")
  assert.equal(c.retryable, false)
})

test("aborted is terminal", () => {
  const c = cls({ type: "aborted", message: "Execution was interrupted repeatedly" })
  assert.equal(c.kind, "aborted")
})

test("unknown stays unknown and is not retried", () => {
  const c = cls({ type: "provider.error", message: "something odd happened" })
  assert.equal(c.kind, "unknown")
  assert.equal(c.retryable, false)
})

test("marker done as last line", () => {
  assert.deepEqual(parseGoalMarker("worked\nGOAL_DONE"), { kind: "done" })
})

test("marker done with formatting", () => {
  assert.deepEqual(parseGoalMarker("done!\n**GOAL_DONE**"), { kind: "done" })
})

test("marker done inside a fence", () => {
  assert.deepEqual(parseGoalMarker("```\nGOAL_DONE\n```"), { kind: "done" })
})

test("marker done must be final", () => {
  assert.deepEqual(parseGoalMarker("GOAL_DONE\nmore work follows"), { kind: "none" })
})

test("marker blocked with reason", () => {
  assert.deepEqual(parseGoalMarker("GOAL_BLOCKED: missing api key"), {
    kind: "blocked",
    reason: "missing api key",
  })
})

test("marker blocked with reason on the next line", () => {
  assert.deepEqual(parseGoalMarker("GOAL_BLOCKED:\nno network access"), {
    kind: "blocked",
    reason: "no network access",
  })
})

test("quoted marker is not accepted", () => {
  assert.deepEqual(parseGoalMarker("I will print GOAL_DONE when finished."), { kind: "none" })
})

test("backoff jitter stays in bounds and escalates", () => {
  const cfg = { retryDelaysMs: [30_000, 60_000, 120_000], retryJitter: 0.2, retryMaxDelayMs: 900_000 }
  for (let i = 0; i < 3; i++) {
    const base = cfg.retryDelaysMs[i]
    for (const r of [0, 0.5, 0.999]) {
      const d = computeBackoff(i, cfg, () => r)
      assert.ok(d >= base * 0.8 - 1 && d <= base * 1.2 + 1, `${i}/${r} -> ${d}`)
    }
  }
  assert.equal(computeBackoff(0, cfg, () => 0.5), 30_000)
  assert.equal(computeBackoff(2, cfg, () => 0.5), 120_000)
  assert.equal(computeBackoff(99, cfg, () => 0.5), 120_000)
})

test("backoff clamp", () => {
  const cfg = { retryDelaysMs: [60_000], retryJitter: 1, retryMaxDelayMs: 31_000 }
  for (const r of [0, 0.5, 1]) assert.ok(computeBackoff(0, cfg, () => r) <= 31_000)
})

test("hash is stable and distinct", () => {
  assert.equal(hashText("hello"), hashText("hello"))
  assert.notEqual(hashText("hello"), hashText("hellp"))
})

console.log(`\n${passed} tests passed`)
