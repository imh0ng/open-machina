import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ChannelRegistry, ChannelRuntimeError } from "./channel"
import {
  createDefaultChannelConnectors,
  pullDiscordInboundEvents,
  pullSlackInboundEvents,
  pullTelegramInboundEvents,
  verifyConnectorConfig,
} from "./connectors"

function makeRegistry(storageDir: string): ChannelRegistry {
  const registry = new ChannelRegistry({ storageDir })
  for (const connector of createDefaultChannelConnectors()) {
    registry.register(connector)
  }
  return registry
}

test("matrix and discord connectors run connect -> status -> disconnect", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-lifecycle-"))

  try {
    const registry = makeRegistry(storageDir)

    const matrixConnected = await registry.connect({
      channelId: "ops-room",
      connectorId: "matrix",
      config: {
        homeserverUrl: "https://matrix.example.org",
        userId: "@machina:example.org",
        roomId: "!ops-room:example.org",
        accessToken: "matrix-token-12345",
      },
    })

    expect(matrixConnected.status).toBe("connected")
    expect(matrixConnected.connectorId).toBe("matrix")
    expect(matrixConnected.details?.accountId).toBe("@machina:example.org")

    const matrixStatus = await registry.status("ops-room")
    expect(matrixStatus.status).toBe("connected")
    expect(matrixStatus.connectorId).toBe("matrix")

    const matrixDisconnected = await registry.disconnect("ops-room")
    expect(matrixDisconnected.status).toBe("disconnected")
    expect(matrixDisconnected.connectorId).toBe("matrix")

    const discordConnected = await registry.connect({
      channelId: "alerts-room",
      connectorId: "discord",
      config: {
        guildId: "guild-42",
        channelId: "alerts",
        botToken: "discord-token-12345",
      },
    })

    expect(discordConnected.status).toBe("connected")
    expect(discordConnected.connectorId).toBe("discord")
    expect(discordConnected.details?.endpoint).toBe("discord://guild-42/alerts")

    const discordDisconnected = await registry.disconnect("alerts-room")
    expect(discordDisconnected.status).toBe("disconnected")
    expect(discordDisconnected.connectorId).toBe("discord")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("channel state restores after registry restart", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-restore-"))

  try {
    const first = makeRegistry(storageDir)
    await first.connect({
      channelId: "prod-ops",
      connectorId: "matrix",
      config: {
        homeserverUrl: "https://matrix.example.org",
        userId: "@restore:example.org",
        roomId: "!restore:example.org",
        accessToken: "matrix-restore-token",
      },
    })

    const second = makeRegistry(storageDir)
    const restored = await second.status("prod-ops")

    expect(restored.status).toBe("connected")
    expect(restored.connectorId).toBe("matrix")
    expect(restored.details?.accountId).toBe("@restore:example.org")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("invalid credentials fail deterministically without secret echo", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-invalid-"))
  const leakedSecret = "invalid-super-secret-token"

  try {
    const registry = makeRegistry(storageDir)

    let errorCode = ""
    let errorMessage = ""
    try {
      await registry.connect({
        channelId: "security-room",
        connectorId: "discord",
        config: {
          guildId: "guild-sec",
          channelId: "security",
          botToken: leakedSecret,
        },
      })
    } catch (error) {
      const normalized = error as ChannelRuntimeError
      errorCode = normalized.code
      errorMessage = normalized.message
    }

    expect(errorCode).toBe("INVALID_CREDENTIALS")
    expect(errorMessage).toContain("Authentication failed for discord")
    expect(errorMessage.includes(leakedSecret)).toBe(false)

    const status = await registry.status("security-room")
    expect(status.status).toBe("disconnected")
    expect(status.error?.code).toBe("INVALID_CREDENTIALS")
    expect((status.error?.message ?? "").includes(leakedSecret)).toBe(false)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("disconnect is idempotent and does not mutate disconnected state", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-idempotent-disconnect-"))

  try {
    const registry = makeRegistry(storageDir)

    await registry.connect({
      channelId: "idempotent-room",
      connectorId: "matrix",
      config: {
        homeserverUrl: "https://matrix.example.org",
        userId: "@idempotent:example.org",
        roomId: "!idempotent:example.org",
        accessToken: "matrix-token-idempotent",
      },
    })

    const first = await registry.disconnect("idempotent-room")
    const second = await registry.disconnect("idempotent-room")

    expect(first.status).toBe("disconnected")
    expect(second.status).toBe("disconnected")
    expect(second.connectorId).toBe("matrix")
    expect(second.updatedAt).toBe(first.updatedAt)
    expect(second.error).toBeNull()
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("upstream connector errors are sanitized before throw and persisted status", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-redaction-"))
  const leakedSecret = "secret=super-secret-token-1234567890"

  try {
    const registry = new ChannelRegistry({ storageDir })
    registry.register({
      id: "failing-upstream",
      validateConfig: () => ({ ok: true, config: {} }),
      connect: async () => {
        throw new Error(`upstream auth failed: ${leakedSecret}`)
      },
      disconnect: async () => ({ status: "disconnected" }),
    })

    let errorCode = ""
    let errorMessage = ""
    try {
      await registry.connect({
        channelId: "upstream-room",
        connectorId: "failing-upstream",
        config: {},
      })
    } catch (error) {
      const normalized = error as ChannelRuntimeError
      errorCode = normalized.code
      errorMessage = normalized.message
    }

    expect(errorCode).toBe("CHANNEL_CONNECT_FAILED")
    expect(errorMessage.includes(leakedSecret)).toBe(false)
    expect(errorMessage.includes("[REDACTED]")).toBe(true)

    const status = await registry.status("upstream-room")
    expect(status.status).toBe("disconnected")
    expect(status.error?.code).toBe("CHANNEL_CONNECT_FAILED")
    expect((status.error?.message ?? "").includes(leakedSecret)).toBe(false)
    expect((status.error?.message ?? "").includes("[REDACTED]")).toBe(true)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("config validation failure returns deterministic validation code", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-config-"))

  try {
    const registry = makeRegistry(storageDir)

    let errorCode = ""
    let errorMessage = ""
    try {
      await registry.connect({
        channelId: "bad-config-room",
        connectorId: "matrix",
        config: {
          homeserverUrl: "https://matrix.example.org",
          userId: "",
          roomId: "",
          accessToken: "matrix-token-12345",
        },
      })
    } catch (error) {
      const normalized = error as ChannelRuntimeError
      errorCode = normalized.code
      errorMessage = normalized.message
    }

    expect(errorCode).toBe("CONFIG_VALIDATION_ERROR")
    expect(errorMessage).toContain("missing userId")
    expect(errorMessage).toContain("missing roomId")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("verifyConnectorConfig returns skipped when live probe disabled", async () => {
  const result = await verifyConnectorConfig(
    "telegram",
    {
      accountId: "ops-bot",
      endpoint: "telegram://ops",
      accessToken: "telegram-token-12345",
    },
    { live: false },
  )

  expect(result.connectorId).toBe("telegram")
  expect(result.status).toBe("skipped")
  expect(result.message).toContain("Live verification disabled")
})

test("verifyConnectorConfig runs telegram live probe when enabled", async () => {
  const originalFetch = globalThis.fetch
  const fetchMock = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        result: {
          id: 777,
          username: "machina_bot",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as unknown as typeof fetch
  globalThis.fetch = fetchMock

  try {
    const result = await verifyConnectorConfig(
      "telegram",
      {
        accountId: "ops-bot",
        endpoint: "telegram://ops",
        accessToken: "telegram-token-12345",
      },
      { live: true },
    )

    expect(result.connectorId).toBe("telegram")
    expect(result.status).toBe("verified")
    expect(result.message).toContain("verification passed")
    expect(result.details?.username).toBe("machina_bot")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("saved account profiles persist and can reconnect channel by account id", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-channel-accounts-"))

  try {
    const first = makeRegistry(storageDir)
    const saved = await first.saveAccount({
      accountId: "ops-discord",
      connectorId: "discord",
      config: {
        guildId: "guild-ops",
        channelId: "alerts",
        botToken: "discord-token-12345",
      },
    })

    expect(saved.accountId).toBe("ops-discord")
    expect(saved.connectorId).toBe("discord")

    const second = makeRegistry(storageDir)
    const listed = await second.listAccounts()
    expect(listed.map((item) => item.accountId)).toContain("ops-discord")

    const connected = await second.connectAccount({
      channelId: "ops-room",
      accountId: "ops-discord",
    })
    expect(connected.status).toBe("connected")
    expect(connected.connectorId).toBe("discord")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("pullDiscordInboundEvents returns skipped when live mode disabled", async () => {
  const result = await pullDiscordInboundEvents(
    {
      guildId: "guild-1",
      channelId: "chan-1",
      botToken: "discord-token-12345",
    },
    { live: false },
  )

  expect(result.status).toBe("skipped")
  expect(result.events.length).toBe(0)
})

test("pullDiscordInboundEvents parses inbound message payload", async () => {
  const originalFetch = globalThis.fetch
  const fetchMock = (async () =>
    new Response(
      JSON.stringify([
        {
          id: "m2",
          content: "second",
          timestamp: "2026-02-11T00:00:02.000Z",
          author: { id: "u2", username: "neo" },
        },
        {
          id: "m1",
          content: "first",
          timestamp: "2026-02-11T00:00:01.000Z",
          author: { id: "u1", username: "trinity" },
        },
      ]),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as unknown as typeof fetch
  globalThis.fetch = fetchMock

  try {
    const result = await pullDiscordInboundEvents(
      {
        guildId: "guild-1",
        channelId: "chan-1",
        botToken: "discord-token-12345",
      },
      { live: true, limit: 2 },
    )

    expect(result.status).toBe("received")
    expect(result.events.length).toBe(2)
    expect(result.events[0]?.id).toBe("m2")
    expect(result.nextCursor).toBe("m2")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("pullTelegramInboundEvents parses update payload", async () => {
  const originalFetch = globalThis.fetch
  const fetchMock = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        result: [
          {
            update_id: 10,
            message: {
              date: 1739232000,
              text: "hello",
              chat: { id: 111 },
              from: { id: 222 },
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as unknown as typeof fetch
  globalThis.fetch = fetchMock

  try {
    const result = await pullTelegramInboundEvents(
      {
        accountId: "ops",
        endpoint: "telegram://ops",
        accessToken: "telegram-token-12345",
      },
      { live: true, limit: 1, offset: 10 },
    )

    expect(result.status).toBe("received")
    expect(result.events.length).toBe(1)
    expect(result.events[0]?.updateId).toBe(10)
    expect(result.nextCursor).toBe(11)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("pullSlackInboundEvents parses history payload", async () => {
  const originalFetch = globalThis.fetch
  const fetchMock = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        messages: [
          {
            ts: "1739232000.000100",
            text: "deploy done",
            user: "U123",
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as unknown as typeof fetch
  globalThis.fetch = fetchMock

  try {
    const result = await pullSlackInboundEvents(
      {
        accountId: "ops",
        endpoint: "slack://COPS",
        accessToken: "slack-token-12345",
      },
      { live: true, limit: 1 },
    )

    expect(result.status).toBe("received")
    expect(result.events.length).toBe(1)
    expect(result.events[0]?.channel).toBe("COPS")
    expect(result.nextCursor).toBe("1739232000.000100")
  } finally {
    globalThis.fetch = originalFetch
  }
})
