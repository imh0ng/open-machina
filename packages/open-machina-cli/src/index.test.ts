import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { banner, runCli } from "./index"

type WorkflowLog = {
  operationId: string
  workflowName: string
  status: string
  startedAt: string
  finishedAt: string
}

test("banner() includes identity markers", () => {
  const b = banner()
  expect(b).toContain("open-machina")
  expect(b).toContain("🤖")
  expect(b).toContain("\x1b[38;2;0;255;157m")
})

test("runCli --version prints marker, version, and identity", async () => {
  const out = await runCli(["--version"])

  expect(out.code).toBe(0)
  expect(out.stdout).toContain("[OPEN-MACHINA] open-machina ")
  expect(out.stdout).toContain("🤖")
  expect(out.stdout).toContain("\x1b[38;2;0;255;157m")
})

test("runCli install prints npm and bunx usage", async () => {
  const out = await runCli(["install"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    command: string
    usage: { npmGlobal: string; bunx: string; run: string }
    opencode: { recommended: string[]; npmPublishedAlternative: string[] }
  }

  expect(payload.command).toBe("open-machina install")
  expect(payload.usage.npmGlobal).toBe("npm install -g open-machina")
  expect(payload.usage.bunx).toBe("bunx open-machina --help")
  expect(payload.usage.run).toBe("open-machina --help")
  expect(payload.opencode.recommended[0]).toBe("oh-my-opencode")
  expect(payload.opencode.npmPublishedAlternative).toEqual(["oh-my-opencode", "open-machina-plugin"])
})

test("runCli workflow list exposes at least five concrete workflows", async () => {
  const out = await runCli(["workflow", "list"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as { workflows: string[] }
  expect(payload.workflows).toContain("status")
  expect(payload.workflows).toContain("doctor")
  expect(payload.workflows).toContain("storage.migrate")
  expect(payload.workflows).toContain("storage.integrity")
  expect(payload.workflows).toContain("storage.compact")
  expect(payload.workflows.length).toBeGreaterThanOrEqual(5)
})

test("runCli status workflow includes structured operation log", async () => {
  const out = await runCli(["status"], { MACHINA_PLUGIN_MODE: "local" })
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    status: string
    result: { runtime: string; pluginStatus: string }
    log: WorkflowLog
  }

  expect(payload.status).toBe("completed")
  expect(payload.result.runtime).toBe("open-machina")
  expect(payload.log.workflowName).toBe("status")
  expect(payload.log.status).toBe("completed")
  expect(payload.log.operationId.startsWith("op-status-")).toBe(true)
  expect(Date.parse(payload.log.startedAt)).toBeGreaterThan(0)
  expect(Date.parse(payload.log.finishedAt)).toBeGreaterThan(0)
})

test("runCli doctor --json reports loaded in local mode with log", async () => {
  const out = await runCli(["doctor", "--json"], { MACHINA_PLUGIN_MODE: "local" })

  expect(out.code).toBe(0)
  const payload = JSON.parse(out.stdout) as {
    status: string
    result: { runtime: string; plugin: { status: string } }
    log: WorkflowLog
  }

  expect(payload.status).toBe("completed")
  expect(payload.result.runtime).toBe("open-machina")
  expect(payload.result.plugin.status).toBe("loaded")
  expect(payload.log.workflowName).toBe("doctor")
})

test("runCli doctor --json fails with deterministic error on invalid config", async () => {
  const out = await runCli(["doctor", "--json"], { MACHINA_PLUGIN_MODE: "invalid" })

  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    status: string
    result: { plugin: { status: string; code: string; hint: string } }
    log: WorkflowLog
  }

  expect(payload.status).toBe("completed")
  expect(payload.result.plugin.status).toBe("error")
  expect(payload.result.plugin.code).toBe("INVALID_MODE")
  expect(payload.result.plugin.hint.includes("local, dev, or prod")).toBe(true)
  expect(payload.log.operationId.startsWith("op-doctor-")).toBe(true)
})

test("onboard writes deterministic config scaffold when requested", async () => {
  const temp = await mkdtemp(join(tmpdir(), "machina-onboard-"))
  const configPath = join(temp, "config", "machina.json")

  try {
    const out = await runCli(["onboard", `--write-config=${configPath}`])
    expect(out.code).toBe(0)

    const payload = JSON.parse(out.stdout) as {
      mode: string
      wroteConfig: boolean
      configPath: string | null
      connectors: string[]
    }
    expect(payload.mode).toBe("guided")
    expect(payload.wroteConfig).toBe(true)
    expect(payload.configPath).toBe(configPath)
    expect(payload.connectors).toContain("discord")
    expect(payload.connectors).toContain("telegram")

    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      channels: Record<string, { enabled: boolean }>
    }
    expect(saved.channels.discord?.enabled).toBe(false)
    expect(saved.channels.matrix?.enabled).toBe(false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test("setup aliases onboard helper", async () => {
  const out = await runCli(["setup"])
  expect(out.code).toBe(0)
  const payload = JSON.parse(out.stdout) as { mode: string; steps: string[] }
  expect(payload.mode).toBe("guided")
  expect(payload.steps.length).toBeGreaterThanOrEqual(5)
})

test("five core workflows run end-to-end through CLI with operation logs", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-cli-workflow-"))

  try {
    const commands: Array<[string[], string]> = [
      [["status"], "status"],
      [["doctor", "--json"], "doctor"],
      [["storage", "migrate", `--storage-dir=${storageDir}`], "storage.migrate"],
      [["storage", "integrity", `--storage-dir=${storageDir}`], "storage.integrity"],
      [["storage", "compact", `--storage-dir=${storageDir}`], "storage.compact"],
    ]

    for (const [argv, workflowName] of commands) {
      const out = await runCli(argv, { MACHINA_PLUGIN_MODE: "local" })
      expect(out.code).toBe(0)

      const payload = JSON.parse(out.stdout) as { status: string; log: WorkflowLog }
      expect(payload.status).toBe("completed")
      expect(payload.log.workflowName).toBe(workflowName)
      expect(payload.log.status).toBe("completed")
      expect(payload.log.operationId.length).toBeGreaterThan(0)
    }
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("runCli workflow cancel-smoke cancels and leaves no orphan process", async () => {
  const out = await runCli(["workflow", "cancel-smoke", "--cancel-after-ms=100"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    scenario: string
    noOrphan: boolean
    tracker: { childPid: number | null; aliveAfterCleanup: boolean | null }
    status: string
    log: WorkflowLog
  }

  expect(payload.scenario).toBe("workflow.cancel-smoke")
  expect(payload.status).toBe("cancelled")
  expect(payload.noOrphan).toBe(true)
  expect(payload.tracker.childPid).not.toBeNull()
  expect(payload.tracker.aliveAfterCleanup).toBe(false)
  expect(payload.log.workflowName).toBe("long-running")
  expect(payload.log.status).toBe("cancelled")
  expect(payload.log.operationId.startsWith("op-long-running-")).toBe(true)
})

test("channel connectors command lists matrix and discord", async () => {
  const out = await runCli(["channel", "connectors"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as { connectors: string[] }
  expect(payload.connectors).toContain("matrix")
  expect(payload.connectors).toContain("discord")
})

test("channel connect -> status -> disconnect lifecycle works with persisted status", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-cli-channel-lifecycle-"))

  try {
    const connectOut = await runCli([
      "channel",
      "connect",
      "ops-room",
      "matrix",
      `--storage-dir=${storageDir}`,
      '--config-json={"homeserverUrl":"https://matrix.example.org","userId":"@machina:example.org","roomId":"!ops:example.org","accessToken":"matrix-token-12345"}',
    ])
    expect(connectOut.code).toBe(0)

    const connectPayload = JSON.parse(connectOut.stdout) as {
      status: string
      connectorId: string
      details: { accountId: string }
    }
    expect(connectPayload.status).toBe("connected")
    expect(connectPayload.connectorId).toBe("matrix")
    expect(connectPayload.details.accountId).toBe("@machina:example.org")

    const statusAfterRestart = await runCli(["channel", "status", "ops-room", `--storage-dir=${storageDir}`])
    expect(statusAfterRestart.code).toBe(0)

    const statusPayload = JSON.parse(statusAfterRestart.stdout) as {
      status: string
      connectorId: string
      details: { accountId: string }
    }
    expect(statusPayload.status).toBe("connected")
    expect(statusPayload.connectorId).toBe("matrix")
    expect(statusPayload.details.accountId).toBe("@machina:example.org")

    const disconnectOut = await runCli(["channel", "disconnect", "ops-room", `--storage-dir=${storageDir}`])
    expect(disconnectOut.code).toBe(0)

    const disconnectPayload = JSON.parse(disconnectOut.stdout) as { status: string; connectorId: string }
    expect(disconnectPayload.status).toBe("disconnected")
    expect(disconnectPayload.connectorId).toBe("matrix")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("channel connect invalid credentials returns deterministic non-secret error", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-cli-channel-invalid-"))
  const invalidToken = "invalid-super-secret-token"

  try {
    const out = await runCli([
      "channel",
      "connect",
      "alerts-room",
      "discord",
      `--storage-dir=${storageDir}`,
      `--config-json={"guildId":"guild-1","channelId":"alerts","botToken":"${invalidToken}"}`,
    ])

    expect(out.code).toBe(2)
    expect((out.stderr ?? "")).toContain("INVALID_CREDENTIALS")
    expect((out.stderr ?? "").includes(invalidToken)).toBe(false)

    const payload = JSON.parse(out.stdout) as { code: string; message: string }
    expect(payload.code).toBe("INVALID_CREDENTIALS")
    expect(payload.message).toContain("Authentication failed for discord")
    expect(payload.message.includes(invalidToken)).toBe(false)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("channel verify validates connector config in non-live mode", async () => {
  const out = await runCli([
    "channel",
    "verify",
    "telegram",
    '--config-json={"accountId":"ops-bot","endpoint":"telegram://ops","accessToken":"telegram-token-12345"}',
  ])

  expect(out.code).toBe(0)
  const payload = JSON.parse(out.stdout) as {
    connectorId: string
    status: string
    message: string
  }

  expect(payload.connectorId).toBe("telegram")
  expect(payload.status).toBe("skipped")
  expect(payload.message).toContain("Live verification disabled")
})

test("channel verify rejects invalid connector payload deterministically", async () => {
  const out = await runCli([
    "channel",
    "verify",
    "slack",
    '--config-json={"accountId":"ops-bot","endpoint":"","accessToken":"slack-token-12345"}',
  ])

  expect(out.code).toBe(2)
  const payload = JSON.parse(out.stdout) as { code: string; message: string }
  expect(payload.code).toBe("CONFIG_VALIDATION_ERROR")
  expect(payload.message).toContain("slack config validation failed")
})

test("channel send returns skipped when live dispatch is disabled", async () => {
  const out = await runCli([
    "channel",
    "send",
    "telegram",
    '--config-json={"accountId":"ops-bot","endpoint":"telegram://ops","accessToken":"telegram-token-12345"}',
    "--text=hello from machina",
  ])

  expect(out.code).toBe(0)
  const payload = JSON.parse(out.stdout) as { connectorId: string; status: string; message: string }
  expect(payload.connectorId).toBe("telegram")
  expect(payload.status).toBe("skipped")
  expect(payload.message).toContain("Live dispatch disabled")
})

test("channel send requires --text argument", async () => {
  const out = await runCli([
    "channel",
    "send",
    "telegram",
    '--config-json={"accountId":"ops-bot","endpoint":"telegram://ops","accessToken":"telegram-token-12345"}',
  ])

  expect(out.code).toBe(1)
  expect(out.stderr ?? "").toContain("Missing required arg --text")
})

test("channel accounts set/list/show/remove lifecycle is deterministic", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-cli-channel-accounts-"))

  try {
    const setOut = await runCli([
      "channel",
      "accounts",
      "set",
      "ops-slack",
      "slack",
      `--storage-dir=${storageDir}`,
      '--config-json={"accountId":"ops-bot","endpoint":"slack://C12345","accessToken":"slack-token-12345"}',
    ])
    expect(setOut.code).toBe(0)

    const listOut = await runCli(["channel", "accounts", "list", `--storage-dir=${storageDir}`])
    expect(listOut.code).toBe(0)
    const listPayload = JSON.parse(listOut.stdout) as { accounts: Array<{ accountId: string }> }
    expect(listPayload.accounts.map((item) => item.accountId)).toContain("ops-slack")

    const showOut = await runCli(["channel", "accounts", "show", "ops-slack", `--storage-dir=${storageDir}`])
    expect(showOut.code).toBe(0)
    const showPayload = JSON.parse(showOut.stdout) as { accountId: string; connectorId: string }
    expect(showPayload.accountId).toBe("ops-slack")
    expect(showPayload.connectorId).toBe("slack")

    const removeOut = await runCli(["channel", "accounts", "remove", "ops-slack", `--storage-dir=${storageDir}`])
    expect(removeOut.code).toBe(0)
    const removePayload = JSON.parse(removeOut.stdout) as { removed: boolean }
    expect(removePayload.removed).toBe(true)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("channel connect-account uses saved account profile", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-cli-connect-account-"))

  try {
    await runCli([
      "channel",
      "accounts",
      "set",
      "ops-telegram",
      "telegram",
      `--storage-dir=${storageDir}`,
      '--config-json={"accountId":"ops","endpoint":"telegram://123456","accessToken":"telegram-token-12345"}',
    ])

    const out = await runCli([
      "channel",
      "connect-account",
      "alerts-room",
      "ops-telegram",
      `--storage-dir=${storageDir}`,
    ])

    expect(out.code).toBe(0)
    const payload = JSON.parse(out.stdout) as { status: string; connectorId: string }
    expect(payload.status).toBe("connected")
    expect(payload.connectorId).toBe("telegram")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("channel inbound discord returns skipped when live flag disabled", async () => {
  const out = await runCli([
    "channel",
    "inbound",
    "discord",
    '--config-json={"guildId":"guild-1","channelId":"alerts","botToken":"discord-token-12345"}',
  ])

  expect(out.code).toBe(0)
  const payload = JSON.parse(out.stdout) as { status: string; events: unknown[] }
  expect(payload.status).toBe("skipped")
  expect(payload.events.length).toBe(0)
})

test("channel inbound usage rejects unsupported provider", async () => {
  const out = await runCli([
    "channel",
    "inbound",
    "matrix",
    '--config-json={"accountId":"ops","endpoint":"telegram://123","accessToken":"telegram-token-12345"}',
  ])

  expect(out.code).toBe(1)
  expect(out.stderr ?? "").toContain("Usage: channel inbound <discord|telegram|slack>")
})

test("channel inbound telegram returns skipped when live flag disabled", async () => {
  const out = await runCli([
    "channel",
    "inbound",
    "telegram",
    '--config-json={"accountId":"ops","endpoint":"telegram://123","accessToken":"telegram-token-12345"}',
  ])

  expect(out.code).toBe(0)
  const payload = JSON.parse(out.stdout) as { status: string; events: unknown[] }
  expect(payload.status).toBe("skipped")
  expect(payload.events.length).toBe(0)
})

test("channel inbound slack returns skipped when live flag disabled", async () => {
  const out = await runCli([
    "channel",
    "inbound",
    "slack",
    '--config-json={"accountId":"ops","endpoint":"slack://COPS","accessToken":"slack-token-12345"}',
  ])

  expect(out.code).toBe(0)
  const payload = JSON.parse(out.stdout) as { status: string; events: unknown[] }
  expect(payload.status).toBe("skipped")
  expect(payload.events.length).toBe(0)
})

test("profile list returns deterministic profiles and active profile", async () => {
  const out = await runCli(["profile", "list"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    activeProfile: string
    profiles: Array<{ id: string; pluginMode: string }>
  }

  expect(payload.activeProfile).toBe("default")
  expect(payload.profiles.map((item) => item.id)).toContain("default")
  expect(payload.profiles.map((item) => item.id)).toContain("ops")
  expect(payload.profiles.find((item) => item.id === "ops")?.pluginMode).toBe("dev")
})

test("profile use returns deterministic missing-profile error", async () => {
  const out = await runCli(["profile", "use", "missing"])
  expect(out.code).toBe(2)
  expect(out.stderr).toContain("PROFILE_NOT_FOUND")

  const payload = JSON.parse(out.stdout) as { code: string; profileId: string }
  expect(payload.code).toBe("PROFILE_NOT_FOUND")
  expect(payload.profileId).toBe("missing")
})

test("doctor command without --json is supported for task 3 parity", async () => {
  const out = await runCli(["doctor"], { MACHINA_PLUGIN_MODE: "local" })
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as { status: string; result: { plugin: { status: string } } }
  expect(payload.status).toBe("completed")
  expect(payload.result.plugin.status).toBe("loaded")
})

test("nodes status reports deterministic node summary", async () => {
  const out = await runCli(["nodes", "status"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    nodes: Array<{ id: string; state: string }>
    summary: { total: number; online: number; offline: number }
  }

  expect(payload.summary.total).toBe(2)
  expect(payload.summary.online).toBe(1)
  expect(payload.summary.offline).toBe(1)
  expect(payload.nodes.map((item) => item.id)).toContain("node-alpha")
})

test("nodes status returns deterministic unknown node error", async () => {
  const out = await runCli(["nodes", "status", "--node=missing-node"])
  expect(out.code).toBe(2)
  expect(out.stderr).toContain("NODE_NOT_FOUND")

  const payload = JSON.parse(out.stdout) as { code: string; nodeId: string }
  expect(payload.code).toBe("NODE_NOT_FOUND")
  expect(payload.nodeId).toBe("missing-node")
})

test("logs tail supports deterministic stream filtering", async () => {
  const out = await runCli(["logs", "tail", "--stream=daemon", "--lines=1"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    stream: string
    lines: number
    entries: Array<{ stream: string; message: string }>
  }

  expect(payload.stream).toBe("daemon")
  expect(payload.lines).toBe(1)
  expect(payload.entries.length).toBe(1)
  expect(payload.entries[0]?.stream).toBe("daemon")
})

test("logs tail returns deterministic unsupported stream error", async () => {
  const out = await runCli(["logs", "tail", "--stream=kernel"])
  expect(out.code).toBe(2)
  expect(out.stderr).toContain("LOG_STREAM_UNSUPPORTED")

  const payload = JSON.parse(out.stdout) as { code: string; stream: string }
  expect(payload.code).toBe("LOG_STREAM_UNSUPPORTED")
  expect(payload.stream).toBe("kernel")
})

test("pair start returns deterministic pairing session", async () => {
  const out = await runCli(["pair", "start", "device-bravo"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    status: string
    sessionId: string
    device: { id: string }
  }

  expect(payload.status).toBe("started")
  expect(payload.sessionId).toBe("pair-device-bravo-0001")
  expect(payload.device.id).toBe("device-bravo")
})

test("pair start returns deterministic missing device error", async () => {
  const out = await runCli(["pair", "start", "ghost-device"])
  expect(out.code).toBe(2)
  expect(out.stderr).toContain("PAIR_DEVICE_NOT_FOUND")

  const payload = JSON.parse(out.stdout) as { code: string; deviceId: string }
  expect(payload.code).toBe("PAIR_DEVICE_NOT_FOUND")
  expect(payload.deviceId).toBe("ghost-device")
})

test("sandbox status returns deterministic sandbox state", async () => {
  const out = await runCli(["sandbox", "status"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as { id: string; status: string; profile: string }
  expect(payload.id).toBe("default")
  expect(payload.status).toBe("ready")
  expect(payload.profile).toBe("default")
})

test("sandbox status returns deterministic unknown sandbox error", async () => {
  const out = await runCli(["sandbox", "status", "ghost"])
  expect(out.code).toBe(2)
  expect(out.stderr).toContain("SANDBOX_NOT_FOUND")

  const payload = JSON.parse(out.stdout) as { code: string; sandboxId: string }
  expect(payload.code).toBe("SANDBOX_NOT_FOUND")
  expect(payload.sandboxId).toBe("ghost")
})

test("update check returns deterministic installer payload", async () => {
  const out = await runCli(["update", "check"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    updateAvailable: boolean
    latestVersion: string
    installer: { target: string }
  }
  expect(payload.updateAvailable).toBe(true)
  expect(payload.latestVersion).toBe("0.1.1")
  expect(payload.installer.target).toBe("darwin-arm64")
})

test("update returns deterministic usage error for unsupported subcommand", async () => {
  const out = await runCli(["update", "upgrade"])
  expect(out.code).toBe(1)
  expect(out.stdout).toBe("")
  expect(out.stderr).toBe("Unknown update subcommand. Usage: update check")
})

test("webhooks list returns deterministic webhook registry", async () => {
  const out = await runCli(["webhooks", "list"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    webhooks: Array<{ id: string; enabled: boolean }>
  }
  expect(payload.webhooks.length).toBe(2)
  expect(payload.webhooks[0]?.id).toBe("hook-build")
})

test("webhooks returns deterministic usage error for unsupported subcommand", async () => {
  const out = await runCli(["webhooks", "sync"])
  expect(out.code).toBe(1)
  expect(out.stdout).toBe("")
  expect(out.stderr).toBe("Unknown webhooks subcommand. Usage: webhooks list")
})

test("daemon status returns deterministic daemon health", async () => {
  const out = await runCli(["daemon", "status"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    daemons: Array<{ name: string; status: string }>
  }
  expect(payload.daemons.map((item) => item.name)).toContain("open-machina-agent")
  expect(payload.daemons.find((item) => item.name === "open-machina-agent")?.status).toBe("running")
})

test("daemon status returns deterministic daemon not found error", async () => {
  const out = await runCli(["daemon", "status", "--name=unknown-daemon"])
  expect(out.code).toBe(2)
  expect(out.stderr).toContain("DAEMON_NOT_FOUND")

  const payload = JSON.parse(out.stdout) as { code: string; daemonName: string }
  expect(payload.code).toBe("DAEMON_NOT_FOUND")
  expect(payload.daemonName).toBe("unknown-daemon")
})

test("completion bash returns deterministic completion script", async () => {
  const out = await runCli(["completion", "bash"])
  expect(out.code).toBe(0)
  expect(out.stdout).toContain("# open-machina bash completion")
  expect(out.stdout).toContain("complete -F _open_machina_complete open-machina")
})

test("completion returns deterministic unsupported shell error", async () => {
  const out = await runCli(["completion", "tcsh"])
  expect(out.code).toBe(2)
  expect(out.stderr).toContain("COMPLETION_SHELL_UNSUPPORTED")

  const payload = JSON.parse(out.stdout) as { code: string; shell: string }
  expect(payload.code).toBe("COMPLETION_SHELL_UNSUPPORTED")
  expect(payload.shell).toBe("tcsh")
})

test("tui keybindings exposes deterministic cli bridge contract", async () => {
  const out = await runCli(["tui", "keybindings"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    compatibility: string
    bridge: { deterministic: boolean }
    keybindings: Array<{ key: string; action: string }>
  }

  expect(payload.compatibility).toBe("openclaw-keymap-v1")
  expect(payload.bridge.deterministic).toBe(true)
  expect(payload.keybindings.find((entry) => entry.key === "ctrl+r")?.action).toBe("workflow.run")
})

test("tool list includes lsp diagnostics tool", async () => {
  const out = await runCli(["tool", "list"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as { tools: Array<{ id: string }> }
  expect(payload.tools.some((tool) => tool.id === "lsp.diagnostics")).toBe(true)
})

test("tool run metadata returns deterministic summary", async () => {
  const out = await runCli(["tool", "run", "tool.metadata", "--actor=test-agent", "--approve=false"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    status: string
    result: { summary: { total: number; deterministicCount: number } }
  }

  expect(payload.status).toBe("completed")
  expect(payload.result.summary.total).toBeGreaterThan(0)
  expect(payload.result.summary.deterministicCount).toBeGreaterThan(0)
})

test("tool run mcp oauth status returns deterministic payload", async () => {
  const out = await runCli(["tool", "run", "mcp.oauth.status", "--actor=test-agent", "--approve=false"], {
    MACHINA_MCP_OAUTH_ENABLED: "true",
  })
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    status: string
    result: { oauth: { supported: boolean; flow: string } }
  }

  expect(payload.status).toBe("completed")
  expect(payload.result.oauth.supported).toBe(true)
  expect(payload.result.oauth.flow).toBe("device-code")
})

test("tool run privileged denial redacts secrets and records deterministic denial reason", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-cli-tools-denied-redacted-"))
  const secret = "token-cli-secret-7788"

  try {
    const out = await runCli([
      "tool",
      "run",
      "storage.write-maintenance-marker",
      "--approve=false",
      "--actor=test-agent",
      "--operation-id=op-cli-tools-denied-0001",
      `--storage-dir=${storageDir}`,
      `--input-json={"note":"${secret}"}`,
    ])

    expect(out.code).toBe(3)
    expect((out.stderr ?? "")).toContain("POLICY_DENIED")
    expect((out.stderr ?? "").includes(secret)).toBe(false)

    const payload = JSON.parse(out.stdout) as { code: string; message: string }
    expect(payload.code).toBe("POLICY_DENIED")
    expect(payload.message.includes(secret)).toBe(false)

    const auditRaw = await readFile(join(storageDir, "audit-log.jsonl"), "utf8")
    expect(auditRaw.includes(secret)).toBe(false)
    const audit = JSON.parse(auditRaw.trim()) as { denialReason: string; status: string; decision: string }
    expect(audit.decision).toBe("denied")
    expect(audit.status).toBe("blocked")
    expect(audit.denialReason).toBe("privileged-approval-required")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("workflow run long-running forced cancellation reports cleanup with no orphan", async () => {
  const out = await runCli(["workflow", "run", "long-running", "--cancel-after-ms=75"])
  expect(out.code).toBe(130)

  const payload = JSON.parse(out.stdout) as {
    result?: unknown
    error?: string
    tracker: { childPid: number | null; aliveAfterCleanup: boolean | null }
    status: string
    log: WorkflowLog
  }

  expect(payload.status).toBe("cancelled")
  expect(payload.result).toBeUndefined()
  expect(payload.error).toContain("Cancellation requested after 75ms")
  expect(payload.tracker.childPid).not.toBeNull()
  expect(payload.tracker.aliveAfterCleanup).toBe(false)
  expect(payload.log.workflowName).toBe("long-running")
  expect(payload.log.status).toBe("cancelled")
})

test("backup plan returns daily snapshot retention plan", async () => {
  const out = await runCli(["backup", "plan", "--now=2026-02-11T10:00:00.000Z"])
  expect(out.code).toBe(0)

  const payload = JSON.parse(out.stdout) as {
    policy: { cadence: string; retention: number; perDay: number }
    result: { retained: Array<{ id: string }>; removed: string[] }
  }
  expect(payload.policy.cadence).toBe("daily")
  expect(payload.policy.retention).toBe(5)
  expect(payload.result.retained.length).toBe(5)
})

test("autonomy decide reports unavailable judge without static decision fallback", async () => {
  const out = await runCli([
    "autonomy",
    "decide",
    '--input-json={"now":"2026-02-11T10:00:00.000Z","userMessage":"interrupt","userIntent":"urgent","persona":{"name":"machina","traits":["focused"],"goals":["help"],"fixedPrinciples":["prevent direct harm"]},"activeWork":[],"systemState":{}}',
  ])

  expect(out.code).toBe(2)
  expect(out.stderr).toContain("AUTONOMY_JUDGE_UNAVAILABLE")
  const payload = JSON.parse(out.stdout) as { error: string }
  expect(payload.error).toContain("AUTONOMY_JUDGE_UNAVAILABLE")
})
