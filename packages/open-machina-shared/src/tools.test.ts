import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AUDIT_LOG_FILE_NAME,
  MAINTENANCE_MARKER_FILE_NAME,
  ToolRegistry,
  ToolPolicyError,
  ToolRuntimeError,
  createMachinaToolRegistry,
} from "./tools"

test("privileged tool denies without explicit approval and records denied audit", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-tools-denied-"))

  try {
    const registry = createMachinaToolRegistry()
    let code = ""
    let message = ""

    try {
      await registry.execute("storage.write-maintenance-marker", {
        input: { note: "token-secret-123" },
        actor: "test-agent",
        operationId: "op-tools-denied-0001",
        permissionState: { privilegedApproved: false },
        storageDir,
      })
    } catch (error) {
      const normalized = error as ToolPolicyError
      code = normalized.code
      message = normalized.message
    }

    expect(code).toBe("POLICY_DENIED")
    expect(message).toBe("Policy denied for action 'storage.write-maintenance-marker': explicit privileged approval is required")

    expect(await fileExists(join(storageDir, MAINTENANCE_MARKER_FILE_NAME))).toBe(false)

    const auditLines = (await readFile(join(storageDir, AUDIT_LOG_FILE_NAME), "utf8")).trim().split("\n")
    expect(auditLines).toHaveLength(1)
    const audit = JSON.parse(auditLines[0] ?? "{}") as {
      operationId: string
      actor: string
      action: string
      decision: string
      status: string
      inputKeys: string[]
      timestamp: string
    }
    expect(audit.operationId).toBe("op-tools-denied-0001")
    expect(audit.actor).toBe("test-agent")
    expect(audit.action).toBe("storage.write-maintenance-marker")
    expect(audit.decision).toBe("denied")
    expect(audit.status).toBe("blocked")
    expect(audit.inputKeys).toEqual(["note"])
    expect(Date.parse(audit.timestamp)).toBeGreaterThan(0)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("privileged tool approved path writes marker and appends approved audit without secrets", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-tools-approved-"))
  const secretNote = "token-super-secret-987"

  try {
    const registry = createMachinaToolRegistry()
    const result = await registry.execute<{ note: string }, { status: string; markerPath: string }>(
      "storage.write-maintenance-marker",
      {
        input: { note: secretNote },
        actor: "test-agent",
        operationId: "op-tools-approved-0001",
        permissionState: { privilegedApproved: true },
        storageDir,
      },
    )

    expect(result.output.status).toBe("written")
    expect(await fileExists(result.output.markerPath)).toBe(true)

    const auditRaw = await readFile(join(storageDir, AUDIT_LOG_FILE_NAME), "utf8")
    const auditLines = auditRaw.trim().split("\n")
    expect(auditLines).toHaveLength(1)
    const audit = JSON.parse(auditLines[0] ?? "{}") as {
      operationId: string
      actor: string
      action: string
      decision: string
      status: string
      inputKeys: string[]
      timestamp: string
    }

    expect(audit.operationId).toBe("op-tools-approved-0001")
    expect(audit.actor).toBe("test-agent")
    expect(audit.action).toBe("storage.write-maintenance-marker")
    expect(audit.decision).toBe("approved")
    expect(audit.status).toBe("succeeded")
    expect(audit.inputKeys).toEqual(["note"])
    expect(Date.parse(audit.timestamp)).toBeGreaterThan(0)
    expect(auditRaw.includes(secretNote)).toBe(false)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("safe tool runs without privileged approval", async () => {
  const registry = createMachinaToolRegistry()
  const result = await registry.execute("runtime.ping", {
    input: {},
    actor: "test-agent",
    operationId: "op-tools-safe-0001",
    permissionState: { privilegedApproved: false },
  })

  expect(result.output).toEqual({ ok: true, runtime: "open-machina" })
})

test("tool list metadata includes lsp capability", async () => {
  const registry = createMachinaToolRegistry()
  const tools = registry.listTools()

  expect(tools.some((tool) => tool.id.includes("lsp"))).toBe(true)
  expect(tools.some((tool) => tool.id === "lsp.diagnostics")).toBe(true)
})

test("tool.metadata returns deterministic metadata summary", async () => {
  const registry = createMachinaToolRegistry()
  const result = await registry.execute<{}, { summary: { total: number; deterministicCount: number }; tools: Array<{ id: string }> }>(
    "tool.metadata",
    {
      input: {},
      actor: "test-agent",
      operationId: "op-tools-metadata-0001",
      permissionState: { privilegedApproved: false },
    },
  )

  expect(result.output.summary.total).toBeGreaterThan(0)
  expect(result.output.summary.deterministicCount).toBeGreaterThan(0)
  expect(result.output.tools.some((tool) => tool.id === "runtime.ping")).toBe(true)
  expect(result.output.tools.some((tool) => tool.id === "lsp.diagnostics")).toBe(true)
})

test("mcp.oauth.status returns deterministic shape", async () => {
  const registry = createMachinaToolRegistry()
  const result = await registry.execute<{}, { oauth: { supported: boolean; flow: string; provider: string; tokenStorage: string } }>(
    "mcp.oauth.status",
    {
      input: {},
      actor: "test-agent",
      operationId: "op-tools-oauth-0001",
      permissionState: { privilegedApproved: false },
      env: { MACHINA_MCP_OAUTH_ENABLED: "true" },
    },
  )

  expect(result.output.oauth.supported).toBe(true)
  expect(result.output.oauth.flow).toBe("device-code")
  expect(result.output.oauth.provider).toBe("deterministic-mcp")
  expect(result.output.oauth.tokenStorage).toBe("in-memory")
})

test("unknown tool id fails with TOOL_NOT_FOUND", async () => {
  const registry = createMachinaToolRegistry()
  let code = ""

  try {
    await registry.execute("tool.missing", {
      input: {},
      actor: "test-agent",
      operationId: "op-tools-missing-0001",
      permissionState: { privilegedApproved: false },
    })
  } catch (error) {
    const normalized = error as ToolRuntimeError
    code = normalized.code
  }

  expect(code).toBe("TOOL_NOT_FOUND")
})

test("privileged tool denies invalid boundary context with deterministic audit trail", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-tools-invalid-context-"))

  try {
    const registry = createMachinaToolRegistry()
    let code = ""
    let message = ""

    try {
      await registry.execute("storage.write-maintenance-marker", {
        input: { note: "maintenance" },
        actor: "bad actor",
        operationId: "op tools invalid",
        permissionState: { privilegedApproved: true },
        storageDir,
      })
    } catch (error) {
      const normalized = error as ToolPolicyError
      code = normalized.code
      message = normalized.message
    }

    expect(code).toBe("POLICY_INVALID_CONTEXT")
    expect(message).toBe(
      "Policy denied for action 'storage.write-maintenance-marker': invalid privileged context (actor and operationId must be non-empty and safe)",
    )

    const auditLines = (await readFile(join(storageDir, AUDIT_LOG_FILE_NAME), "utf8")).trim().split("\n")
    expect(auditLines).toHaveLength(1)
    const audit = JSON.parse(auditLines[0] ?? "{}") as { decision: string; status: string; denialReason?: string }
    expect(audit.decision).toBe("denied")
    expect(audit.status).toBe("blocked")
    expect(audit.denialReason).toBe("invalid-privileged-context")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("privileged runtime errors are redacted before surfacing to callers", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-tools-redacted-error-"))
  const secret = "token-super-secret-value"

  try {
    const registry = new ToolRegistry()
    registry.register<{ token: string }, { ok: true }>({
      id: "storage.fail-echo",
      category: "storage",
      permissionClass: "privileged",
      metadata: {
        displayName: "Fail Echo",
        description: "Test helper for redaction hardening",
        deterministic: true,
        capabilities: ["test"],
      },
      run: async ({ input }) => {
        throw new ToolRuntimeError("SIM_FAIL", `failure token=${input.token}`)
      },
    })

    let code = ""
    let message = ""
    try {
      await registry.execute("storage.fail-echo", {
        input: { token: secret },
        actor: "test-agent",
        operationId: "op-tools-redacted-0001",
        permissionState: { privilegedApproved: true },
        storageDir,
      })
    } catch (error) {
      const normalized = error as ToolRuntimeError
      code = normalized.code
      message = normalized.message
    }

    expect(code).toBe("SIM_FAIL")
    expect(message).toContain("[REDACTED]")
    expect(message.includes(secret)).toBe(false)

    const auditRaw = await readFile(join(storageDir, AUDIT_LOG_FILE_NAME), "utf8")
    expect(auditRaw.includes(secret)).toBe(false)
    const auditLines = auditRaw.trim().split("\n")
    expect(auditLines).toHaveLength(1)
    const audit = JSON.parse(auditLines[0] ?? "{}") as { status: string; inputKeys: string[] }
    expect(audit.status).toBe("failed")
    expect(audit.inputKeys).toEqual(["token"])
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
