import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { createNativeSnapshotAdapter, detectBackupOs, runSnapshotCycle } from "./backup"

test("runSnapshotCycle creates one snapshot per day and keeps max retention", async () => {
  const removed: string[] = []
  let seq = 0
  const base = [
    { id: "s1", createdAt: "2026-02-06T10:00:00.000Z", source: "native" },
    { id: "s2", createdAt: "2026-02-07T10:00:00.000Z", source: "native" },
    { id: "s3", createdAt: "2026-02-08T10:00:00.000Z", source: "native" },
    { id: "s4", createdAt: "2026-02-09T10:00:00.000Z", source: "native" },
    { id: "s5", createdAt: "2026-02-10T10:00:00.000Z", source: "native" },
  ]

  const result = await runSnapshotCycle(
    {
      os: "linux",
      create: async () => {
        seq += 1
        return { id: `new-${seq}`, createdAt: "2026-02-11T10:00:00.000Z", source: "native" }
      },
      list: async () => [...base],
      remove: async (id) => {
        removed.push(id)
      },
    },
    { cadence: "daily", perDay: 1, retention: 5 },
    new Date("2026-02-11T13:00:00.000Z"),
  )

  expect(result.created?.id).toBe("new-1")
  expect(result.retained.length).toBe(5)
  expect(removed.length).toBe(1)
  expect(removed[0]).toBe("s1")
})

test("detectBackupOs maps platform values", () => {
  expect(detectBackupOs("darwin")).toBe("macos")
  expect(detectBackupOs("win32")).toBe("windows")
  expect(detectBackupOs("linux")).toBe("linux")
})

test("createNativeSnapshotAdapter uses macOS tmutil commands", async () => {
  const calls: string[][] = []
  const dir = await mkdtemp(path.join(os.tmpdir(), "open-machina-backup-"))
  const metadataPath = path.join(dir, "meta.json")
  const adapter = createNativeSnapshotAdapter({
    os: "macos",
    rootPath: "/Users/me/workspace",
    metadataPath,
    now: () => new Date("2026-02-11T10:00:00.000Z"),
    exec: async (cmd) => {
      calls.push(cmd)
      if (cmd[1] === "localsnapshot") {
        return {
          exitCode: 0,
          stdout: "Created local snapshot with date: 2026-02-11-100000",
          stderr: "",
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  })

  const created = await adapter.create()
  expect(created.nativeId).toBe("2026-02-11-100000")

  const listed = await adapter.list()
  expect(listed.length).toBe(1)

  await adapter.remove(created.id)
  expect(calls[0]).toEqual(["tmutil", "localsnapshot", "/Users/me/workspace"])
  expect(calls[1]).toEqual(["tmutil", "deletelocalsnapshots", "2026-02-11-100000"])
})

test("createNativeSnapshotAdapter uses linux btrfs commands", async () => {
  const calls: string[][] = []
  const dir = await mkdtemp(path.join(os.tmpdir(), "open-machina-backup-"))
  const metadataPath = path.join(dir, "meta.json")
  const adapter = createNativeSnapshotAdapter({
    os: "linux",
    rootPath: "/var/lib/machina",
    metadataPath,
    now: () => new Date("2026-02-11T10:00:00.000Z"),
    exec: async (cmd) => {
      calls.push(cmd)
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  })

  const created = await adapter.create()
  await adapter.remove(created.id)

  expect(calls[0]).toEqual(["mkdir", "-p", "/var/lib/machina/.open-machina-snapshots"])
  expect(calls[1]?.slice(0, 4)).toEqual(["btrfs", "subvolume", "snapshot", "-r"])
  expect(calls[2]?.slice(0, 3)).toEqual(["btrfs", "subvolume", "delete"])
})

test("createNativeSnapshotAdapter uses windows shadow copy commands", async () => {
  const calls: string[][] = []
  const dir = await mkdtemp(path.join(os.tmpdir(), "open-machina-backup-"))
  const metadataPath = path.join(dir, "meta.json")
  const adapter = createNativeSnapshotAdapter({
    os: "windows",
    rootPath: "C:\\workspace",
    metadataPath,
    now: () => new Date("2026-02-11T10:00:00.000Z"),
    exec: async (cmd) => {
      calls.push(cmd)
      if (cmd[0] === "powershell" && cmd[3]?.includes("Invoke-CimMethod -ClassName Win32_ShadowCopy")) {
        return { exitCode: 0, stdout: "{11111111-2222-3333-4444-555555555555}", stderr: "" }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  })

  const created = await adapter.create()
  expect(created.nativeId).toBe("{11111111-2222-3333-4444-555555555555}")
  await adapter.remove(created.id)

  expect(calls[0]?.[0]).toBe("powershell")
  expect(calls[1]?.[0]).toBe("powershell")
  expect(calls[1]?.[3]).toContain("Win32_ShadowCopy")
})
