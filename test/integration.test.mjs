import assert from "node:assert/strict"
import plugin from "../.test-build/index.js"

const STOP = Symbol("stop")
const OWNER_REGISTRY = Symbol.for("opencode.goal.owner-registry.v1")

class EventBus {
  constructor() {
    this.queue = []
    this.waiters = []
    this.closed = false
  }
  push(event) {
    if (this.closed) return
    if (this.waiters.length > 0) this.waiters.shift()(event)
    else this.queue.push(event)
  }
  close() {
    this.closed = true
    while (this.waiters.length > 0) this.waiters.shift()(STOP)
  }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const next = this.queue.length > 0 ? this.queue.shift() : await new Promise((r) => this.waiters.push(r))
      if (next === STOP || this.closed) return
      yield next
    }
  }
}

function makeHarness(options = {}, sharedStorage) {
  const prompts = []
  const synthetics = []
  const compacts = []
  const hooks = new Map()
  const commands = new Map()
  const storage = sharedStorage ?? new Map()
  const bus = new EventBus()
  let cost = 0

  const ctx = {
    app: { version: "test" },
    location: { directory: "/test" },
    options: {
      retryJitter: 0,
      retryDelaysMs: [10],
      retryMaxAttempts: 2,
      maxRounds: 5,
      maxStalledRounds: 3,
      maxCompactions: 1,
      compactAtRatio: 0.9,
      ...options,
    },
    command: {
      transform: async (cb) => {
        cb({ add: (definition) => commands.set(definition.name, definition) })
        return { dispose: async () => {} }
      },
    },
    session: {
      get: async ({ sessionID }) => ({
        id: sessionID,
        cost,
        model: { providerID: "test", id: "model" },
        location: { directory: "/test" },
      }),
      prompt: async (input) => {
        prompts.push(input)
        const inboxID = `inbox_${prompts.length}`
        bus.push({
          type: "session.inbox.enqueued",
          data: {
            sessionID: input.sessionID,
            inboxID,
            item: {
              type: "user",
              payload: { text: input.text, metadata: input.metadata },
              delivery: "queue",
            },
          },
          location: { directory: "/test" },
        })
        bus.push({
          type: "session.inbox.delivered",
          data: { sessionID: input.sessionID, inboxID },
          location: { directory: "/test" },
        })
        return { id: inboxID }
      },
      synthetic: async (input) => {
        synthetics.push(input)
        return { id: "synthetic" }
      },
      compact: async (input) => {
        compacts.push(input)
        return { id: "compact" }
      },
      interrupt: async () => ({ interrupted: false }),
      hook: async (name, callback) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
    event: { subscribe: () => bus },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => {
        storage.set(key, value)
      },
      remove: async (key) => {
        storage.delete(key)
      },
    },
    model: {
      list: async () => [{ id: "model", providerID: "test", limit: { context: 100_000 } }],
    },
  }

  return {
    ctx,
    bus,
    prompts,
    synthetics,
    compacts,
    hooks,
    commands,
    storage,
    setCost: (value) => {
      cost = value
    },
  }
}

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

function event(bus, type, data) {
  bus.push({ type, data, location: { directory: "/test" } })
}

async function cmd(harness, sessionID, text) {
  const definition = harness.commands.get("goal")
  assert.ok(definition, "goal command registered")
  await definition.execute({ sessionID, prompt: { text } })
}

function started(harness, sessionID) {
  event(harness.bus, "session.execution.started", { sessionID })
}

function text(harness, sessionID, messageID, value) {
  event(harness.bus, "session.text.ended", {
    sessionID,
    assistantMessageID: messageID,
    text: value,
  })
}

function step(harness, sessionID, messageID, input = 100, output = 10) {
  event(harness.bus, "session.step.ended", {
    sessionID,
    assistantMessageID: messageID,
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

function ok(harness, sessionID) {
  event(harness.bus, "session.execution.succeeded", { sessionID })
}

function fail(harness, sessionID, error) {
  event(harness.bus, "session.execution.failed", { sessionID, error })
}

const instances = []

async function setup(options, sharedStorage) {
  const harness = makeHarness(options, sharedStorage)
  const cleanup = await plugin.setup(harness.ctx)
  harness.cleanup = cleanup
  instances.push({ harness, cleanup })
  return harness
}

let passed = 0
async function test(name, fn) {
  try {
    globalThis[OWNER_REGISTRY]?.owners?.clear()
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

await test("starts once, continues after a clean round, stops on GOAL_DONE", async () => {
  const h = await setup()
  const sid = "s1"
  await cmd(h, sid, "build the thing")
  assert.equal(h.prompts.length, 1)
  assert.ok(h.prompts[0].text.startsWith("Goal: build the thing"))
  assert.equal(h.prompts[0].delivery, "queue")
  assert.equal(h.prompts[0].metadata.goal.generated, true)

  started(h, sid)
  text(h, sid, "m1", "some work")
  step(h, sid, "m1")
  ok(h, sid)
  await wait()

  assert.equal(h.prompts.length, 2)
  assert.ok(h.prompts[1].text.includes("Continue"))
  assert.ok(!h.prompts[1].text.includes("build the thing"), "continuation must not repeat the goal")

  started(h, sid)
  text(h, sid, "m2", "finished\nGOAL_DONE")
  step(h, sid, "m2")
  ok(h, sid)
  await wait()

  assert.equal(h.prompts.length, 2, "no continuation after GOAL_DONE")
  assert.ok(h.synthetics.some((s) => s.text.includes("goal done")))
  await h.cleanup()
  h.bus.close()
})

await test("a failed round schedules the short plugin retry, never the goal", async () => {
  const h = await setup()
  const sid = "s2"
  await cmd(h, sid, "repair the build")
  started(h, sid)
  fail(h, sid, { type: "provider.transport", message: "fetch failed" })
  await wait(60)

  assert.equal(h.prompts.length, 2)
  assert.ok(h.prompts[1].text.includes("Resume"))
  assert.ok(!h.prompts[1].text.includes("repair the build"))
  assert.equal(h.prompts.filter((p) => p.text.startsWith("Goal:")).length, 1)

  started(h, sid)
  text(h, sid, "m1", "made progress")
  step(h, sid, "m1")
  ok(h, sid)
  await wait()
  assert.equal(h.prompts.length, 3)
  assert.ok(h.prompts[2].text.includes("Continue"))

  started(h, sid)
  fail(h, sid, { type: "provider.quota", message: "insufficient_quota", status: 429 })
  await wait(80)
  assert.equal(h.prompts.length, 3, "quota failure must not retry")
  assert.ok(h.synthetics.some((s) => s.text.includes("quota")))
  await h.cleanup()
  h.bus.close()
})

await test("retry hook vetoes quota instead of forcing another attempt", async () => {
  const h = await setup()
  await cmd(h, "s3", "quota goal")
  const hook = h.hooks.get("retry")
  assert.ok(hook, "retry hook registered")
  const event = {
    sessionID: "s3",
    error: { type: "provider.rate-limit", message: "insufficient_quota", status: 429 },
    attempt: 3,
    decision: { retry: true, delay: 1234 },
  }
  await hook(event)
  assert.equal(event.decision.retry, false)
  assert.ok(h.synthetics.some((s) => s.text.includes("quota")))
  await h.cleanup()
  h.bus.close()
})

await test("GOAL_BLOCKED pauses without another round", async () => {
  const h = await setup()
  const sid = "s4"
  await cmd(h, sid, "do the impossible")
  started(h, sid)
  text(h, sid, "m1", "GOAL_BLOCKED: no credentials")
  step(h, sid, "m1")
  ok(h, sid)
  await wait()
  assert.equal(h.prompts.length, 1)
  assert.ok(h.synthetics.some((s) => s.text.includes("GOAL_BLOCKED")))
  await h.cleanup()
  h.bus.close()
})

await test("round budget stops the loop", async () => {
  const h = await setup({ maxRounds: 1 })
  const sid = "s5"
  await cmd(h, sid, "keep going")
  started(h, sid)
  text(h, sid, "m1", "step one")
  step(h, sid, "m1")
  ok(h, sid)
  await wait()
  assert.equal(h.prompts.length, 2)

  started(h, sid)
  text(h, sid, "m2", "step two")
  step(h, sid, "m2")
  ok(h, sid)
  await wait()
  assert.equal(h.prompts.length, 2)
  assert.ok(h.synthetics.some((s) => s.text.includes("round budget")))
  await h.cleanup()
  h.bus.close()
})

await test("retry budget stops after the configured attempts", async () => {
  const h = await setup({ retryMaxAttempts: 1, retryDelaysMs: [5] })
  const sid = "s6"
  await cmd(h, sid, "unstable work")
  started(h, sid)
  fail(h, sid, { type: "provider.transport", message: "fetch failed" })
  await wait(40)
  assert.equal(h.prompts.length, 2)

  started(h, sid)
  fail(h, sid, { type: "provider.transport", message: "fetch failed" })
  await wait(40)
  assert.equal(h.prompts.length, 2, "no retry beyond the budget")
  assert.ok(h.synthetics.some((s) => s.text.includes("retries exhausted")))
  await h.cleanup()
  h.bus.close()
})

await test("a stored goal is restored paused, never auto-resumed", async () => {
  const shared = new Map()
  const h1 = await setup({}, shared)
  const sid = "s7"
  await cmd(h1, sid, "persisted goal")
  assert.ok(shared.has(`goal.v1.${sid}`))
  await h1.cleanup()
  h1.bus.close()

  const h2 = await setup({}, shared)
  started(h2, sid)
  await wait()
  assert.equal(h2.prompts.length, 0, "restored goal must not send a prompt")
  assert.ok(h2.synthetics.some((s) => s.text.includes("restored as paused")))
  await h2.cleanup()
  h2.bus.close()
})

await test("location filter ignores events from other locations", async () => {
  const h = await setup()
  const sid = "s8"
  await cmd(h, sid, "local goal")
  h.bus.push({
    type: "session.execution.started",
    data: { sessionID: sid },
    location: { directory: "/elsewhere" },
  })
  h.bus.push({
    type: "session.text.ended",
    data: { sessionID: sid, assistantMessageID: "m1", text: "done\nGOAL_DONE" },
    location: { directory: "/elsewhere" },
  })
  h.bus.push({
    type: "session.execution.succeeded",
    data: { sessionID: sid },
    location: { directory: "/elsewhere" },
  })
  await wait()
  assert.equal(h.prompts.length, 1, "foreign location must be ignored")
  assert.equal(h.synthetics.length, 0)
  await h.cleanup()
  h.bus.close()
})

await test("a second boot does not steal or pause the owner's active goal", async () => {
  const shared = new Map()
  const sid = "s10"
  const h1 = await setup({}, shared)
  await cmd(h1, sid, "owner goal")
  assert.equal(h1.prompts.length, 1)

  const h2 = await setup({}, shared)
  started(h2, sid)
  text(h2, sid, "m1", "foreign work\nGOAL_DONE")
  step(h2, sid, "m1")
  ok(h2, sid)
  await wait()

  assert.equal(h2.prompts.length, 0, "foreign boot must not prompt")
  assert.equal(h2.synthetics.length, 0, "foreign boot must not pause/notify")
  assert.equal(shared.get(`goal.v1.${sid}`).phase, "active", "owner's goal stays active")

  await h1.cleanup()
  h1.bus.close()
  await h2.cleanup()
  h2.bus.close()
})

await test("status on another boot is read-only and keeps the owner", async () => {
  const shared = new Map()
  const sid = "s11"
  const h1 = await setup({}, shared)
  await cmd(h1, sid, "status target")

  const h2 = await setup({}, shared)
  await cmd(h2, sid, "status")
  assert.ok(h2.synthetics.some((s) => s.text.includes("status target")))
  assert.equal(shared.get(`goal.v1.${sid}`).phase, "active")

  started(h1, sid)
  text(h1, sid, "m1", "owner progress")
  step(h1, sid, "m1")
  ok(h1, sid)
  await wait()
  assert.equal(h1.prompts.length, 2, "owner still continues after a foreign status check")

  await h1.cleanup()
  h1.bus.close()
  await h2.cleanup()
  h2.bus.close()
})

await test("stop from another boot takes over and the old owner stands down", async () => {
  const shared = new Map()
  const sid = "s12"
  const h1 = await setup({}, shared)
  await cmd(h1, sid, "takeover goal")

  const h2 = await setup({}, shared)
  await cmd(h2, sid, "stop")
  assert.equal(shared.get(`goal.v1.${sid}`).phase, "paused")
  assert.ok(h2.synthetics.some((s) => s.text.includes("paused")))

  started(h1, sid)
  text(h1, sid, "m1", "too late")
  step(h1, sid, "m1")
  ok(h1, sid)
  await wait()
  assert.equal(h1.prompts.length, 1, "old owner must not continue after losing ownership")

  await h1.cleanup()
  h1.bus.close()
  await h2.cleanup()
  h2.bus.close()
})

for (const instance of instances) {
  try {
    await instance.cleanup()
  } catch {}
  instance.harness.bus.close()
}

console.log(`\n${passed} integration tests passed`)
