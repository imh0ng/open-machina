import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  checkSessionIntegrity,
  getStoragePaths,
  runMigrations,
  type SessionRecord,
} from "./storage"

test("migration happy path preserves session fixture from v1 to v2", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-storage-happy-"))

  try {
    const paths = getStoragePaths(storageDir)
    const fixture: SessionRecord[] = [
      {
        id: "session-1",
        updatedAt: "2026-02-11T00:00:00.000Z",
        payload: { topic: "alpha" },
      },
    ]

    await writeFile(
      paths.schemaStateFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          status: "ready",
          targetVersion: null,
          migrationId: null,
          backupPath: null,
          updatedAt: "2026-02-11T00:00:00.000Z",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    )
    await writeFile(paths.sessionsFile, `${JSON.stringify(fixture[0])}\n`, "utf8")

    const result = await runMigrations({ storageDir })
    const migratedLines = (await readFile(paths.sessionsFile, "utf8")).trim().split("\n")
    const migrated = migratedLines.map((line) => JSON.parse(line)) as SessionRecord[]

    expect(result.status).toBe("migrated")
    expect(result.fromVersion).toBe(1)
    expect(result.toVersion).toBe(2)
    expect(result.applied).toEqual(["v1-to-v2"])
    expect(migrated).toHaveLength(1)
    expect(migrated[0]?.id).toBe("session-1")
    expect(typeof migrated[0]?.checksum).toBe("string")
    expect((migrated[0]?.checksum ?? "").length).toBeGreaterThan(0)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("interrupted migration recovers cleanly on next run", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-storage-interrupt-"))

  try {
    const paths = getStoragePaths(storageDir)
    const fixture: SessionRecord = {
      id: "session-2",
      updatedAt: "2026-02-11T00:00:00.000Z",
      payload: { topic: "beta" },
    }

    await writeFile(
      paths.schemaStateFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          status: "ready",
          targetVersion: null,
          migrationId: null,
          backupPath: null,
          updatedAt: "2026-02-11T00:00:00.000Z",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    )
    await writeFile(paths.sessionsFile, `${JSON.stringify(fixture)}\n`, "utf8")

    let interruptedCode = ""
    try {
      await runMigrations({ storageDir, interruptAfterStateWrite: true })
    } catch (error) {
      interruptedCode = (error as { code?: string }).code ?? ""
    }
    expect(interruptedCode).toBe("MIGRATION_FAILED")

    const recovered = await runMigrations({ storageDir })
    const lines = (await readFile(paths.sessionsFile, "utf8")).trim().split("\n")
    const record = JSON.parse(lines[0] ?? "{}") as SessionRecord

    expect(recovered.status).toBe("migrated")
    expect(recovered.recovered).toBe(true)
    expect(recovered.applied).toEqual(["v1-to-v2"])
    expect(record.id).toBe("session-2")
    expect(typeof record.checksum).toBe("string")
    expect((record.checksum ?? "").length).toBeGreaterThan(0)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("interrupted migration with missing backup recovers by resetting state and rerunning", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-storage-recover-no-backup-"))

  try {
    const paths = getStoragePaths(storageDir)
    const fixture: SessionRecord = {
      id: "session-4",
      updatedAt: "2026-02-11T00:00:00.000Z",
      payload: { topic: "delta" },
    }

    await writeFile(
      paths.schemaStateFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          status: "migrating",
          targetVersion: 2,
          migrationId: "v1-to-v2",
          backupPath: null,
          updatedAt: "2026-02-11T00:00:00.000Z",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    )
    await writeFile(paths.sessionsFile, `${JSON.stringify(fixture)}\n`, "utf8")

    const recovered = await runMigrations({ storageDir })
    const lines = (await readFile(paths.sessionsFile, "utf8")).trim().split("\n")
    const record = JSON.parse(lines[0] ?? "{}") as SessionRecord

    expect(recovered.status).toBe("migrated")
    expect(recovered.recovered).toBe(true)
    expect(recovered.applied).toEqual(["v1-to-v2"])
    expect(record.id).toBe("session-4")
    expect(typeof record.checksum).toBe("string")
    expect((record.checksum ?? "").length).toBeGreaterThan(0)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("interrupted migration without backup fails deterministically when session data is invalid", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-storage-recover-invalid-"))

  try {
    const paths = getStoragePaths(storageDir)

    await writeFile(
      paths.schemaStateFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          status: "migrating",
          targetVersion: 2,
          migrationId: "v1-to-v2",
          backupPath: null,
          updatedAt: "2026-02-11T00:00:00.000Z",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    )
    await writeFile(paths.sessionsFile, "not-json\n", "utf8")

    let code = ""
    let message = ""

    try {
      await runMigrations({ storageDir })
    } catch (error) {
      const typed = error as { code?: string; message?: string }
      code = typed.code ?? ""
      message = typed.message ?? ""
    }

    expect(code).toBe("MIGRATION_RECOVERY_FAILED")
    expect(message).toBe("Interrupted migration cannot recover without backup because session data is invalid")
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})

test("integrity check reports healthy for valid v2 data", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "machina-storage-integrity-"))

  try {
    const paths = getStoragePaths(storageDir)
    await writeFile(
      paths.schemaStateFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          status: "ready",
          targetVersion: null,
          migrationId: null,
          backupPath: null,
          updatedAt: "2026-02-11T00:00:00.000Z",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    )

    await writeFile(
      paths.sessionsFile,
      `${JSON.stringify({ id: "session-3", updatedAt: "2026-02-11T00:00:00.000Z", payload: { topic: "gamma" } })}\n`,
      "utf8",
    )

    await runMigrations({ storageDir })
    const report = await checkSessionIntegrity(storageDir)

    expect(report.healthy).toBe(true)
    expect(report.schemaVersion).toBe(2)
    expect(report.issueCount).toBe(0)
  } finally {
    await rm(storageDir, { recursive: true, force: true })
  }
})
