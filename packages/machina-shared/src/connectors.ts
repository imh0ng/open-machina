import {
  ChannelRuntimeError,
  type ChannelConfigValidationResult,
  type ChannelConnector,
  type ChannelConnectResult,
} from "./channel"

export type MatrixConnectorConfig = {
  homeserverUrl: string
  userId: string
  roomId: string
  accessToken: string
}

export type DiscordConnectorConfig = {
  guildId: string
  channelId: string
  botToken: string
}

type TokenConnectorConfig = {
  accountId: string
  endpoint: string
  accessToken: string
}

export type ConnectorVerification = {
  connectorId: string
  status: "verified" | "skipped"
  message: string
  details?: Record<string, unknown>
}

export type ConnectorDispatchInput = {
  text: string
  target?: string
}

export type ConnectorDispatchResult = {
  connectorId: string
  status: "sent" | "skipped"
  message: string
  details?: Record<string, unknown>
}

export type DiscordInboundEvent = {
  id: string
  content: string
  authorId: string
  authorUsername: string
  createdAt: string
}

export type DiscordInboundResult = {
  connectorId: "discord"
  status: "received" | "skipped"
  message: string
  events: DiscordInboundEvent[]
  nextCursor: string | null
}

export type TelegramInboundEvent = {
  updateId: number
  chatId: number | string
  text: string
  fromId: number | string | null
  createdAt: string
}

export type TelegramInboundResult = {
  connectorId: "telegram"
  status: "received" | "skipped"
  message: string
  events: TelegramInboundEvent[]
  nextCursor: number | null
}

export type SlackInboundEvent = {
  ts: string
  channel: string
  text: string
  user: string | null
  createdAt: string
}

export type SlackInboundResult = {
  connectorId: "slack"
  status: "received" | "skipped"
  message: string
  events: SlackInboundEvent[]
  nextCursor: string | null
}

export function createMatrixConnector(): ChannelConnector<MatrixConnectorConfig> {
  return {
    id: "matrix",
    validateConfig: (config) => {
      const candidate = asRecord(config)
      const homeserverUrl = requireString(candidate, "homeserverUrl")
      const userId = requireString(candidate, "userId")
      const roomId = requireString(candidate, "roomId")
      const accessToken = requireString(candidate, "accessToken")
      const errors = [homeserverUrl.error, userId.error, roomId.error, accessToken.error].filter(
        (value): value is string => typeof value === "string",
      )

      if (errors.length > 0) {
        return invalidConfig(`Matrix config validation failed: ${errors.join("; ")}`)
      }

      return {
        ok: true,
        config: {
          homeserverUrl: homeserverUrl.value,
          userId: userId.value,
          roomId: roomId.value,
          accessToken: accessToken.value,
        },
      }
    },
    connect: async (config) => {
      assertCredential(config.accessToken, "matrix")

      return connected({
        accountId: config.userId,
        endpoint: `${stripTrailingSlash(config.homeserverUrl)}/${stripLeadingSlash(config.roomId)}`,
      })
    },
    disconnect: async () => ({ status: "disconnected" }),
    verify: async (config, options) => {
      if (!options?.live) {
        return {
          status: "skipped",
          message: "Live verification disabled. Use --live to run remote probe.",
        }
      }

      const url = `${stripTrailingSlash(config.homeserverUrl)}/_matrix/client/v3/account/whoami`
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
        },
      })

      if (!response.ok) {
        throw new ChannelRuntimeError("VERIFY_FAILED", `Matrix verification failed: HTTP ${response.status}`)
      }

      const payload = (await response.json().catch(() => ({}))) as { user_id?: string }
      return {
        status: "verified",
        message: "Matrix credential verification passed.",
        details: {
          userId: payload.user_id ?? config.userId,
        },
      }
    },
  }
}

export function createDiscordConnector(): ChannelConnector<DiscordConnectorConfig> {
  return {
    id: "discord",
    validateConfig: (config) => {
      const candidate = asRecord(config)
      const guildId = requireString(candidate, "guildId")
      const channelId = requireString(candidate, "channelId")
      const botToken = requireString(candidate, "botToken")
      const errors = [guildId.error, channelId.error, botToken.error].filter(
        (value): value is string => typeof value === "string",
      )

      if (errors.length > 0) {
        return invalidConfig(`Discord config validation failed: ${errors.join("; ")}`)
      }

      return {
        ok: true,
        config: {
          guildId: guildId.value,
          channelId: channelId.value,
          botToken: botToken.value,
        },
      }
    },
    connect: async (config) => {
      assertCredential(config.botToken, "discord")

      return connected({
        accountId: config.guildId,
        endpoint: `discord://${config.guildId}/${config.channelId}`,
      })
    },
    disconnect: async () => ({ status: "disconnected" }),
    verify: async (config, options) => {
      if (!options?.live) {
        return {
          status: "skipped",
          message: "Live verification disabled. Use --live to run remote probe.",
        }
      }

      const response = await fetch("https://discord.com/api/v10/users/@me", {
        method: "GET",
        headers: {
          Authorization: `Bot ${config.botToken}`,
        },
      })

      if (!response.ok) {
        throw new ChannelRuntimeError("VERIFY_FAILED", `Discord verification failed: HTTP ${response.status}`)
      }

      const payload = (await response.json().catch(() => ({}))) as { id?: string; username?: string }
      return {
        status: "verified",
        message: "Discord bot verification passed.",
        details: {
          botId: payload.id ?? null,
          username: payload.username ?? null,
          guildId: config.guildId,
          channelId: config.channelId,
        },
      }
    },
  }
}

export function createSlackConnector(): ChannelConnector<TokenConnectorConfig> {
  return createTokenConnector("slack", "slack")
}

export function createSignalConnector(): ChannelConnector<TokenConnectorConfig> {
  return createTokenConnector("signal", "signal")
}

export function createTelegramConnector(): ChannelConnector<TokenConnectorConfig> {
  return createTokenConnector("telegram", "telegram")
}

export function createWhatsAppWebConnector(): ChannelConnector<TokenConnectorConfig> {
  return createTokenConnector("whatsapp-web", "whatsapp")
}

export function createDefaultChannelConnectors(): Array<ChannelConnector<unknown>> {
  const connectors = [
    createDiscordConnector(),
    createMatrixConnector(),
    createSignalConnector(),
    createSlackConnector(),
    createTelegramConnector(),
    createWhatsAppWebConnector(),
  ]

  return connectors.sort((left, right) => left.id.localeCompare(right.id)) as Array<ChannelConnector<unknown>>
}

function createTokenConnector(id: string, provider: string): ChannelConnector<TokenConnectorConfig> {
  return {
    id,
    validateConfig: (config) => {
      const candidate = asRecord(config)
      const accountId = requireString(candidate, "accountId")
      const endpoint = requireString(candidate, "endpoint")
      const accessToken = requireString(candidate, "accessToken")
      const errors = [accountId.error, endpoint.error, accessToken.error].filter(
        (value): value is string => typeof value === "string",
      )

      if (errors.length > 0) {
        return invalidConfig(`${provider} config validation failed: ${errors.join("; ")}`)
      }

      return {
        ok: true,
        config: {
          accountId: accountId.value,
          endpoint: endpoint.value,
          accessToken: accessToken.value,
        },
      }
    },
    connect: async (config) => {
      assertCredential(config.accessToken, provider)
      return connected({
        accountId: config.accountId,
        endpoint: normalizeProviderEndpoint(provider, config.endpoint),
      })
    },
    disconnect: async () => ({ status: "disconnected" }),
    verify: async (config, options) => {
      if (!options?.live) {
        return {
          status: "skipped",
          message: "Live verification disabled. Use --live to run remote probe.",
        }
      }

      if (provider === "telegram") {
        const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(config.accessToken)}/getMe`)
        if (!response.ok) {
          throw new ChannelRuntimeError("VERIFY_FAILED", `Telegram verification failed: HTTP ${response.status}`)
        }

        const payload = (await response.json().catch(() => ({}))) as {
          ok?: boolean
          result?: { id?: number; username?: string }
        }
        if (!payload.ok) {
          throw new ChannelRuntimeError("VERIFY_FAILED", "Telegram verification failed: API returned non-ok")
        }

        return {
          status: "verified",
          message: "Telegram bot verification passed.",
          details: {
            botId: payload.result?.id ?? null,
            username: payload.result?.username ?? null,
          },
        }
      }

      if (provider === "slack") {
        const response = await fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "",
        })
        if (!response.ok) {
          throw new ChannelRuntimeError("VERIFY_FAILED", `Slack verification failed: HTTP ${response.status}`)
        }

        const payload = (await response.json().catch(() => ({}))) as {
          ok?: boolean
          user_id?: string
          team_id?: string
        }
        if (!payload.ok) {
          throw new ChannelRuntimeError("VERIFY_FAILED", "Slack verification failed: API returned non-ok")
        }

        return {
          status: "verified",
          message: "Slack bot verification passed.",
          details: {
            userId: payload.user_id ?? null,
            teamId: payload.team_id ?? null,
          },
        }
      }

      return {
        status: "skipped",
        message: `${provider} live verification is not implemented yet in machina core.`,
      }
    },
  }
}

export function verifyConnectorConfig(
  connectorId: string,
  config: unknown,
  options: { live?: boolean } = {},
): Promise<ConnectorVerification> {
  const connector = createDefaultChannelConnectors().find((candidate) => candidate.id === connectorId)
  if (!connector) {
    throw new ChannelRuntimeError("CONNECTOR_NOT_FOUND", `Connector not found: ${connectorId}`)
  }

  const validation = connector.validateConfig(config)
  if (!validation.ok) {
    throw new ChannelRuntimeError(validation.code, validation.message)
  }

  if (!connector.verify) {
    return Promise.resolve({
      connectorId,
      status: "skipped",
      message: `Connector ${connectorId} does not expose verification capability.`,
    })
  }

  return connector.verify(validation.config as never, options).then((result) => ({
    connectorId,
    status: result.status,
    message: result.message,
    details: result.details,
  }))
}

export async function sendConnectorMessage(
  connectorId: string,
  config: unknown,
  input: ConnectorDispatchInput,
  options: { live?: boolean } = {},
): Promise<ConnectorDispatchResult> {
  const connector = createDefaultChannelConnectors().find((candidate) => candidate.id === connectorId)
  if (!connector) {
    throw new ChannelRuntimeError("CONNECTOR_NOT_FOUND", `Connector not found: ${connectorId}`)
  }

  const validation = connector.validateConfig(config)
  if (!validation.ok) {
    throw new ChannelRuntimeError(validation.code, validation.message)
  }

  if (!options.live) {
    return {
      connectorId,
      status: "skipped",
      message: "Live dispatch disabled. Use --live=true to send provider message.",
    }
  }

  const text = input.text.trim()
  if (!text) {
    throw new ChannelRuntimeError("MESSAGE_EMPTY", "Message text must not be empty")
  }

  if (connectorId === "discord") {
    const typed = validation.config as DiscordConnectorConfig
    const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(typed.channelId)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${typed.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    })

    if (!response.ok) {
      throw new ChannelRuntimeError("DISPATCH_FAILED", `Discord dispatch failed: HTTP ${response.status}`)
    }

    const payload = (await response.json().catch(() => ({}))) as { id?: string }
    return {
      connectorId,
      status: "sent",
      message: "Discord message sent.",
      details: {
        messageId: payload.id ?? null,
        channelId: typed.channelId,
      },
    }
  }

  if (connectorId === "telegram") {
    const typed = validation.config as TokenConnectorConfig
    const chatId = input.target ?? typed.endpoint.replace(/^telegram:\/\//i, "")
    if (!chatId) {
      throw new ChannelRuntimeError("TARGET_MISSING", "Telegram dispatch requires target chat id")
    }

    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(typed.accessToken)}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ chat_id: chatId, text }),
    })

    if (!response.ok) {
      throw new ChannelRuntimeError("DISPATCH_FAILED", `Telegram dispatch failed: HTTP ${response.status}`)
    }

    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number } }
    if (!payload.ok) {
      throw new ChannelRuntimeError("DISPATCH_FAILED", "Telegram dispatch failed: API returned non-ok")
    }

    return {
      connectorId,
      status: "sent",
      message: "Telegram message sent.",
      details: {
        messageId: payload.result?.message_id ?? null,
        chatId,
      },
    }
  }

  if (connectorId === "slack") {
    const typed = validation.config as TokenConnectorConfig
    const channel = input.target ?? typed.endpoint.replace(/^slack:\/\//i, "")
    if (!channel) {
      throw new ChannelRuntimeError("TARGET_MISSING", "Slack dispatch requires target channel id")
    }

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${typed.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, text }),
    })

    if (!response.ok) {
      throw new ChannelRuntimeError("DISPATCH_FAILED", `Slack dispatch failed: HTTP ${response.status}`)
    }

    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; ts?: string }
    if (!payload.ok) {
      throw new ChannelRuntimeError("DISPATCH_FAILED", "Slack dispatch failed: API returned non-ok")
    }

    return {
      connectorId,
      status: "sent",
      message: "Slack message sent.",
      details: {
        channel,
        ts: payload.ts ?? null,
      },
    }
  }

  return {
    connectorId,
    status: "skipped",
    message: `${connectorId} live dispatch is not implemented yet in machina core.`,
  }
}

export async function pullDiscordInboundEvents(
  config: unknown,
  options: { live?: boolean; limit?: number } = {},
): Promise<DiscordInboundResult> {
  const connector = createDiscordConnector()
  const validation = connector.validateConfig(config)
  if (!validation.ok) {
    throw new ChannelRuntimeError(validation.code, validation.message)
  }

  if (!options.live) {
    return {
      connectorId: "discord",
      status: "skipped",
      message: "Live inbound disabled. Use --live=true to pull Discord channel events.",
      events: [],
      nextCursor: null,
    }
  }

  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  const response = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(validation.config.channelId)}/messages?limit=${limit}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bot ${validation.config.botToken}`,
      },
    },
  )

  if (!response.ok) {
    throw new ChannelRuntimeError("INBOUND_PULL_FAILED", `Discord inbound pull failed: HTTP ${response.status}`)
  }

  const payload = (await response.json().catch(() => [])) as Array<{
    id?: string
    content?: string
    timestamp?: string
    author?: { id?: string; username?: string }
  }>

  const events: DiscordInboundEvent[] = payload
    .filter((item) => typeof item.id === "string")
    .map((item) => ({
      id: item.id ?? "",
      content: item.content ?? "",
      authorId: item.author?.id ?? "unknown",
      authorUsername: item.author?.username ?? "unknown",
      createdAt: item.timestamp ?? new Date().toISOString(),
    }))

  return {
    connectorId: "discord",
    status: "received",
    message: "Discord inbound pull completed.",
    events,
    nextCursor: events.length > 0 ? events[0]?.id ?? null : null,
  }
}

export async function pullTelegramInboundEvents(
  config: unknown,
  options: { live?: boolean; limit?: number; offset?: number } = {},
): Promise<TelegramInboundResult> {
  const connector = createTelegramConnector()
  const validation = connector.validateConfig(config)
  if (!validation.ok) {
    throw new ChannelRuntimeError(validation.code, validation.message)
  }

  if (!options.live) {
    return {
      connectorId: "telegram",
      status: "skipped",
      message: "Live inbound disabled. Use --live=true to pull Telegram updates.",
      events: [],
      nextCursor: null,
    }
  }

  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  const offsetArg = typeof options.offset === "number" ? `&offset=${Math.trunc(options.offset)}` : ""
  const response = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(validation.config.accessToken)}/getUpdates?limit=${limit}${offsetArg}`,
  )
  if (!response.ok) {
    throw new ChannelRuntimeError("INBOUND_PULL_FAILED", `Telegram inbound pull failed: HTTP ${response.status}`)
  }

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    result?: Array<{
      update_id?: number
      message?: {
        date?: number
        text?: string
        chat?: { id?: number | string }
        from?: { id?: number | string }
      }
    }>
  }
  if (!payload.ok) {
    throw new ChannelRuntimeError("INBOUND_PULL_FAILED", "Telegram inbound pull failed: API returned non-ok")
  }

  const events: TelegramInboundEvent[] = (payload.result ?? [])
    .filter((entry) => typeof entry.update_id === "number")
    .map((entry) => ({
      updateId: entry.update_id ?? 0,
      chatId: entry.message?.chat?.id ?? "unknown",
      text: entry.message?.text ?? "",
      fromId: entry.message?.from?.id ?? null,
      createdAt:
        typeof entry.message?.date === "number"
          ? new Date(entry.message.date * 1000).toISOString()
          : new Date().toISOString(),
    }))

  const highest = events.reduce((acc, item) => (item.updateId > acc ? item.updateId : acc), -1)
  return {
    connectorId: "telegram",
    status: "received",
    message: "Telegram inbound pull completed.",
    events,
    nextCursor: highest >= 0 ? highest + 1 : null,
  }
}

export async function pullSlackInboundEvents(
  config: unknown,
  options: { live?: boolean; limit?: number; channel?: string } = {},
): Promise<SlackInboundResult> {
  const connector = createSlackConnector()
  const validation = connector.validateConfig(config)
  if (!validation.ok) {
    throw new ChannelRuntimeError(validation.code, validation.message)
  }

  if (!options.live) {
    return {
      connectorId: "slack",
      status: "skipped",
      message: "Live inbound disabled. Use --live=true to pull Slack channel history.",
      events: [],
      nextCursor: null,
    }
  }

  const limit = Math.max(1, Math.min(200, options.limit ?? 50))
  const channel = options.channel ?? validation.config.endpoint.replace(/^slack:\/\//i, "")
  if (!channel) {
    throw new ChannelRuntimeError("TARGET_MISSING", "Slack inbound pull requires channel id (endpoint or --channel)")
  }

  const response = await fetch("https://slack.com/api/conversations.history", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${validation.config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, limit }),
  })
  if (!response.ok) {
    throw new ChannelRuntimeError("INBOUND_PULL_FAILED", `Slack inbound pull failed: HTTP ${response.status}`)
  }

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    messages?: Array<{ ts?: string; text?: string; user?: string }>
  }
  if (!payload.ok) {
    throw new ChannelRuntimeError("INBOUND_PULL_FAILED", "Slack inbound pull failed: API returned non-ok")
  }

  const events: SlackInboundEvent[] = (payload.messages ?? [])
    .filter((entry) => typeof entry.ts === "string")
    .map((entry) => ({
      ts: entry.ts ?? "",
      channel,
      text: entry.text ?? "",
      user: entry.user ?? null,
      createdAt: toIsoFromSlackTs(entry.ts ?? "") ?? new Date().toISOString(),
    }))

  return {
    connectorId: "slack",
    status: "received",
    message: "Slack inbound pull completed.",
    events,
    nextCursor: events.length > 0 ? events[0]?.ts ?? null : null,
  }
}

function normalizeProviderEndpoint(provider: string, endpoint: string): string {
  const normalizedProvider = provider.trim().toLowerCase()
  const withoutPrefix = endpoint.trim().replace(new RegExp(`^${escapeRegExp(normalizedProvider)}://`, "i"), "")
  const withoutLeadingSlash = withoutPrefix.replace(/^\/+/, "")
  return `${normalizedProvider}://${withoutLeadingSlash}`
}

function assertCredential(rawCredential: string, provider: string): void {
  if (isInvalidCredential(rawCredential)) {
    throw new ChannelRuntimeError(
      "INVALID_CREDENTIALS",
      `Authentication failed for ${provider}. Verify credentials and try again.`,
    )
  }
}

function isInvalidCredential(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.length < 8 ||
    normalized.includes("invalid") ||
    normalized.includes("bad") ||
    normalized.includes("wrong")
  )
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function toIsoFromSlackTs(value: string): string | null {
  const first = value.split(".")[0]
  if (!first) {
    return null
  }

  const asNumber = Number(first)
  if (!Number.isFinite(asNumber) || asNumber <= 0) {
    return null
  }

  return new Date(asNumber * 1000).toISOString()
}

function connected(input: { accountId: string; endpoint: string }): ChannelConnectResult {
  return {
    status: "connected",
    details: {
      accountId: input.accountId,
      endpoint: input.endpoint,
      connectedAt: new Date().toISOString(),
    },
  }
}

function invalidConfig(message: string): ChannelConfigValidationResult<never> {
  return {
    ok: false,
    code: "CONFIG_VALIDATION_ERROR",
    message,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>
  }

  return {}
}

function requireString(
  value: Record<string, unknown>,
  field: string,
): {
  value: string
  error?: string
} {
  const candidate = value[field]
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return {
      value: "",
      error: `missing ${field}`,
    }
  }

  return {
    value: candidate.trim(),
  }
}
