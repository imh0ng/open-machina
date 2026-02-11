import { test, expect } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { defaultsUrl, getPluginStatus, info, OpenMachinaPlugin, resolvePluginRegistration } from "./index"

test("defaultsUrl points at workspace defaults.json", async () => {
  expect(defaultsUrl.pathname.endsWith("/config/defaults.json")).toBe(true)
  expect(await Bun.file(defaultsUrl).exists()).toBe(true)
})

test("info() returns stable shape", async () => {
  const out = await info()
  expect(out.name).toBe("open-machina")
  expect(out.marker).toBe("[OPEN-MACHINA]")
  expect(out.version.length > 0).toBe(true)
  expect(out.defaultsUrl.includes("defaults.json")).toBe(true)
})

test("resolvePluginRegistration supports local/dev/prod", async () => {
  const local = await resolvePluginRegistration({ MACHINA_PLUGIN_MODE: "local" })
  expect(local.mode).toBe("local")
  expect(local.resolvedEntry?.endsWith("/packages/open-machina-plugin/src/index.ts")).toBe(true)

  const dev = await resolvePluginRegistration({ MACHINA_PLUGIN_MODE: "dev" })
  expect(dev.mode).toBe("dev")
  expect(dev.resolvedEntry?.endsWith("/packages/open-machina-plugin/dist/index.js")).toBe(true)

  const prod = await resolvePluginRegistration({ MACHINA_PLUGIN_MODE: "prod" })
  expect(prod.mode).toBe("prod")
  expect(prod.resolvedEntry).toBe("open-machina-plugin")
})

test("getPluginStatus returns actionable invalid mode error", async () => {
  const out = await getPluginStatus({ MACHINA_PLUGIN_MODE: "broken" })

  expect(out.status).toBe("error")
  if (out.status === "error") {
    expect(out.code).toBe("INVALID_MODE")
    expect(out.hint.includes("local, dev, or prod")).toBe(true)
  }
})

test("OpenMachinaPlugin returns tool hooks compatible with OpenCode", async () => {
  const hooks = await OpenMachinaPlugin({
    client: {
      session: {},
    },
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost:4096"),
  })

  expect(typeof hooks.tool).toBe("object")
  expect(Object.keys(hooks.tool ?? {})).toContain("open_machina_info")
  expect(Object.keys(hooks.tool ?? {})).toContain("open_machina_connectors")
  expect(Object.keys(hooks.tool ?? {})).toContain("open_machina_workspace")

  if (!hooks.tool?.open_machina_info) {
    throw new Error("open_machina_info tool missing")
  }

  const out = await hooks.tool.open_machina_info.execute({}, {
    sessionID: "s-1",
    messageID: "m-1",
    agent: "default",
    directory: "/tmp/project",
    worktree: "/tmp/project",
  })
  const payload = JSON.parse(out) as { identity: { name: string } }
  expect(payload.identity.name).toBe("open-machina")
})

test("open_machina_decide reports unavailable judge when env is missing", async () => {
  const hooks = await OpenMachinaPlugin({
    client: {
      session: {},
    },
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost:4096"),
  })

  if (!hooks.tool?.open_machina_decide) {
    throw new Error("open_machina_decide tool missing")
  }

  let message = ""
  try {
    await hooks.tool.open_machina_decide.execute({ input: {} }, {
      sessionID: "s-1",
      messageID: "m-1",
      agent: "default",
      directory: "/tmp/project",
      worktree: "/tmp/project",
    })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }

  expect(message).toContain("AUTONOMY_JUDGE_UNAVAILABLE")
})

test("open_machina_decide resolves key from OpenCode auth store", async () => {
  const originalEnv = {
    MACHINA_JUDGE_API_URL: process.env.MACHINA_JUDGE_API_URL,
    MACHINA_JUDGE_API_KEY: process.env.MACHINA_JUDGE_API_KEY,
    MACHINA_JUDGE_MODEL: process.env.MACHINA_JUDGE_MODEL,
    MACHINA_JUDGE_PROVIDER: process.env.MACHINA_JUDGE_PROVIDER,
    MACHINA_JUDGE_AUTH_PROVIDER: process.env.MACHINA_JUDGE_AUTH_PROVIDER,
    OPENCODE_AUTH_PATH: process.env.OPENCODE_AUTH_PATH,
  }
  process.env.MACHINA_JUDGE_API_URL = "https://judge.example.test/v1/chat/completions"
  process.env.MACHINA_JUDGE_MODEL = "gpt-4o-mini"
  process.env.MACHINA_JUDGE_PROVIDER = "openai"
  process.env.MACHINA_JUDGE_AUTH_PROVIDER = "open-machina-judge"

  const dir = await mkdtemp(path.join(os.tmpdir(), "open-machina-auth-"))
  const authPath = path.join(dir, "auth.json")
  process.env.OPENCODE_AUTH_PATH = authPath
  await Bun.write(authPath, JSON.stringify({ "open-machina-judge": { type: "api", key: "judge-token" } }, null, 2))

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "continue",
                confidence: 0.9,
                reason: "safe to continue",
                priority: "medium",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch

  try {
    const hooks = await OpenMachinaPlugin({
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-4o-mini": {},
                  },
                },
              ],
            },
          }),
        },
        session: {},
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
      serverUrl: new URL("http://localhost:4096"),
    })

    if (!hooks.tool?.open_machina_decide) {
      throw new Error("open_machina_decide tool missing")
    }

    const output = await hooks.tool.open_machina_decide.execute(
      {
        input: {
          now: new Date().toISOString(),
          userMessage: "continue",
          userIntent: "general-request",
          persona: {
            name: "open-machina",
            traits: ["autonomous"],
            goals: ["ship"],
            fixedPrinciples: ["prevent direct harm"],
          },
          activeWork: [],
          systemState: { networkHealth: "good" },
        },
      },
      {
        sessionID: "s-1",
        messageID: "m-1",
        agent: "default",
        directory: "/tmp/project",
        worktree: "/tmp/project",
      },
    )

    expect(output).toContain("\"action\": \"continue\"")
  } finally {
    process.env.MACHINA_JUDGE_API_URL = originalEnv.MACHINA_JUDGE_API_URL
    process.env.MACHINA_JUDGE_API_KEY = originalEnv.MACHINA_JUDGE_API_KEY
    process.env.MACHINA_JUDGE_MODEL = originalEnv.MACHINA_JUDGE_MODEL
    process.env.MACHINA_JUDGE_PROVIDER = originalEnv.MACHINA_JUDGE_PROVIDER
    process.env.MACHINA_JUDGE_AUTH_PROVIDER = originalEnv.MACHINA_JUDGE_AUTH_PROVIDER
    process.env.OPENCODE_AUTH_PATH = originalEnv.OPENCODE_AUTH_PATH
    globalThis.fetch = originalFetch
  }
})

test("open_machina_decide returns provider/model validation errors", async () => {
  const originalEnv = {
    MACHINA_JUDGE_API_URL: process.env.MACHINA_JUDGE_API_URL,
    MACHINA_JUDGE_MODEL: process.env.MACHINA_JUDGE_MODEL,
    MACHINA_JUDGE_PROVIDER: process.env.MACHINA_JUDGE_PROVIDER,
    MACHINA_JUDGE_AUTH_PROVIDER: process.env.MACHINA_JUDGE_AUTH_PROVIDER,
    OPENCODE_AUTH_PATH: process.env.OPENCODE_AUTH_PATH,
  }
  process.env.MACHINA_JUDGE_API_URL = "https://judge.example.test/v1/chat/completions"
  process.env.MACHINA_JUDGE_MODEL = "gpt-4o-mini"
  process.env.MACHINA_JUDGE_PROVIDER = "openai"
  process.env.MACHINA_JUDGE_AUTH_PROVIDER = "open-machina-judge"

  const dir = await mkdtemp(path.join(os.tmpdir(), "open-machina-auth-"))
  const authPath = path.join(dir, "auth.json")
  process.env.OPENCODE_AUTH_PATH = authPath
  await Bun.write(authPath, JSON.stringify({ "open-machina-judge": { type: "api", key: "judge-token" } }, null, 2))

  const hooks = await OpenMachinaPlugin({
    client: {
      provider: {
        list: async () => ({
          data: {
            all: [
              {
                id: "openai",
                models: {
                  "gpt-4.1-mini": {},
                },
              },
            ],
          },
        }),
      },
      session: {},
    },
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost:4096"),
  })

  if (!hooks.tool?.open_machina_decide) {
    throw new Error("open_machina_decide tool missing")
  }

  let message = ""
  try {
    await hooks.tool.open_machina_decide.execute(
      {
        input: {
          now: new Date().toISOString(),
          userMessage: "continue",
          userIntent: "general-request",
          persona: {
            name: "open-machina",
            traits: ["autonomous"],
            goals: ["ship"],
            fixedPrinciples: ["prevent direct harm"],
          },
          activeWork: [],
          systemState: { networkHealth: "good" },
        },
      },
      {
        sessionID: "s-1",
        messageID: "m-1",
        agent: "default",
        directory: "/tmp/project",
        worktree: "/tmp/project",
      },
    )
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }

  process.env.MACHINA_JUDGE_API_URL = originalEnv.MACHINA_JUDGE_API_URL
  process.env.MACHINA_JUDGE_MODEL = originalEnv.MACHINA_JUDGE_MODEL
  process.env.MACHINA_JUDGE_PROVIDER = originalEnv.MACHINA_JUDGE_PROVIDER
  process.env.MACHINA_JUDGE_AUTH_PROVIDER = originalEnv.MACHINA_JUDGE_AUTH_PROVIDER
  process.env.OPENCODE_AUTH_PATH = originalEnv.OPENCODE_AUTH_PATH

  expect(message).toContain("AUTONOMY_JUDGE_INVALID_MODEL")
})

test("open_machina_decide applies deny policy and uses fallback chain", async () => {
  const originalEnv = {
    MACHINA_JUDGE_API_URL: process.env.MACHINA_JUDGE_API_URL,
    MACHINA_JUDGE_MODEL: process.env.MACHINA_JUDGE_MODEL,
    MACHINA_JUDGE_PROVIDER: process.env.MACHINA_JUDGE_PROVIDER,
    MACHINA_JUDGE_AUTH_PROVIDER: process.env.MACHINA_JUDGE_AUTH_PROVIDER,
    MACHINA_JUDGE_DENY_MODELS: process.env.MACHINA_JUDGE_DENY_MODELS,
    MACHINA_JUDGE_FALLBACK_MODELS: process.env.MACHINA_JUDGE_FALLBACK_MODELS,
    OPENCODE_AUTH_PATH: process.env.OPENCODE_AUTH_PATH,
  }
  process.env.MACHINA_JUDGE_API_URL = "https://judge.example.test/v1/chat/completions"
  process.env.MACHINA_JUDGE_PROVIDER = "openai"
  process.env.MACHINA_JUDGE_MODEL = "gpt-primary"
  process.env.MACHINA_JUDGE_AUTH_PROVIDER = "open-machina-judge"
  process.env.MACHINA_JUDGE_DENY_MODELS = "openai/gpt-primary"
  process.env.MACHINA_JUDGE_FALLBACK_MODELS = "openai/gpt-fallback"

  const dir = await mkdtemp(path.join(os.tmpdir(), "open-machina-auth-"))
  const authPath = path.join(dir, "auth.json")
  process.env.OPENCODE_AUTH_PATH = authPath
  await Bun.write(authPath, JSON.stringify({ "open-machina-judge": { type: "api", key: "judge-token" } }, null, 2))

  const originalFetch = globalThis.fetch
  let sentModel = ""
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") {
      const payload = JSON.parse(init.body) as { model?: string }
      sentModel = payload.model ?? ""
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "continue",
                confidence: 0.92,
                reason: "fallback accepted",
                priority: "medium",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as unknown as typeof fetch

  try {
    const hooks = await OpenMachinaPlugin({
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-primary": {},
                    "gpt-fallback": {},
                  },
                },
              ],
            },
          }),
        },
        session: {},
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
      serverUrl: new URL("http://localhost:4096"),
    })

    if (!hooks.tool?.open_machina_decide) {
      throw new Error("open_machina_decide tool missing")
    }

    const out = await hooks.tool.open_machina_decide.execute(
      {
        input: {
          now: new Date().toISOString(),
          userMessage: "continue",
          userIntent: "general-request",
          persona: {
            name: "open-machina",
            traits: ["autonomous"],
            goals: ["ship"],
            fixedPrinciples: ["prevent direct harm"],
          },
          activeWork: [],
          systemState: { networkHealth: "good" },
        },
      },
      {
        sessionID: "s-1",
        messageID: "m-1",
        agent: "default",
        directory: "/tmp/project",
        worktree: "/tmp/project",
      },
    )

    expect(out).toContain("\"action\": \"continue\"")
    expect(sentModel).toBe("gpt-fallback")
  } finally {
    process.env.MACHINA_JUDGE_API_URL = originalEnv.MACHINA_JUDGE_API_URL
    process.env.MACHINA_JUDGE_MODEL = originalEnv.MACHINA_JUDGE_MODEL
    process.env.MACHINA_JUDGE_PROVIDER = originalEnv.MACHINA_JUDGE_PROVIDER
    process.env.MACHINA_JUDGE_AUTH_PROVIDER = originalEnv.MACHINA_JUDGE_AUTH_PROVIDER
    process.env.MACHINA_JUDGE_DENY_MODELS = originalEnv.MACHINA_JUDGE_DENY_MODELS
    process.env.MACHINA_JUDGE_FALLBACK_MODELS = originalEnv.MACHINA_JUDGE_FALLBACK_MODELS
    process.env.OPENCODE_AUTH_PATH = originalEnv.OPENCODE_AUTH_PATH
    globalThis.fetch = originalFetch
  }
})

test("chat.message uses AI decision and injects orchestration context", async () => {
  const originalEnv = {
    MACHINA_JUDGE_API_URL: process.env.MACHINA_JUDGE_API_URL,
    MACHINA_JUDGE_API_KEY: process.env.MACHINA_JUDGE_API_KEY,
    MACHINA_JUDGE_MODEL: process.env.MACHINA_JUDGE_MODEL,
    MACHINA_JUDGE_PROVIDER: process.env.MACHINA_JUDGE_PROVIDER,
    MACHINA_JUDGE_AUTH_PROVIDER: process.env.MACHINA_JUDGE_AUTH_PROVIDER,
    OPENCODE_AUTH_PATH: process.env.OPENCODE_AUTH_PATH,
  }
  process.env.MACHINA_JUDGE_API_URL = "https://judge.example.test/v1/chat/completions"
  process.env.MACHINA_JUDGE_MODEL = "gpt-judge"
  process.env.MACHINA_JUDGE_PROVIDER = "openai"
  process.env.MACHINA_JUDGE_AUTH_PROVIDER = "open-machina-judge"

  const dir = await mkdtemp(path.join(os.tmpdir(), "open-machina-auth-"))
  const authPath = path.join(dir, "auth.json")
  process.env.OPENCODE_AUTH_PATH = authPath
  await Bun.write(authPath, JSON.stringify({ "open-machina-judge": { type: "api", key: "token" } }, null, 2))

  let abortCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "abort",
                confidence: 0.91,
                reason: "urgent user interruption",
                priority: "critical",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch

  try {
    const hooks = await OpenMachinaPlugin({
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-judge": {},
                  },
                },
              ],
            },
          }),
        },
        session: {
          abort: async () => {
            abortCalls += 1
          },
        },
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
      serverUrl: new URL("http://localhost:4096"),
    })

    if (!hooks["tool.execute.before"] || !hooks["chat.message"]) {
      throw new Error("required hooks missing")
    }

    await hooks["tool.execute.before"](
      { tool: "workflow.run", sessionID: "s-1", callID: "c-1" },
      { args: {} },
    )

    const output = {
      message: {},
      parts: [{ type: "text", text: "Stop current task and handle incident now" }],
    }

    await hooks["chat.message"](
      { sessionID: "s-1", messageID: "m-1", agent: "atlas" },
      output,
    )

    expect(abortCalls).toBe(1)
    expect(output.parts[0]?.text).toContain("[OPEN-MACHINA ORCHESTRATION DECISION]")
    expect(output.parts[0]?.text).toContain("action=abort")
  } finally {
    process.env.MACHINA_JUDGE_API_URL = originalEnv.MACHINA_JUDGE_API_URL
    process.env.MACHINA_JUDGE_API_KEY = originalEnv.MACHINA_JUDGE_API_KEY
    process.env.MACHINA_JUDGE_MODEL = originalEnv.MACHINA_JUDGE_MODEL
    process.env.MACHINA_JUDGE_PROVIDER = originalEnv.MACHINA_JUDGE_PROVIDER
    process.env.MACHINA_JUDGE_AUTH_PROVIDER = originalEnv.MACHINA_JUDGE_AUTH_PROVIDER
    process.env.OPENCODE_AUTH_PATH = originalEnv.OPENCODE_AUTH_PATH
    globalThis.fetch = originalFetch
  }
})

test("chat.message applies defer and parallel execution paths", async () => {
  const originalEnv = {
    MACHINA_JUDGE_API_URL: process.env.MACHINA_JUDGE_API_URL,
    MACHINA_JUDGE_MODEL: process.env.MACHINA_JUDGE_MODEL,
    MACHINA_JUDGE_PROVIDER: process.env.MACHINA_JUDGE_PROVIDER,
    MACHINA_JUDGE_AUTH_PROVIDER: process.env.MACHINA_JUDGE_AUTH_PROVIDER,
    OPENCODE_AUTH_PATH: process.env.OPENCODE_AUTH_PATH,
  }
  process.env.MACHINA_JUDGE_API_URL = "https://judge.example.test/v1/chat/completions"
  process.env.MACHINA_JUDGE_MODEL = "gpt-judge"
  process.env.MACHINA_JUDGE_PROVIDER = "openai"
  process.env.MACHINA_JUDGE_AUTH_PROVIDER = "open-machina-judge"

  const dir = await mkdtemp(path.join(os.tmpdir(), "open-machina-auth-"))
  const authPath = path.join(dir, "auth.json")
  process.env.OPENCODE_AUTH_PATH = authPath
  await Bun.write(authPath, JSON.stringify({ "open-machina-judge": { type: "api", key: "token" } }, null, 2))

  let call = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    call += 1
    if (call === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "defer",
                  confidence: 0.88,
                  reason: "defer active work",
                  priority: "high",
                  deferUntil: "2099-01-01T00:00:00.000Z",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: "parallel",
                confidence: 0.9,
                reason: "run in background",
                priority: "medium",
                parallelPlan: {
                  lane: "background",
                  maxConcurrency: 2,
                },
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as unknown as typeof fetch

  try {
    const hooks = await OpenMachinaPlugin({
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [
                {
                  id: "openai",
                  models: {
                    "gpt-judge": {},
                  },
                },
              ],
            },
          }),
        },
        session: {},
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
      serverUrl: new URL("http://localhost:4096"),
    })

    if (!hooks["tool.execute.before"] || !hooks["chat.message"] || !hooks.tool?.open_machina_workspace) {
      throw new Error("required hooks missing")
    }

    await hooks["tool.execute.before"](
      { tool: "workflow.run", sessionID: "s-2", callID: "c-1" },
      { args: {} },
    )

    const deferOutput = {
      message: {},
      parts: [{ type: "text", text: "defer this task and do later" }],
    }
    await hooks["chat.message"]({ sessionID: "s-2", messageID: "m-1", agent: "atlas" }, deferOutput)
    expect(deferOutput.parts[0]?.text).toContain("action=defer")
    expect(deferOutput.parts[0]?.text).toContain("deferred=1")

    const parallelOutput = {
      message: {},
      parts: [{ type: "text", text: "also execute another branch in parallel" }],
    }
    await hooks["chat.message"]({ sessionID: "s-2", messageID: "m-2", agent: "atlas" }, parallelOutput)
    expect(parallelOutput.parts[0]?.text).toContain("action=parallel")
    expect(parallelOutput.parts[0]?.text).toContain("parallel=1")

    const workspaceRaw = await hooks.tool.open_machina_workspace.execute(
      {},
      {
        sessionID: "s-2",
        messageID: "m-3",
        agent: "atlas",
        directory: "/tmp/project",
        worktree: "/tmp/project",
      },
    )
    const workspace = JSON.parse(workspaceRaw) as {
      session: { deferred: Array<{ title: string }>; parallel: Array<{ title: string }> }
    }
    expect(workspace.session.deferred.length).toBe(1)
    expect(workspace.session.parallel.length).toBe(1)
    expect(workspace.session.deferred[0]?.title).toContain("until 2099-01-01T00:00:00.000Z")
  } finally {
    process.env.MACHINA_JUDGE_API_URL = originalEnv.MACHINA_JUDGE_API_URL
    process.env.MACHINA_JUDGE_MODEL = originalEnv.MACHINA_JUDGE_MODEL
    process.env.MACHINA_JUDGE_PROVIDER = originalEnv.MACHINA_JUDGE_PROVIDER
    process.env.MACHINA_JUDGE_AUTH_PROVIDER = originalEnv.MACHINA_JUDGE_AUTH_PROVIDER
    process.env.OPENCODE_AUTH_PATH = originalEnv.OPENCODE_AUTH_PATH
    globalThis.fetch = originalFetch
  }
})
