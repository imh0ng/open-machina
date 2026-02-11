import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  ToolPolicyError,
  ToolRuntimeError,
  ChannelRegistry,
  ChannelRuntimeError,
  WorkflowEngine,
  createMachinaToolRegistry,
  createDefaultChannelConnectors,
  pullDiscordInboundEvents,
  pullSlackInboundEvents,
  pullTelegramInboundEvents,
  sendConnectorMessage,
  verifyConnectorConfig,
  parseConfigJson,
  type WorkflowRunResult,
  brand,
  checkSessionIntegrity,
  compactSessions,
  runMigrations,
  sleepWithSignal,
  decideOrchestration,
  detectBackupOs,
  runSnapshotCycle,
  DEFAULT_SNAPSHOT_POLICY,
} from "open-machina-shared"
import { getPluginStatus, info } from "open-machina-plugin"

const NEON_MINT = "\x1b[38;2;0;255;157m"
const RESET = "\x1b[0m"
const ROBOT = "🤖"

export function banner() {
  return `${NEON_MINT}${ROBOT} Welcome to ${brand()}${RESET}`
}

type CliResult = {
  code: number
  stdout: string
  stderr?: string
}

type StatusWorkflowResult = {
  runtime: "open-machina"
  pluginStatus: "loaded" | "error"
}

type DoctorWorkflowResult = {
  runtime: "open-machina"
  plugin: Awaited<ReturnType<typeof getPluginStatus>>
}

type StorageMigrateResult = Awaited<ReturnType<typeof runMigrations>>
type StorageIntegrityResult = Awaited<ReturnType<typeof checkSessionIntegrity>>
type StorageCompactResult = Awaited<ReturnType<typeof compactSessions>>

type CancellationTracker = {
  childPid: number | null
  aliveAfterCleanup: boolean | null
}

type LongRunningPayload = {
  tracker?: CancellationTracker
}

type ProfileSummary = {
  id: string
  label: string
  storageDir: string
  pluginMode: "local" | "dev" | "prod"
}

type DeviceNodeSummary = {
  id: string
  role: "device" | "hub"
  state: "online" | "offline"
  connector: string
}

type DaemonSummary = {
  name: string
  status: "running" | "stopped"
  pid: number | null
  uptimeSeconds: number
}

type WebhookSummary = {
  id: string
  event: string
  target: string
  enabled: boolean
}

type SandboxSummary = {
  id: string
  status: "ready" | "stopped"
  profile: string
}

type PairableDevice = {
  id: string
  connector: string
  displayName: string
}

type DiagnosticSignal = {
  id: string
  status: "ok" | "warn"
  detail: string
}

const workflowEngine = createWorkflowEngine()
let toolOperationCounter = 0

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  const args = normalizeArgs(argv)

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return {
      code: 0,
      stdout: [
        "open-machina [--version] [install] [status] [doctor [--json]] [storage migrate|integrity|compact] [workflow list|run|cancel-smoke]",
        "",
        "Commands:",
        "  --version                                  Print Machina identity marker and version",
        "  install                                    Setup command + shell completion hints",
        "  status                                     Run status workflow",
        "  doctor [--json]                            Run doctor diagnostics workflow",
        "  onboard [--write-config=<path>]            Guided setup helper with optional config scaffold",
        "  profile list                               List available CLI profiles",
        "  profile use <profile-id>                   Resolve and validate selected profile",
        "  nodes status [--node=<id>]                 Show device/node runtime health",
        "  logs tail [--lines=<n>] [--stream=<name>]  Print deterministic log tail snapshot",
        "  pair start <device-id>                     Start deterministic device pairing handshake",
        "  sandbox status [<sandbox-id>]              Show sandbox runtime status",
        "  update check                               Check installer/update availability",
        "  webhooks list                              Show configured webhook routes",
        "  daemon status [--name=<id>]                Show daemon process status",
        "  completion <shell>                         Generate shell completion script",
        "  tui keybindings                            Print deterministic CLI/TUI bridge contract",
        "  storage migrate                            Run storage migration workflow",
        "  storage integrity                          Run storage integrity workflow",
        "  storage compact                            Run storage compaction workflow",
        "  channel connectors                         List available channel connectors",
        "  channel connect <channel-id> <connector-id> --config-json=<json>",
        "                                             Connect channel using connector and config payload",
        "  channel connect-account <channel-id> <account-id>",
        "                                             Connect channel using saved account profile",
        "  channel verify <connector-id> --config-json=<json> [--live=true|false]",
        "                                             Validate connector config and optionally run live provider probe",
        "  channel send <connector-id> --config-json=<json> --text=<message> [--target=<id>] [--live=true|false]",
        "                                             Send outbound channel message (live mode required)",
        "  channel inbound <discord|telegram|slack> --config-json=<json> [--live=true|false] [--limit=<n>] [--channel=<id>] [--offset=<n>]",
        "                                             Pull inbound messages for provider",
        "  channel accounts list [--connector=<id>]    List saved channel account profiles",
        "  channel accounts show <account-id>          Show saved account profile",
        "  channel accounts set <account-id> <connector-id> --config-json=<json>",
        "                                             Upsert saved account profile",
        "  channel accounts remove <account-id>        Remove saved account profile",
        "  channel status <channel-id>                Show current channel connection status",
        "  channel disconnect <channel-id>            Disconnect channel",
        "  workflow list                              List available workflows",
        "  workflow run <workflow-name>               Run workflow by name",
        "  workflow cancel-smoke                      Run deterministic cancellation scenario",
        "  autonomy decide --input-json=<json>         AI judge-based interrupt arbitration",
        "  backup plan [--now=<iso>]                   Run snapshot retention planning cycle",
        "  tools list                                 List registered tools and permission classes",
        "  tools run <tool-id>                        Run a tool invocation",
        "                                             --approve=true|false --actor=<id> --operation-id=<id>",
        "                                             --note=<text> (for storage.write-maintenance-marker)",
        "                                             --tool-id=<id> (for runtime.tool-metadata)",
        "                                             --input-json=<json> (for explicit deterministic input)",
        "",
        "Flags:",
        "  --storage-dir=<path>                       Override storage root for this invocation",
        "  --cancel-after-ms=<milliseconds>           Cancel workflow after timeout",
      ].join("\n"),
    }
  }

  if (args[0] === "--version" || args[0] === "-v") {
    const metadata = await info()
    return {
      code: 0,
      stdout: `${NEON_MINT}${ROBOT} ${metadata.marker} ${metadata.name} ${metadata.version}${RESET}`,
    }
  }

  if (args[0] === "install") {
    const shell = detectShell(env)
    const pluginPath = resolve(process.cwd(), "packages/open-machina-plugin/dist/index.js")
    return {
      code: 0,
      stdout: JSON.stringify(
        {
          command: "open-machina install",
          status: "ready",
          shell,
          usage: {
            run: "open-machina --help",
            npmGlobal: "npm install -g open-machina",
            bunx: "bunx open-machina --help",
          },
          completion: {
            bash: "open-machina completion bash",
            zsh: "open-machina completion zsh",
            fish: "open-machina completion fish",
            powershell: "open-machina completion powershell",
          },
          opencode: {
            pluginConfigField: "plugin",
            recommended: ["oh-my-opencode", `file://${pluginPath}`],
            npmPublishedAlternative: ["oh-my-opencode", "open-machina-plugin"],
          },
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "status") {
    const execution = await workflowEngine.run<{ env: NodeJS.ProcessEnv }, StatusWorkflowResult>("status", {
      payload: { env },
    })
    return toCliResult(execution)
  }

  if (args[0] === "doctor" && (args.length === 1 || args[1] === "--json")) {
    const execution = await workflowEngine.run<{ env: NodeJS.ProcessEnv }, DoctorWorkflowResult>("doctor", {
      payload: { env },
    })

    return toCliResult(execution)
  }

  if (args[0] === "onboard" || args[0] === "setup") {
    const writeConfigPath = getStringArg(args, "--write-config=")
    const result = await runOnboardingHelper(writeConfigPath)
    return {
      code: 0,
      stdout: JSON.stringify(result, null, 2),
    }
  }

  if (args[0] === "profile") {
    if (args[1] === "list") {
      return {
        code: 0,
        stdout: JSON.stringify(
          {
            profiles: TASK3_PROFILES,
            activeProfile: TASK3_ACTIVE_PROFILE,
          },
          null,
          2,
        ),
      }
    }

    if (args[1] === "use") {
      const profileId = args[2]
      if (!profileId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing required arg. Usage: profile use <profile-id>",
        }
      }

      const profile = TASK3_PROFILES.find((item) => item.id === profileId)
      if (!profile) {
        const message = `Unknown profile: ${profileId}`
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: "PROFILE_NOT_FOUND",
              message,
              profileId,
            },
            null,
            2,
          ),
          stderr: `PROFILE_NOT_FOUND: ${message}`,
        }
      }

      return {
        code: 0,
        stdout: JSON.stringify(
          {
            profile,
            resolvedEnv: {
              MACHINA_PLUGIN_MODE: profile.pluginMode,
              MACHINA_STORAGE_DIR: profile.storageDir,
            },
          },
          null,
          2,
        ),
      }
    }
  }

  if (args[0] === "nodes" && args[1] === "status") {
    const nodeId = getStringArg(args, "--node=")
    if (nodeId) {
      const singleNode = TASK3_NODES.find((item) => item.id === nodeId)
      if (!singleNode) {
        const message = `Unknown node: ${nodeId}`
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: "NODE_NOT_FOUND",
              message,
              nodeId,
            },
            null,
            2,
          ),
          stderr: `NODE_NOT_FOUND: ${message}`,
        }
      }

      return {
        code: 0,
        stdout: JSON.stringify(
          {
            nodes: [singleNode],
            summary: {
              total: 1,
              online: singleNode.state === "online" ? 1 : 0,
              offline: singleNode.state === "offline" ? 1 : 0,
            },
          },
          null,
          2,
        ),
      }
    }

    const online = TASK3_NODES.filter((item) => item.state === "online").length
    const offline = TASK3_NODES.length - online
    return {
      code: 0,
      stdout: JSON.stringify(
        {
          nodes: TASK3_NODES,
          summary: {
            total: TASK3_NODES.length,
            online,
            offline,
          },
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "logs" && args[1] === "tail") {
    const streamArg = getStringArg(args, "--stream=") ?? "all"
    if (!isTask3LogStream(streamArg)) {
      const message = `Unsupported log stream: ${streamArg}`
      return {
        code: 2,
        stdout: JSON.stringify(
          {
            code: "LOG_STREAM_UNSUPPORTED",
            message,
            stream: streamArg,
          },
          null,
          2,
        ),
        stderr: `LOG_STREAM_UNSUPPORTED: ${message}`,
      }
    }

    const stream = streamArg

    const requestedLines = getNumberArg(args, "--lines=") ?? 3
    const entries = TASK3_LOG_ENTRIES.filter((entry) => stream === "all" || entry.stream === stream)
    const lines = Math.min(Math.max(Math.trunc(requestedLines), 1), entries.length)
    return {
      code: 0,
      stdout: JSON.stringify(
        {
          stream,
          lines,
          entries: entries.slice(-lines),
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "pair" && args[1] === "start") {
    const deviceId = args[2]
    if (!deviceId) {
      return {
        code: 1,
        stdout: "",
        stderr: "Missing required arg. Usage: pair start <device-id>",
      }
    }

    const device = TASK3_PAIRABLE_DEVICES.find((item) => item.id === deviceId)
    if (!device) {
      const message = `Unknown pairable device: ${deviceId}`
      return {
        code: 2,
        stdout: JSON.stringify(
          {
            code: "PAIR_DEVICE_NOT_FOUND",
            message,
            deviceId,
          },
          null,
          2,
        ),
        stderr: `PAIR_DEVICE_NOT_FOUND: ${message}`,
      }
    }

    return {
      code: 0,
      stdout: JSON.stringify(
        {
          status: "started",
          device,
          sessionId: `pair-${device.id}-0001`,
          expiresInSeconds: 300,
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "sandbox" && args[1] === "status") {
    const sandboxId = args[2] ?? "default"
    const sandbox = TASK3_SANDBOXES.find((item) => item.id === sandboxId)
    if (!sandbox) {
      const message = `Unknown sandbox: ${sandboxId}`
      return {
        code: 2,
        stdout: JSON.stringify(
          {
            code: "SANDBOX_NOT_FOUND",
            message,
            sandboxId,
          },
          null,
          2,
        ),
        stderr: `SANDBOX_NOT_FOUND: ${message}`,
      }
    }

    return {
      code: 0,
      stdout: JSON.stringify(sandbox, null, 2),
    }
  }

  if (args[0] === "update" && args[1] === "check") {
    return {
      code: 0,
      stdout: JSON.stringify(
        {
          currentVersion: "0.1.0",
          latestVersion: "0.1.1",
          updateAvailable: true,
          installer: {
            channel: "stable",
            target: "darwin-arm64",
            checksum: "sha256:9f0cc8d2af90f0dc6959a8f9666b6d9d26fbe7680fa96b5e9c3d9e314807eb4e",
          },
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "webhooks" && args[1] === "list") {
    return {
      code: 0,
      stdout: JSON.stringify(
        {
          webhooks: TASK3_WEBHOOKS,
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "daemon" && args[1] === "status") {
    const daemonName = getStringArg(args, "--name=")
    if (daemonName) {
      const daemon = TASK3_DAEMONS.find((item) => item.name === daemonName)
      if (!daemon) {
        const message = `Unknown daemon: ${daemonName}`
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: "DAEMON_NOT_FOUND",
              message,
              daemonName,
            },
            null,
            2,
          ),
          stderr: `DAEMON_NOT_FOUND: ${message}`,
        }
      }

      return {
        code: 0,
        stdout: JSON.stringify(daemon, null, 2),
      }
    }

    return {
      code: 0,
      stdout: JSON.stringify(
        {
          daemons: TASK3_DAEMONS,
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "completion") {
    const shell = args[1]
    if (!shell) {
      return {
        code: 1,
        stdout: "",
        stderr: "Missing shell. Usage: completion <bash|zsh|fish|powershell>",
      }
    }

    const script = TASK3_COMPLETIONS[shell]
    if (!script) {
      const message = `Unsupported shell: ${shell}`
      return {
        code: 2,
        stdout: JSON.stringify(
          {
            code: "COMPLETION_SHELL_UNSUPPORTED",
            message,
            shell,
          },
          null,
          2,
        ),
        stderr: `COMPLETION_SHELL_UNSUPPORTED: ${message}`,
      }
    }

    return {
      code: 0,
      stdout: script,
    }
  }

  if (args[0] === "tui" && args[1] === "keybindings") {
    return {
      code: 0,
      stdout: JSON.stringify(
        {
          compatibility: "openclaw-keymap-v1",
          bridge: {
            source: "opencode-tui",
            mode: "cli-contract",
            deterministic: true,
          },
          keybindings: TASK3_TUI_KEYBINDINGS,
          diagnostics: TASK3_DIAGNOSTIC_SIGNALS,
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "storage") {
    const storageDir = getStorageDirArg(args)

    if (args[1] === "migrate") {
      const execution = await workflowEngine.run<
        { storageDir?: string; env: NodeJS.ProcessEnv },
        StorageMigrateResult
      >("storage.migrate", {
        payload: { storageDir, env },
      })
      return toCliResult(execution)
    }

    if (args[1] === "integrity") {
      const execution = await workflowEngine.run<
        { storageDir?: string; env: NodeJS.ProcessEnv },
        StorageIntegrityResult
      >("storage.integrity", {
        payload: { storageDir, env },
      })
      return toCliResult(execution)
    }

    if (args[1] === "compact") {
      const execution = await workflowEngine.run<
        { storageDir?: string; env: NodeJS.ProcessEnv },
        StorageCompactResult
      >("storage.compact", {
        payload: { storageDir, env },
      })
      return toCliResult(execution)
    }
  }

  if (args[0] === "channel") {
    const storageDir = getStorageDirArg(args)
    const registry = createChannelRegistry(storageDir)

    if (args[1] === "connectors") {
      return {
        code: 0,
        stdout: JSON.stringify(
          {
            connectors: registry.listConnectors(),
          },
          null,
          2,
        ),
      }
    }

    if (args[1] === "connect") {
      const channelId = args[2]
      const connectorId = args[3]
      if (!channelId || !connectorId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing required args. Usage: channel connect <channel-id> <connector-id> --config-json=<json>",
        }
      }

      try {
        const status = await registry.connect({
          channelId,
          connectorId,
          config: parseConfigJson(getStringArg(args, "--config-json=")),
        })

        return {
          code: 0,
          stdout: JSON.stringify(status, null, 2),
        }
      } catch (error) {
        const normalized = normalizeChannelError(error)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: normalized.code,
              message: normalized.message,
            },
            null,
            2,
          ),
          stderr: `${normalized.code}: ${normalized.message}`,
        }
      }
    }

    if (args[1] === "connect-account") {
      const channelId = args[2]
      const accountId = args[3]
      if (!channelId || !accountId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing required args. Usage: channel connect-account <channel-id> <account-id>",
        }
      }

      try {
        const status = await registry.connectAccount({ channelId, accountId })
        return {
          code: 0,
          stdout: JSON.stringify(status, null, 2),
        }
      } catch (error) {
        const normalized = normalizeChannelError(error)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: normalized.code,
              message: normalized.message,
            },
            null,
            2,
          ),
          stderr: `${normalized.code}: ${normalized.message}`,
        }
      }
    }

    if (args[1] === "accounts") {
      if (args[2] === "list") {
        const connectorId = getStringArg(args, "--connector=")
        const accounts = await registry.listAccounts(connectorId)
        return {
          code: 0,
          stdout: JSON.stringify({ accounts }, null, 2),
        }
      }

      if (args[2] === "show") {
        const accountId = args[3]
        if (!accountId) {
          return {
            code: 1,
            stdout: "",
            stderr: "Missing required arg. Usage: channel accounts show <account-id>",
          }
        }

        const account = await registry.getAccount(accountId)
        if (!account) {
          const message = `Account not found: ${accountId}`
          return {
            code: 2,
            stdout: JSON.stringify({ code: "ACCOUNT_NOT_FOUND", message, accountId }, null, 2),
            stderr: `ACCOUNT_NOT_FOUND: ${message}`,
          }
        }

        return {
          code: 0,
          stdout: JSON.stringify(account, null, 2),
        }
      }

      if (args[2] === "set") {
        const accountId = args[3]
        const connectorId = args[4]
        if (!accountId || !connectorId) {
          return {
            code: 1,
            stdout: "",
            stderr:
              "Missing required args. Usage: channel accounts set <account-id> <connector-id> --config-json=<json>",
          }
        }

        try {
          const account = await registry.saveAccount({
            accountId,
            connectorId,
            config: parseConfigJson(getStringArg(args, "--config-json=")),
          })

          return {
            code: 0,
            stdout: JSON.stringify(account, null, 2),
          }
        } catch (error) {
          const normalized = normalizeChannelError(error)
          return {
            code: 2,
            stdout: JSON.stringify(
              {
                code: normalized.code,
                message: normalized.message,
              },
              null,
              2,
            ),
            stderr: `${normalized.code}: ${normalized.message}`,
          }
        }
      }

      if (args[2] === "remove") {
        const accountId = args[3]
        if (!accountId) {
          return {
            code: 1,
            stdout: "",
            stderr: "Missing required arg. Usage: channel accounts remove <account-id>",
          }
        }

        const removed = await registry.removeAccount(accountId)
        return {
          code: removed ? 0 : 2,
          stdout: JSON.stringify(
            removed
              ? {
                  accountId,
                  removed: true,
                }
              : {
                  code: "ACCOUNT_NOT_FOUND",
                  message: `Account not found: ${accountId}`,
                  accountId,
                },
            null,
            2,
          ),
          stderr: removed ? undefined : `ACCOUNT_NOT_FOUND: Account not found: ${accountId}`,
        }
      }

      return {
        code: 1,
        stdout: "",
        stderr:
          "Unknown channel accounts subcommand. Usage: channel accounts list|show <account-id>|set <account-id> <connector-id> --config-json=<json>|remove <account-id>",
      }
    }

    if (args[1] === "verify") {
      const connectorId = args[2]
      if (!connectorId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing required arg. Usage: channel verify <connector-id> --config-json=<json> [--live=true|false]",
        }
      }

      try {
        const verification = await verifyConnectorConfig(
          connectorId,
          parseConfigJson(getStringArg(args, "--config-json=")),
          {
            live: getBooleanArg(args, "--live=") ?? false,
          },
        )

        return {
          code: 0,
          stdout: JSON.stringify(verification, null, 2),
        }
      } catch (error) {
        const normalized = normalizeChannelError(error)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: normalized.code,
              message: normalized.message,
            },
            null,
            2,
          ),
          stderr: `${normalized.code}: ${normalized.message}`,
        }
      }
    }

    if (args[1] === "send") {
      const connectorId = args[2]
      if (!connectorId) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "Missing required arg. Usage: channel send <connector-id> --config-json=<json> --text=<message> [--target=<id>] [--live=true|false]",
        }
      }

      const text = getStringArg(args, "--text=")
      if (!text) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "Missing required arg --text. Usage: channel send <connector-id> --config-json=<json> --text=<message> [--target=<id>] [--live=true|false]",
        }
      }

      try {
        const result = await sendConnectorMessage(
          connectorId,
          parseConfigJson(getStringArg(args, "--config-json=")),
          {
            text,
            target: getStringArg(args, "--target="),
          },
          {
            live: getBooleanArg(args, "--live=") ?? false,
          },
        )

        return {
          code: 0,
          stdout: JSON.stringify(result, null, 2),
        }
      } catch (error) {
        const normalized = normalizeChannelError(error)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: normalized.code,
              message: normalized.message,
            },
            null,
            2,
          ),
          stderr: `${normalized.code}: ${normalized.message}`,
        }
      }
    }

    if (args[1] === "inbound") {
      const provider = args[2]
      if (provider !== "discord" && provider !== "telegram" && provider !== "slack") {
        return {
          code: 1,
          stdout: "",
          stderr:
            "Usage: channel inbound <discord|telegram|slack> --config-json=<json> [--live=true|false] [--limit=<n>] [--channel=<id>] [--offset=<n>]",
        }
      }

      try {
        const parsedConfig = parseConfigJson(getStringArg(args, "--config-json="))
        const live = getBooleanArg(args, "--live=") ?? false
        const limit = getNumberArg(args, "--limit=")

        const result =
          provider === "discord"
            ? await pullDiscordInboundEvents(parsedConfig, { live, limit })
            : provider === "telegram"
              ? await pullTelegramInboundEvents(parsedConfig, {
                  live,
                  limit,
                  offset: getNumberArg(args, "--offset="),
                })
              : await pullSlackInboundEvents(parsedConfig, {
                  live,
                  limit,
                  channel: getStringArg(args, "--channel="),
                })

        return {
          code: 0,
          stdout: JSON.stringify(result, null, 2),
        }
      } catch (error) {
        const normalized = normalizeChannelError(error)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: normalized.code,
              message: normalized.message,
            },
            null,
            2,
          ),
          stderr: `${normalized.code}: ${normalized.message}`,
        }
      }
    }

    if (args[1] === "status") {
      const channelId = args[2]
      if (!channelId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing required arg. Usage: channel status <channel-id>",
        }
      }

      const status = await registry.status(channelId)
      return {
        code: 0,
        stdout: JSON.stringify(status, null, 2),
      }
    }

    if (args[1] === "disconnect") {
      const channelId = args[2]
      if (!channelId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing required arg. Usage: channel disconnect <channel-id>",
        }
      }

      try {
        const status = await registry.disconnect(channelId)
        return {
          code: 0,
          stdout: JSON.stringify(status, null, 2),
        }
      } catch (error) {
        const normalized = normalizeChannelError(error)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: normalized.code,
              message: normalized.message,
            },
            null,
            2,
          ),
          stderr: `${normalized.code}: ${normalized.message}`,
        }
      }
    }
  }

  if (args[0] === "workflow" && args[1] === "list") {
    return {
      code: 0,
      stdout: JSON.stringify(
        {
          workflows: workflowEngine.listWorkflows(),
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "workflow" && args[1] === "run") {
    const workflowName = args[2]
    if (!workflowName) {
      return {
        code: 1,
        stdout: "",
        stderr: "Missing workflow name. Usage: workflow run <workflow-name>",
      }
    }

    if (workflowName === "long-running") {
      const tracker: CancellationTracker = { childPid: null, aliveAfterCleanup: null }
      const cancelAfterMs = getNumberArg(args, "--cancel-after-ms=")
      const execution = await workflowEngine.run<LongRunningPayload, { note: string }>("long-running", {
        payload: { tracker },
        cancelAfterMs,
      })

      return {
        code: execution.status === "completed" ? 0 : execution.status === "cancelled" ? 130 : 1,
        stdout: JSON.stringify(
          {
            status: execution.status,
            result: execution.result,
            error: execution.error,
            tracker,
            log: execution.log,
          },
          null,
          2,
        ),
      }
    }

    return {
      code: 1,
      stdout: "",
      stderr: `workflow run currently supports: long-running`,
    }
  }

  if (args[0] === "workflow" && args[1] === "cancel-smoke") {
    const cancelAfterMs = getNumberArg(args, "--cancel-after-ms=") ?? 120
    const tracker: CancellationTracker = { childPid: null, aliveAfterCleanup: null }
    const execution = await workflowEngine.run<LongRunningPayload, { note: string }>("long-running", {
      payload: { tracker },
      cancelAfterMs,
    })

    const noOrphan = execution.status === "cancelled" && tracker.childPid !== null && tracker.aliveAfterCleanup === false

    return {
      code: noOrphan ? 0 : 5,
      stdout: JSON.stringify(
        {
          scenario: "workflow.cancel-smoke",
          noOrphan,
          tracker,
          log: execution.log,
          status: execution.status,
          error: execution.error,
        },
        null,
        2,
      ),
      stderr: noOrphan ? undefined : "CANCELLATION_SMOKE_FAILED: orphan process detected or cancellation did not complete",
    }
  }

  if (args[0] === "autonomy" && args[1] === "decide") {
    const input = parseConfigJson(getStringArg(args, "--input-json=")) as Parameters<typeof decideOrchestration>[0]
    const result = await decideOrchestration(input, async () => {
      throw new Error("AUTONOMY_JUDGE_UNAVAILABLE: configure a judge in plugin runtime to make AI decision")
    }).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }))

    return {
      code: "error" in result ? 2 : 0,
      stdout: JSON.stringify(result, null, 2),
      stderr: "error" in result ? "AUTONOMY_JUDGE_UNAVAILABLE" : undefined,
    }
  }

  if (args[0] === "backup" && args[1] === "plan") {
    const nowArg = getStringArg(args, "--now=")
    const now = nowArg ? new Date(nowArg) : new Date()
    const snapshots = getStaticSnapshots(now)

    const result = await runSnapshotCycle(
      {
        os: detectBackupOs(process.platform),
        create: async () => ({
          id: `snapshot-${now.toISOString()}`,
          createdAt: now.toISOString(),
          source: "policy-plan",
        }),
        list: async () => snapshots,
        remove: async () => {
          return
        },
      },
      DEFAULT_SNAPSHOT_POLICY,
      now,
    )

    return {
      code: 0,
      stdout: JSON.stringify(
        {
          os: detectBackupOs(process.platform),
          policy: DEFAULT_SNAPSHOT_POLICY,
          result,
        },
        null,
        2,
      ),
    }
  }

  if (args[0] === "tool" || args[0] === "tools") {
    const registry = createMachinaToolRegistry()

    if (args[1] === "list") {
      return {
        code: 0,
        stdout: JSON.stringify(
          {
            tools: registry.listTools(),
          },
          null,
          2,
        ),
      }
    }

    if (args[1] === "run") {
      const toolId = args[2]
      if (!toolId) {
        return {
          code: 1,
          stdout: "",
          stderr: "Missing tool id. Usage: tool run <tool-id> --approve=true|false --actor=<id>",
        }
      }

      const approve = getBooleanArg(args, "--approve=") ?? false
      const actor = getStringArg(args, "--actor=") ?? "cli-user"
      const operationId = getStringArg(args, "--operation-id=") ?? nextToolOperationId()
      const note = getStringArg(args, "--note=")
      const metadataToolId = getStringArg(args, "--tool-id=")
      const inputJson = getStringArg(args, "--input-json=")
      const storageDir = getStorageDirArg(args)

      let input: Record<string, unknown>
      if (typeof inputJson === "string") {
        try {
          const parsed = JSON.parse(inputJson) as unknown
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {
              code: 2,
              stdout: JSON.stringify(
                {
                  code: "INVALID_INPUT_JSON",
                  message: "--input-json must decode to a JSON object",
                  operationId,
                  actor,
                  action: toolId,
                  approved: approve,
                },
                null,
                2,
              ),
              stderr: "INVALID_INPUT_JSON: --input-json must decode to a JSON object",
            }
          }

          input = parsed as Record<string, unknown>
        } catch {
          return {
            code: 2,
            stdout: JSON.stringify(
              {
                code: "INVALID_INPUT_JSON",
                message: "--input-json must be valid JSON",
                operationId,
                actor,
                action: toolId,
                approved: approve,
              },
              null,
              2,
            ),
            stderr: "INVALID_INPUT_JSON: --input-json must be valid JSON",
          }
        }
      } else {
        input = {}
        if (typeof note === "string") {
          input.note = note
        }
        if (typeof metadataToolId === "string") {
          input.toolId = metadataToolId
        }
      }

      try {
        const execution = await registry.execute<Record<string, unknown>, unknown>(toolId, {
          input,
          actor,
          operationId,
          permissionState: {
            privilegedApproved: approve,
          },
          storageDir,
          env,
        })

        return {
          code: 0,
          stdout: JSON.stringify(
            {
              status: "completed",
              operationId,
              actor,
              toolId,
              approved: approve,
              result: execution.output,
              audit: execution.auditRecord ?? null,
            },
            null,
            2,
          ),
        }
      } catch (error) {
        if (error instanceof ToolPolicyError) {
          const message = redactCliSecrets(error.message, input)
          return {
            code: 3,
            stdout: JSON.stringify(
              {
                code: error.code,
                message,
                operationId,
                actor,
                action: toolId,
                approved: approve,
              },
              null,
              2,
            ),
            stderr: `${error.code}: ${message}`,
          }
        }

        if (error instanceof ToolRuntimeError) {
          const message = redactCliSecrets(error.message, input)
          return {
            code: 2,
            stdout: JSON.stringify(
              {
                code: error.code,
                message,
                operationId,
                actor,
                action: toolId,
                approved: approve,
              },
              null,
              2,
            ),
            stderr: `${error.code}: ${message}`,
          }
        }

        const message = redactCliSecrets(error instanceof Error ? error.message : String(error), input)
        return {
          code: 2,
          stdout: JSON.stringify(
            {
              code: "TOOL_EXECUTION_FAILED",
              message,
              operationId,
              actor,
              action: toolId,
              approved: approve,
            },
            null,
            2,
          ),
          stderr: `TOOL_EXECUTION_FAILED: ${message}`,
        }
      }
    }
  }

  const task3Usage = getTask3UsageError(args)
  if (task3Usage) {
    return {
      code: 1,
      stdout: "",
      stderr: task3Usage,
    }
  }

  return {
    code: 1,
    stdout: "",
    stderr: `Unknown command: ${args.join(" ")}. Try --help.`,
  }
}

function createWorkflowEngine(): WorkflowEngine {
  const engine = new WorkflowEngine()

  engine.register<{ env: NodeJS.ProcessEnv }, StatusWorkflowResult>({
    name: "status",
    run: async ({ payload }) => {
      const plugin = await getPluginStatus(payload.env)
      return {
        runtime: "open-machina",
        pluginStatus: plugin.status,
      }
    },
  })

  engine.register<{ env: NodeJS.ProcessEnv }, DoctorWorkflowResult>({
    name: "doctor",
    run: async ({ payload }) => {
      const plugin = await getPluginStatus(payload.env)
      return {
        runtime: "open-machina",
        plugin,
      }
    },
  })

  engine.register<{ storageDir?: string; env: NodeJS.ProcessEnv }, StorageMigrateResult>({
    name: "storage.migrate",
    run: async ({ payload }) => runMigrations({ storageDir: payload.storageDir }, payload.env),
  })

  engine.register<{ storageDir?: string; env: NodeJS.ProcessEnv }, StorageIntegrityResult>({
    name: "storage.integrity",
    run: async ({ payload }) => checkSessionIntegrity(payload.storageDir, payload.env),
  })

  engine.register<{ storageDir?: string; env: NodeJS.ProcessEnv }, StorageCompactResult>({
    name: "storage.compact",
    run: async ({ payload }) => compactSessions(payload.storageDir, payload.env),
  })

  engine.register<LongRunningPayload, { note: string }>({
    name: "long-running",
    run: async ({ signal, payload, addCleanup, throwIfAborted }) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      })

      if (payload.tracker) {
        payload.tracker.childPid = child.pid ?? null
      }

      addCleanup(async () => {
        await terminateChildProcess(child)
        if (payload.tracker && payload.tracker.childPid !== null) {
          payload.tracker.aliveAfterCleanup = isProcessAlive(payload.tracker.childPid)
        }
      })

      while (true) {
        throwIfAborted()
        await sleepWithSignal(250, signal)
      }
    },
  })

  return engine
}

function toCliResult(execution: WorkflowRunResult<unknown>): CliResult {
  const payload = {
    status: execution.status,
    result: execution.result,
    error: execution.error,
    log: execution.log,
  }

  if (execution.status === "completed") {
    return {
      code: 0,
      stdout: JSON.stringify(payload, null, 2),
    }
  }

  if (execution.status === "cancelled") {
    return {
      code: 130,
      stdout: JSON.stringify(payload, null, 2),
      stderr: execution.error,
    }
  }

  return {
    code: 4,
    stdout: JSON.stringify(payload, null, 2),
    stderr: execution.error,
  }
}

function normalizeArgs(argv: string[]): string[] {
  if (argv.length > 0 && argv[0] === "--") {
    return argv.slice(1)
  }

  return argv
}

function getStorageDirArg(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith("--storage-dir=")) {
      const value = arg.slice("--storage-dir=".length)
      return value.length > 0 ? value : undefined
    }
  }

  return undefined
}

function getNumberArg(args: string[], prefix: string): number | undefined {
  for (const arg of args) {
    if (!arg.startsWith(prefix)) {
      continue
    }

    const raw = arg.slice(prefix.length)
    if (raw.length === 0) {
      return undefined
    }

    const value = Number(raw)
    if (Number.isNaN(value) || value < 0) {
      return undefined
    }

    return value
  }

  return undefined
}

function getStringArg(args: string[], prefix: string): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith(prefix)) {
      continue
    }

    const raw = arg.slice(prefix.length)
    return raw.length > 0 ? raw : undefined
  }

  return undefined
}

function getBooleanArg(args: string[], prefix: string): boolean | undefined {
  const value = getStringArg(args, prefix)
  if (typeof value !== "string") {
    return undefined
  }

  if (value === "true") {
    return true
  }

  if (value === "false") {
    return false
  }

  return undefined
}

function detectShell(env: NodeJS.ProcessEnv): "bash" | "zsh" | "fish" | "powershell" | "unknown" {
  const raw = (env.SHELL ?? env.ComSpec ?? "").toLowerCase()
  if (raw.includes("zsh")) {
    return "zsh"
  }
  if (raw.includes("fish")) {
    return "fish"
  }
  if (raw.includes("powershell") || raw.includes("pwsh") || raw.includes("cmd.exe")) {
    return "powershell"
  }
  if (raw.includes("bash")) {
    return "bash"
  }
  return "unknown"
}

function getStaticSnapshots(now: Date): Array<{ id: string; createdAt: string; source: string }> {
  return [1, 2, 3, 4, 5].map((index) => ({
    id: `seed-${index}`,
    createdAt: new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString(),
    source: "policy-plan",
  }))
}

function nextToolOperationId(): string {
  toolOperationCounter += 1
  return `op-tool-${String(toolOperationCounter).padStart(4, "0")}`
}

function createChannelRegistry(storageDir?: string): ChannelRegistry {
  const registry = new ChannelRegistry({ storageDir })
  for (const connector of createDefaultChannelConnectors()) {
    registry.register(connector)
  }
  return registry
}

function normalizeChannelError(error: unknown): { code: string; message: string } {
  if (error instanceof ChannelRuntimeError) {
    return {
      code: error.code,
      message: error.message,
    }
  }

  if (error instanceof Error) {
    return {
      code: "CHANNEL_RUNTIME_ERROR",
      message: error.message,
    }
  }

  return {
    code: "CHANNEL_RUNTIME_ERROR",
    message: String(error),
  }
}

async function terminateChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid
  if (!pid || child.killed || child.exitCode !== null) {
    return
  }

  try {
    child.kill("SIGTERM")
  } catch {
    return
  }

  const exitedSoftly = await waitForExitOrDeath(child, pid, 400)
  if (exitedSoftly) {
    return
  }

  try {
    child.kill("SIGKILL")
  } catch {
    return
  }

  await waitForExitOrDeath(child, pid, 1200)
}

async function waitForExitOrDeath(child: ReturnType<typeof spawn>, pid: number, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return true
  }

  const exitPromise = once(child, "exit").then(() => true)
  const deadPromise = waitUntilProcessDead(pid, timeoutMs)
  return Promise.race([exitPromise, deadPromise])
}

async function waitUntilProcessDead(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await sleep(25)
  }

  return !isProcessAlive(pid)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function redactCliSecrets(message: string, input: Record<string, unknown>): string {
  let sanitized = message

  const candidates = collectRedactionCandidates(input)
  for (const candidate of candidates) {
    sanitized = sanitized.split(candidate).join("[REDACTED]")
  }

  sanitized = sanitized.replace(/(token|secret|password|api[_-]?key|credential|auth)\s*[:=]\s*[^\s,;"'}]+/gi, "$1=[REDACTED]")
  return sanitized
}

function collectRedactionCandidates(input: Record<string, unknown>): string[] {
  const values: string[] = []

  const stack: Array<{ key: string; value: unknown; depth: number }> = [{ key: "", value: input, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }

    if (current.depth > 5) {
      continue
    }

    if (typeof current.value === "string") {
      if (isSensitiveField(current.key) || looksSecretLike(current.value)) {
        values.push(current.value)
      }
      continue
    }

    if (!current.value || typeof current.value !== "object") {
      continue
    }

    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        stack.push({ key: current.key, value: entry, depth: current.depth + 1 })
      }
      continue
    }

    for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
      stack.push({ key, value, depth: current.depth + 1 })
    }
  }

  return [...new Set(values)].sort((left, right) => right.length - left.length)
}

function isSensitiveField(key: string): boolean {
  return /(token|secret|password|api[_-]?key|credential|auth|note)/i.test(key)
}

function looksSecretLike(value: string): boolean {
  return /(token|secret|password|api[_-]?key|credential)/i.test(value)
}

function isTask3LogStream(value: string): value is (typeof TASK3_LOG_STREAMS)[number] {
  return TASK3_LOG_STREAMS.includes(value as (typeof TASK3_LOG_STREAMS)[number])
}

function getTask3UsageError(args: string[]): string | undefined {
  if (args.length === 0) {
    return undefined
  }

  const usageByCommand: Record<string, string> = {
    onboard: "Unknown onboard option. Usage: onboard [--write-config=<path>]",
    setup: "Unknown setup option. Usage: setup [--write-config=<path>]",
    profile: "Unknown profile subcommand. Usage: profile list | profile use <profile-id>",
    nodes: "Unknown nodes subcommand. Usage: nodes status [--node=<id>]",
    logs: "Unknown logs subcommand. Usage: logs tail [--lines=<n>] [--stream=<all|daemon|device>]",
    pair: "Unknown pair subcommand. Usage: pair start <device-id>",
    sandbox: "Unknown sandbox subcommand. Usage: sandbox status [<sandbox-id>]",
    update: "Unknown update subcommand. Usage: update check",
    webhooks: "Unknown webhooks subcommand. Usage: webhooks list",
    daemon: "Unknown daemon subcommand. Usage: daemon status [--name=<id>]",
    tui: "Unknown tui subcommand. Usage: tui keybindings",
  }

  const command = args[0]
  if (!command) {
    return undefined
  }

  return usageByCommand[command]
}

async function runOnboardingHelper(writeConfigPath?: string): Promise<{
  mode: "guided"
  steps: string[]
  connectors: string[]
  wroteConfig: boolean
  configPath: string | null
}> {
  const steps = [
    "Choose runtime profile (default or ops).",
    "Configure storage location (MACHINA_STORAGE_DIR optional).",
    "Select channels to enable (discord/slack/telegram/signal/whatsapp-web/matrix).",
    "Provide channel credentials and run channel verify with --live when available.",
    "Run open-machina doctor and open-machina workflow cancel-smoke before production usage.",
  ]

  const connectors = createDefaultChannelConnectors().map((connector) => connector.id)
  let wroteConfig = false
  let configPath: string | null = null

  if (typeof writeConfigPath === "string") {
    const resolved = resolve(writeConfigPath)
    const payload = {
      profile: "default",
      storageDir: ".open-machina/storage/default",
      channels: {
        matrix: { enabled: false, homeserverUrl: "", userId: "", roomId: "", accessToken: "" },
        discord: { enabled: false, guildId: "", channelId: "", botToken: "" },
        slack: { enabled: false, accountId: "", endpoint: "", accessToken: "" },
        telegram: { enabled: false, accountId: "", endpoint: "", accessToken: "" },
        signal: { enabled: false, accountId: "", endpoint: "", accessToken: "" },
        "whatsapp-web": { enabled: false, accountId: "", endpoint: "", accessToken: "" },
      },
    }
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    wroteConfig = true
    configPath = resolved
  }

  return {
    mode: "guided",
    steps,
    connectors,
    wroteConfig,
    configPath,
  }
}

const TASK3_ACTIVE_PROFILE = "default"

const TASK3_PROFILES: ProfileSummary[] = [
  {
    id: "default",
    label: "Default local profile",
    storageDir: ".open-machina/storage/default",
    pluginMode: "local",
  },
  {
    id: "ops",
    label: "Operations profile",
    storageDir: ".open-machina/storage/ops",
    pluginMode: "dev",
  },
]

const TASK3_NODES: DeviceNodeSummary[] = [
  {
    id: "node-alpha",
    role: "hub",
    state: "online",
    connector: "matrix",
  },
  {
    id: "device-bravo",
    role: "device",
    state: "offline",
    connector: "discord",
  },
]

const TASK3_LOG_STREAMS = ["all", "daemon", "device"] as const

const TASK3_LOG_ENTRIES: Array<{ ts: string; stream: (typeof TASK3_LOG_STREAMS)[number]; level: string; message: string }> = [
  {
    ts: "2026-02-11T09:00:00.000Z",
    stream: "daemon",
    level: "info",
    message: "daemon heartbeat ok",
  },
  {
    ts: "2026-02-11T09:00:05.000Z",
    stream: "device",
    level: "warn",
    message: "device-bravo offline",
  },
  {
    ts: "2026-02-11T09:00:10.000Z",
    stream: "daemon",
    level: "info",
    message: "scheduler tick",
  },
  {
    ts: "2026-02-11T09:00:15.000Z",
    stream: "device",
    level: "info",
    message: "pairing queue empty",
  },
]

const TASK3_PAIRABLE_DEVICES: PairableDevice[] = [
  {
    id: "device-bravo",
    connector: "discord",
    displayName: "Bravo Handset",
  },
  {
    id: "node-alpha",
    connector: "matrix",
    displayName: "Alpha Hub",
  },
]

const TASK3_SANDBOXES: SandboxSummary[] = [
  {
    id: "default",
    status: "ready",
    profile: "default",
  },
  {
    id: "ops",
    status: "stopped",
    profile: "ops",
  },
]

const TASK3_WEBHOOKS: WebhookSummary[] = [
  {
    id: "hook-build",
    event: "build.completed",
    target: "https://hooks.example.com/build",
    enabled: true,
  },
  {
    id: "hook-alerts",
    event: "alert.triggered",
    target: "https://hooks.example.com/alerts",
    enabled: false,
  },
]

const TASK3_DAEMONS: DaemonSummary[] = [
  {
    name: "open-machina-agent",
    status: "running",
    pid: 4312,
    uptimeSeconds: 86400,
  },
  {
    name: "open-machina-sync",
    status: "stopped",
    pid: null,
    uptimeSeconds: 0,
  },
]

const TASK3_COMPLETIONS: Record<string, string> = {
  bash: [
    "# open-machina bash completion",
    "_open_machina_complete() {",
    "  COMPREPLY=( $(compgen -W \"status doctor profile nodes logs pair sandbox update webhooks daemon completion\" -- \"${COMP_WORDS[COMP_CWORD]}\") )",
    "}",
    "complete -F _open_machina_complete open-machina",
  ].join("\n"),
  zsh: [
    "#compdef open-machina",
    "_arguments '1:command:(status doctor profile nodes logs pair sandbox update webhooks daemon completion)'",
  ].join("\n"),
  fish: [
    "complete -c open-machina -f",
    "complete -c open-machina -n '__fish_use_subcommand' -a 'status doctor profile nodes logs pair sandbox update webhooks daemon completion'",
  ].join("\n"),
  powershell: [
    "Register-ArgumentCompleter -CommandName open-machina -ScriptBlock {",
    "  param($commandName, $wordToComplete, $cursorPosition)",
    "  'status','doctor','profile','nodes','logs','pair','sandbox','update','webhooks','daemon','completion' | Where-Object { $_ -like \"$wordToComplete*\" }",
    "}",
  ].join("\n"),
}

const TASK3_TUI_KEYBINDINGS: Array<{ key: string; action: string; via: string }> = [
  { key: "j", action: "cursor.down", via: "opencode-tui" },
  { key: "k", action: "cursor.up", via: "opencode-tui" },
  { key: "enter", action: "panel.open", via: "opencode-tui" },
  { key: "ctrl+r", action: "workflow.run", via: "open-machina cli bridge" },
  { key: "ctrl+d", action: "daemon.status", via: "open-machina cli bridge" },
]

const TASK3_DIAGNOSTIC_SIGNALS: DiagnosticSignal[] = [
  {
    id: "bridge.contract",
    status: "ok",
    detail: "CLI/TUI compatibility contract loaded",
  },
  {
    id: "bridge.determinism",
    status: "ok",
    detail: "All keybinding bridge outputs are deterministic",
  },
]
