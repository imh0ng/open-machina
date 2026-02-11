import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createDefaultChannelConnectors } from "./connectors"
import { ensureStorageInitialized } from "./storage"

export const AUDIT_LOG_FILE_NAME = "audit-log.jsonl"
export const MAINTENANCE_MARKER_FILE_NAME = "maintenance-marker.txt"

export type ToolCategory = "runtime" | "channel" | "storage"
export type PermissionClass = "safe" | "privileged"

export type PermissionState = {
  privilegedApproved: boolean
}

export type ToolExecutionRequest<Input> = {
  input: Input
  actor: string
  operationId: string
  permissionState: PermissionState
  storageDir?: string
  env?: NodeJS.ProcessEnv
}

export type ElevatedAuditRecord = {
  eventType: "PRIVILEGED_ACTION"
  operationId: string
  actor: string
  timestamp: string
  action: string
  decision: "approved" | "denied"
  category: ToolCategory
  permissionClass: PermissionClass
  status: "succeeded" | "failed" | "blocked"
  inputKeys: string[]
  denialReason?: "privileged-approval-required" | "invalid-privileged-context"
}

export type ToolExecutionResult<Output> = {
  output: Output
  auditRecord?: ElevatedAuditRecord
}

export type ToolDefinition<Input, Output> = {
  readonly id: string
  readonly category: ToolCategory
  readonly permissionClass: PermissionClass
  readonly metadata: ToolMetadata
  run: (request: ToolExecutionRequest<Input>) => Promise<Output>
}

export type ToolMetadata = {
  displayName: string
  description: string
  deterministic: boolean
  capabilities: string[]
}

export type ToolSummary = {
  id: string
  category: ToolCategory
  permissionClass: PermissionClass
}

export type ToolMetadataRecord = {
  id: string
  category: ToolCategory
  permissionClass: PermissionClass
  metadata: ToolMetadata
}

export type ToolMetadataSummary = {
  total: number
  deterministicCount: number
  categories: ToolCategory[]
}

export class ToolPolicyError extends Error {
  readonly code: string
  readonly toolId: string
  readonly requiredPermissionClass: PermissionClass

  constructor(toolId: string, requiredPermissionClass: PermissionClass, code = "POLICY_DENIED", message?: string) {
    super(message ?? `Policy denied for action '${toolId}': explicit privileged approval is required`)
    this.name = "ToolPolicyError"
    this.code = code
    this.toolId = toolId
    this.requiredPermissionClass = requiredPermissionClass
  }
}

export class ToolRuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ToolRuntimeError"
    this.code = code
  }
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition<unknown, unknown>>()

  register<Input, Output>(definition: ToolDefinition<Input, Output>): void {
    if (this.definitions.has(definition.id)) {
      throw new ToolRuntimeError("TOOL_ALREADY_REGISTERED", `Tool already registered: ${definition.id}`)
    }

    this.definitions.set(definition.id, definition as ToolDefinition<unknown, unknown>)
  }

  listTools(): ToolSummary[] {
    return [...this.definitions.values()]
      .map((definition) => ({
        id: definition.id,
        category: definition.category,
        permissionClass: definition.permissionClass,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  getToolMetadata(toolId: string): ToolMetadataRecord | undefined {
    const definition = this.definitions.get(toolId)
    if (!definition) {
      return undefined
    }

    return {
      id: definition.id,
      category: definition.category,
      permissionClass: definition.permissionClass,
      metadata: {
        displayName: definition.metadata.displayName,
        description: definition.metadata.description,
        deterministic: definition.metadata.deterministic,
        capabilities: [...definition.metadata.capabilities],
      },
    }
  }

  listToolMetadata(): ToolMetadataRecord[] {
    return [...this.definitions.values()]
      .map((definition) => ({
        id: definition.id,
        category: definition.category,
        permissionClass: definition.permissionClass,
        metadata: {
          displayName: definition.metadata.displayName,
          description: definition.metadata.description,
          deterministic: definition.metadata.deterministic,
          capabilities: [...definition.metadata.capabilities].sort(),
        },
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  async execute<Input, Output>(toolId: string, request: ToolExecutionRequest<Input>): Promise<ToolExecutionResult<Output>> {
    const definition = this.definitions.get(toolId) as ToolDefinition<Input, Output> | undefined
    if (!definition) {
      throw new ToolRuntimeError("TOOL_NOT_FOUND", `Tool not found: ${toolId}`)
    }

    if (definition.permissionClass === "privileged") {
      if (!hasValidPrivilegedContext(request)) {
        await appendPrivilegedAuditRecord(definition, request, "blocked", "denied", "invalid-privileged-context")
        throw new ToolPolicyError(
          definition.id,
          definition.permissionClass,
          "POLICY_INVALID_CONTEXT",
          `Policy denied for action '${definition.id}': invalid privileged context (actor and operationId must be non-empty and safe)`,
        )
      }

      if (!request.permissionState.privilegedApproved) {
        await appendPrivilegedAuditRecord(definition, request, "blocked", "denied", "privileged-approval-required")
        throw new ToolPolicyError(definition.id, definition.permissionClass)
      }
    }

    let auditRecord: ElevatedAuditRecord | undefined

    try {
      const output = await definition.run(request)
      if (definition.permissionClass === "privileged") {
        auditRecord = await appendPrivilegedAuditRecord(definition, request, "succeeded", "approved")
      }
      return { output, auditRecord }
    } catch (error) {
      if (definition.permissionClass === "privileged") {
        auditRecord = await appendPrivilegedAuditRecord(definition, request, "failed", "approved")
      }
      throw sanitizeToolExecutionError(error, request.input)
    }
  }
}

export function createMachinaToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()

  registry.register<{}, { ok: true; runtime: "open-machina" }>({
    id: "runtime.ping",
    category: "runtime",
    permissionClass: "safe",
    metadata: {
      displayName: "Runtime Ping",
      description: "Returns deterministic runtime heartbeat.",
      deterministic: true,
      capabilities: ["health", "runtime"],
    },
    run: async () => ({ ok: true, runtime: "open-machina" }),
  })

  registry.register<{}, { tools: ToolMetadataRecord[]; summary: ToolMetadataSummary }>({
    id: "tool.metadata",
    category: "runtime",
    permissionClass: "safe",
    metadata: {
      displayName: "Tool Metadata Store",
      description: "Returns deterministic metadata for all registered tools.",
      deterministic: true,
      capabilities: ["metadata", "tools"],
    },
    run: async () => {
      const tools = registry.listToolMetadata()
      const categories = new Set<ToolCategory>()
      let deterministicCount = 0

      for (const tool of tools) {
        categories.add(tool.category)
        if (tool.metadata.deterministic) {
          deterministicCount += 1
        }
      }

      return {
        tools,
        summary: {
          total: tools.length,
          deterministicCount,
          categories: [...categories].sort(),
        },
      }
    },
  })

  registry.register<{ filePath?: string }, { toolId: "lsp.diagnostics"; diagnostics: Array<{ severity: string; message: string; filePath: string }> }>({
    id: "lsp.diagnostics",
    category: "runtime",
    permissionClass: "safe",
    metadata: {
      displayName: "LSP Diagnostics",
      description: "Returns deterministic diagnostics payload for capability parity checks.",
      deterministic: true,
      capabilities: ["lsp", "diagnostics"],
    },
    run: async ({ input }) => ({
      toolId: "lsp.diagnostics",
      diagnostics: [
        {
          severity: "information",
          message: "LSP bridge registered for deterministic runtime surface.",
          filePath: normalizeFilePath(input.filePath),
        },
      ],
    }),
  })

  registry.register<{}, { oauth: { supported: boolean; flow: string; provider: string; tokenStorage: string } }>({
    id: "mcp.oauth.status",
    category: "runtime",
    permissionClass: "safe",
    metadata: {
      displayName: "MCP OAuth Capability",
      description: "Reports deterministic MCP OAuth support posture.",
      deterministic: true,
      capabilities: ["mcp", "oauth"],
    },
    run: async ({ env }) => ({
      oauth: {
        supported: env?.MACHINA_MCP_OAUTH_ENABLED === "true",
        flow: env?.MACHINA_MCP_OAUTH_ENABLED === "true" ? "device-code" : "not-configured",
        provider: env?.MACHINA_MCP_OAUTH_ENABLED === "true" ? "deterministic-mcp" : "none",
        tokenStorage: env?.MACHINA_MCP_OAUTH_ENABLED === "true" ? "in-memory" : "none",
      },
    }),
  })

  registry.register<{}, { connectors: string[] }>({
    id: "channel.list-connectors",
    category: "channel",
    permissionClass: "safe",
    metadata: {
      displayName: "Channel Connectors",
      description: "Lists available channel connector ids.",
      deterministic: true,
      capabilities: ["channels", "connectors"],
    },
    run: async () => ({
      connectors: createDefaultChannelConnectors()
        .map((connector) => connector.id)
        .sort(),
    }),
  })

  registry.register<{ note?: string }, { status: "written"; markerPath: string }>({
    id: "storage.write-maintenance-marker",
    category: "storage",
    permissionClass: "privileged",
    metadata: {
      displayName: "Write Maintenance Marker",
      description: "Writes a maintenance marker in storage for audit checks.",
      deterministic: true,
      capabilities: ["storage", "audit"],
    },
    run: async ({ input, storageDir, env }) => {
      const storage = await ensureStorageInitialized(storageDir, env)
      const markerPath = join(storage.rootDir, MAINTENANCE_MARKER_FILE_NAME)
      const note = typeof input.note === "string" && input.note.trim().length > 0 ? input.note.trim() : "maintenance"
      await writeFile(markerPath, `${note}\n`, "utf8")
      return {
        status: "written",
        markerPath,
      }
    },
  })

  return registry
}

async function appendPrivilegedAuditRecord<Input, Output>(
  definition: ToolDefinition<Input, Output>,
  request: ToolExecutionRequest<Input>,
  status: "succeeded" | "failed" | "blocked",
  decision: "approved" | "denied",
  denialReason?: "privileged-approval-required" | "invalid-privileged-context",
): Promise<ElevatedAuditRecord> {
  const storage = await ensureStorageInitialized(request.storageDir, request.env)
  const record: ElevatedAuditRecord = {
    eventType: "PRIVILEGED_ACTION",
    operationId: request.operationId,
    actor: request.actor,
    timestamp: new Date().toISOString(),
    action: definition.id,
    decision,
    category: definition.category,
    permissionClass: definition.permissionClass,
    status,
    inputKeys: extractInputKeys(request.input),
    denialReason,
  }

  const auditPath = join(storage.rootDir, AUDIT_LOG_FILE_NAME)
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, "utf8")
  return record
}

function extractInputKeys(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return []
  }

  return Object.keys(input as Record<string, unknown>).sort()
}

function hasValidPrivilegedContext<Input>(request: ToolExecutionRequest<Input>): boolean {
  return isSafeAuditIdentifier(request.actor) && isSafeAuditIdentifier(request.operationId)
}

function isSafeAuditIdentifier(value: unknown): boolean {
  if (typeof value !== "string") {
    return false
  }

  const trimmed = value.trim()
  return trimmed.length >= 3 && trimmed.length <= 128 && /^[a-zA-Z0-9._:-]+$/.test(trimmed)
}

function sanitizeToolExecutionError(error: unknown, input: unknown): Error {
  const base = error instanceof Error ? error : new Error(String(error))
  const redactedMessage = redactSecrets(base.message, input)

  if (base instanceof ToolRuntimeError) {
    return new ToolRuntimeError(base.code, redactedMessage)
  }

  const sanitized = new Error(redactedMessage)
  sanitized.name = base.name
  return sanitized
}

function redactSecrets(message: string, input: unknown): string {
  let sanitized = message

  for (const secret of collectSensitiveValues(input)) {
    if (secret.length >= 3) {
      sanitized = sanitized.split(secret).join("[REDACTED]")
    }
  }

  sanitized = sanitized.replace(/(token|secret|password|api[_-]?key|credential|auth)\s*[:=]\s*[^\s,;"'}]+/gi, "$1=[REDACTED]")
  return sanitized
}

function collectSensitiveValues(input: unknown): string[] {
  const collected = new Set<string>()
  const stack: Array<{ key: string; value: unknown; depth: number }> = [{ key: "", value: input, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }

    if (current.depth > 5) {
      continue
    }

    const { key, value, depth } = current
    if (typeof value === "string") {
      if (isSensitiveKey(key) || looksSensitiveValue(value)) {
        collected.add(value)
      }
      continue
    }

    if (!value || typeof value !== "object") {
      continue
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        stack.push({ key, value: entry, depth: depth + 1 })
      }
      continue
    }

    for (const [nextKey, nextValue] of Object.entries(value as Record<string, unknown>)) {
      stack.push({ key: nextKey, value: nextValue, depth: depth + 1 })
    }
  }

  return [...collected].sort((left, right) => right.length - left.length)
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|password|api[_-]?key|credential|auth|note)/i.test(key)
}

function looksSensitiveValue(value: string): boolean {
  return /(token|secret|password|api[_-]?key|credential)/i.test(value)
}

function normalizeFilePath(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown"
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : "unknown"
}
