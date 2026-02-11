import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const SESSION_FILE = "sessions.jsonl"
const STATE_FILE = "schema-state.json"
const BACKUP_FILE = "sessions.backup.jsonl"

export const CURRENT_SCHEMA_VERSION = 2

export type SchemaStateStatus = "ready" | "migrating"

export type SchemaState = {
  schemaVersion: number
  status: SchemaStateStatus
  targetVersion: number | null
  migrationId: string | null
  backupPath: string | null
  updatedAt: string
}

export type SessionRecord = {
  id: string
  updatedAt: string
  payload: unknown
  deleted?: boolean
  checksum?: string
}

export type StoragePolicy = {
  source: "explicit" | "env" | "default"
  rootDir: string
}

export type StoragePaths = {
  rootDir: string
  sessionsFile: string
  schemaStateFile: string
  backupFile: string
}

export type MigrationRunOptions = {
  storageDir?: string
  targetVersion?: number
  interruptAfterStateWrite?: boolean
}

export type MigrationRunResult = {
  status: "up-to-date" | "migrated"
  fromVersion: number
  toVersion: number
  recovered: boolean
  applied: string[]
}

export type IntegrityIssue = {
  code: string
  message: string
  line: number | null
}

export type IntegrityReport = {
  healthy: boolean
  schemaVersion: number
  issueCount: number
  issues: IntegrityIssue[]
}

export type CompactionReport = {
  before: number
  after: number
  removed: number
}

export class MachinaStorageError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "MachinaStorageError"
    this.code = code
  }
}

export function resolveStoragePolicy(explicitDir?: string, env: NodeJS.ProcessEnv = process.env): StoragePolicy {
  if (explicitDir && explicitDir.trim().length > 0) {
    return { source: "explicit", rootDir: explicitDir }
  }

  const fromEnv = env.MACHINA_STORAGE_DIR
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return { source: "env", rootDir: fromEnv }
  }

  const home = env.HOME ?? env.USERPROFILE
  if (!home) {
    throw new MachinaStorageError("STORAGE_HOME_MISSING", "Unable to resolve default storage directory without HOME")
  }

  return {
    source: "default",
    rootDir: join(home, ".open-machina", "storage"),
  }
}

export function getStoragePaths(storageDir?: string, env: NodeJS.ProcessEnv = process.env): StoragePaths {
  const policy = resolveStoragePolicy(storageDir, env)

  return {
    rootDir: policy.rootDir,
    sessionsFile: join(policy.rootDir, SESSION_FILE),
    schemaStateFile: join(policy.rootDir, STATE_FILE),
    backupFile: join(policy.rootDir, BACKUP_FILE),
  }
}

export async function ensureStorageInitialized(storageDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<StoragePaths> {
  const paths = getStoragePaths(storageDir, env)
  await mkdir(paths.rootDir, { recursive: true })

  if (!(await fileExists(paths.schemaStateFile))) {
    await writeJsonAtomic(paths.schemaStateFile, createReadyState(CURRENT_SCHEMA_VERSION))
  }

  if (!(await fileExists(paths.sessionsFile))) {
    await writeFile(paths.sessionsFile, "", "utf8")
  }

  return paths
}

export async function runMigrations(options: MigrationRunOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<MigrationRunResult> {
  const paths = await ensureStorageInitialized(options.storageDir, env)
  let state = await readSchemaState(paths)
  const targetVersion = options.targetVersion ?? CURRENT_SCHEMA_VERSION

  if (targetVersion > CURRENT_SCHEMA_VERSION || targetVersion < 1) {
    throw new MachinaStorageError("MIGRATION_TARGET_UNSUPPORTED", `Unsupported schema target version: ${targetVersion}`)
  }

  let recovered = false
  if (state.status === "migrating") {
    await recoverInterruptedMigration(paths, state)
    recovered = true
    state = await readSchemaState(paths)
  }

  if (state.schemaVersion > targetVersion) {
    throw new MachinaStorageError(
      "MIGRATION_DOWNGRADE_BLOCKED",
      `Downgrade is not supported: ${state.schemaVersion} -> ${targetVersion}`,
    )
  }

  const applied: string[] = []
  const fromVersion = state.schemaVersion

  for (let version = state.schemaVersion; version < targetVersion; version += 1) {
    const nextVersion = version + 1
    const migrationId = `v${version}-to-v${nextVersion}`
    const migrate = MIGRATIONS.get(migrationId)

    if (!migrate) {
      throw new MachinaStorageError("MIGRATION_PATH_MISSING", `No migration registered for ${migrationId}`)
    }

    const activeState: SchemaState = {
      schemaVersion: version,
      status: "migrating",
      targetVersion: nextVersion,
      migrationId,
      backupPath: paths.backupFile,
      updatedAt: new Date().toISOString(),
    }

    await writeJsonAtomic(paths.schemaStateFile, activeState)

    try {
      await backupSessions(paths)

      if (options.interruptAfterStateWrite) {
        throw new MachinaStorageError(
          "MIGRATION_INTERRUPTED",
          `Simulated interruption after migration state write for ${migrationId}`,
        )
      }

      await migrate(paths)
      await writeJsonAtomic(paths.schemaStateFile, createReadyState(nextVersion))
      await deleteIfExists(paths.backupFile)
      applied.push(migrationId)
    } catch (error) {
      throw new MachinaStorageError(
        "MIGRATION_FAILED",
        `Migration ${migrationId} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (applied.length === 0) {
    return {
      status: "up-to-date",
      fromVersion,
      toVersion: fromVersion,
      recovered,
      applied,
    }
  }

  return {
    status: "migrated",
    fromVersion,
    toVersion: targetVersion,
    recovered,
    applied,
  }
}

export async function checkSessionIntegrity(storageDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<IntegrityReport> {
  const paths = await ensureStorageInitialized(storageDir, env)
  const state = await readSchemaState(paths)
  const issues: IntegrityIssue[] = []
  const records = await readSessionRecords(paths.sessionsFile)

  records.forEach((record, index) => {
    if (record.id.trim().length === 0) {
      issues.push({ code: "SESSION_ID_EMPTY", message: "Session id must not be empty", line: index + 1 })
    }

    if (record.updatedAt.trim().length === 0) {
      issues.push({ code: "SESSION_UPDATED_AT_EMPTY", message: "Session updatedAt must not be empty", line: index + 1 })
    }

    if (state.schemaVersion >= 2) {
      if (!record.checksum) {
        issues.push({ code: "CHECKSUM_MISSING", message: "Checksum is required for schema v2+", line: index + 1 })
      } else {
        const expected = computeChecksum(record.id, record.updatedAt, record.payload, Boolean(record.deleted))
        if (record.checksum !== expected) {
          issues.push({ code: "CHECKSUM_INVALID", message: "Checksum validation failed", line: index + 1 })
        }
      }
    }
  })

  return {
    healthy: issues.length === 0,
    schemaVersion: state.schemaVersion,
    issueCount: issues.length,
    issues,
  }
}

export async function compactSessions(storageDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<CompactionReport> {
  const paths = await ensureStorageInitialized(storageDir, env)
  const state = await readSchemaState(paths)
  const records = await readSessionRecords(paths.sessionsFile)
  const before = records.length

  const latestById = new Map<string, SessionRecord>()
  for (const record of records) {
    latestById.set(record.id, record)
  }

  const compacted = [...latestById.values()].filter((record) => !record.deleted)
  const normalized = compacted.map((record) => normalizeRecordForSchema(record, state.schemaVersion))
  await writeSessionsAtomic(paths.sessionsFile, normalized)

  return {
    before,
    after: normalized.length,
    removed: before - normalized.length,
  }
}

export async function writeSessionRecords(storageDir: string, records: SessionRecord[]): Promise<void> {
  const paths = await ensureStorageInitialized(storageDir)
  const state = await readSchemaState(paths)
  const normalized = records.map((record) => normalizeRecordForSchema(record, state.schemaVersion))
  await writeSessionsAtomic(paths.sessionsFile, normalized)
}

export async function readSessionRecords(sessionsFile: string): Promise<SessionRecord[]> {
  if (!(await fileExists(sessionsFile))) {
    return []
  }

  const content = await readFile(sessionsFile, "utf8")
  if (content.trim().length === 0) {
    return []
  }

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line) as SessionRecord
      if (typeof parsed.id !== "string" || typeof parsed.updatedAt !== "string") {
        throw new Error("missing required fields")
      }
      return parsed
    } catch (error) {
      throw new MachinaStorageError(
        "SESSION_PARSE_FAILED",
        `Failed to parse session record at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}

export async function readSchemaState(paths: StoragePaths): Promise<SchemaState> {
  const raw = await readFile(paths.schemaStateFile, "utf8")
  const parsed = JSON.parse(raw) as Partial<SchemaState>

  if (typeof parsed.schemaVersion !== "number") {
    throw new MachinaStorageError("SCHEMA_STATE_INVALID", "Schema state is missing schemaVersion")
  }

  if (parsed.status !== "ready" && parsed.status !== "migrating") {
    throw new MachinaStorageError("SCHEMA_STATE_INVALID", "Schema state has invalid status")
  }

  return {
    schemaVersion: parsed.schemaVersion,
    status: parsed.status,
    targetVersion: parsed.targetVersion ?? null,
    migrationId: parsed.migrationId ?? null,
    backupPath: parsed.backupPath ?? null,
    updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
  }
}

function createReadyState(version: number): SchemaState {
  return {
    schemaVersion: version,
    status: "ready",
    targetVersion: null,
    migrationId: null,
    backupPath: null,
    updatedAt: new Date().toISOString(),
  }
}

async function recoverInterruptedMigration(paths: StoragePaths, state: SchemaState): Promise<void> {
  const backupPath = state.backupPath ?? paths.backupFile
  if (!(await fileExists(backupPath))) {
    try {
      await readSessionRecords(paths.sessionsFile)
    } catch {
      throw new MachinaStorageError(
        "MIGRATION_RECOVERY_FAILED",
        "Interrupted migration cannot recover without backup because session data is invalid",
      )
    }

    await writeJsonAtomic(paths.schemaStateFile, createReadyState(state.schemaVersion))
    return
  }

  await copyFileAtomic(backupPath, paths.sessionsFile)
  await writeJsonAtomic(paths.schemaStateFile, createReadyState(state.schemaVersion))
  await deleteIfExists(backupPath)
}

async function backupSessions(paths: StoragePaths): Promise<void> {
  const content = (await fileExists(paths.sessionsFile)) ? await readFile(paths.sessionsFile, "utf8") : ""
  await writeFile(paths.backupFile, content, "utf8")
}

function normalizeRecordForSchema(record: SessionRecord, schemaVersion: number): SessionRecord {
  const base: SessionRecord = {
    id: record.id,
    updatedAt: record.updatedAt,
    payload: record.payload,
    deleted: record.deleted,
  }

  if (schemaVersion >= 2) {
    return {
      ...base,
      checksum: computeChecksum(base.id, base.updatedAt, base.payload, Boolean(base.deleted)),
    }
  }

  return base
}

function computeChecksum(id: string, updatedAt: string, payload: unknown, deleted: boolean): string {
  const serialized = stableStringify({ id, updatedAt, payload, deleted })
  return createHash("sha256").update(serialized).digest("hex")
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`
  }

  return JSON.stringify(value)
}

async function writeSessionsAtomic(path: string, records: SessionRecord[]): Promise<void> {
  const content = records.map((record) => JSON.stringify(record)).join("\n")
  await writeTextAtomic(path, content.length > 0 ? `${content}\n` : "")
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true })

  const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(tempPath, content, "utf8")
  await rename(tempPath, path)
}

async function copyFileAtomic(sourcePath: string, destinationPath: string): Promise<void> {
  const content = await readFile(sourcePath, "utf8")
  await writeTextAtomic(destinationPath, content)
}

async function deleteIfExists(path: string): Promise<void> {
  if (await fileExists(path)) {
    await rm(path)
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const MIGRATIONS = new Map<string, (paths: StoragePaths) => Promise<void>>([
  [
    "v1-to-v2",
    async (paths: StoragePaths) => {
      const sessions = await readSessionRecords(paths.sessionsFile)
      const migrated = sessions.map((record) => normalizeRecordForSchema(record, 2))
      await writeSessionsAtomic(paths.sessionsFile, migrated)
    },
  ],
])
