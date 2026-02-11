export type BackupOs = "macos" | "linux" | "windows"

export type SnapshotPolicy = {
  cadence: "daily"
  perDay: number
  retention: number
}

export type SnapshotItem = {
  id: string
  createdAt: string
  source: string
  nativeId?: string
}

export type SnapshotAdapter = {
  os: BackupOs
  create: () => Promise<SnapshotItem>
  list: () => Promise<SnapshotItem[]>
  remove: (id: string) => Promise<void>
}

export type SnapshotRunResult = {
  created: SnapshotItem | null
  retained: SnapshotItem[]
  removed: string[]
}

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
  cadence: "daily",
  perDay: 1,
  retention: 5,
}

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandExecutor = (cmd: string[]) => Promise<CommandResult>

export type NativeSnapshotOptions = {
  os?: BackupOs
  rootPath: string
  metadataPath?: string
  exec?: CommandExecutor
  now?: () => Date
}

export async function runSnapshotCycle(
  adapter: SnapshotAdapter,
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
  now: Date = new Date(),
): Promise<SnapshotRunResult> {
  const existing = await adapter.list()
  const today = now.toISOString().slice(0, 10)
  const todayCount = existing.filter((item) => item.createdAt.slice(0, 10) === today).length
  const shouldCreate = todayCount < policy.perDay

  const created = shouldCreate ? await adapter.create() : null
  const next = [...existing, ...(created ? [created] : [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const kept = next.slice(0, Math.max(1, policy.retention))
  const keepSet = new Set(kept.map((item) => item.id))
  const removed = next.filter((item) => !keepSet.has(item.id)).map((item) => item.id)

  for (const id of removed) {
    await adapter.remove(id)
  }

  return {
    created,
    retained: kept,
    removed,
  }
}

export function detectBackupOs(platform: NodeJS.Platform): BackupOs {
  if (platform === "darwin") {
    return "macos"
  }
  if (platform === "win32") {
    return "windows"
  }
  return "linux"
}

export function createNativeSnapshotAdapter(options: NativeSnapshotOptions): SnapshotAdapter {
  const os = options.os ?? detectBackupOs(process.platform)
  const exec = options.exec ?? runCommand
  const now = options.now ?? (() => new Date())
  const metadataPath =
    options.metadataPath || `${options.rootPath}${options.rootPath.endsWith("/") || options.rootPath.endsWith("\\") ? "" : "/"}.open-machina-snapshots-${os}.json`

  return {
    os,
    create: async () => {
      const createdAt = now().toISOString()
      const id = `snapshot-${createdAt.replace(/[:.]/g, "-")}`
      const native = await createNativeSnapshot(os, options.rootPath, id, exec)
      const item: SnapshotItem = {
        id,
        createdAt,
        source: `native:${os}`,
        nativeId: native,
      }
      const all = await readSnapshotMetadata(metadataPath)
      await writeSnapshotMetadata(metadataPath, [item, ...all])
      return item
    },
    list: async () => {
      const all = await readSnapshotMetadata(metadataPath)
      return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    remove: async (id: string) => {
      const all = await readSnapshotMetadata(metadataPath)
      const match = all.find((item) => item.id === id)
      if (!match) {
        return
      }
      await removeNativeSnapshot(os, options.rootPath, match, exec)
      await writeSnapshotMetadata(
        metadataPath,
        all.filter((item) => item.id !== id),
      )
    },
  }
}

async function runCommand(cmd: string[]): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`BACKUP_COMMAND_FAILED: ${cmd.join(" ")} (exit=${exitCode}) ${stderr || stdout}`.trim())
  }
  return { exitCode, stdout, stderr }
}

async function createNativeSnapshot(
  os: BackupOs,
  rootPath: string,
  id: string,
  exec: CommandExecutor,
): Promise<string | undefined> {
  if (os === "macos") {
    const out = await exec(["tmutil", "localsnapshot", rootPath])
    const token = parseMacSnapshotToken(out.stdout + "\n" + out.stderr)
    return token
  }
  if (os === "linux") {
    const target = `${rootPath}${rootPath.endsWith("/") ? "" : "/"}.open-machina-snapshots/${id}`
    await exec(["mkdir", "-p", `${rootPath}${rootPath.endsWith("/") ? "" : "/"}.open-machina-snapshots`])
    await exec(["btrfs", "subvolume", "snapshot", "-r", rootPath, target])
    return target
  }

  const volume = toWindowsVolume(rootPath)
  const script = [
    "$result = Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{Volume='",
    volume,
    "'; Context='ClientAccessible'}",
    "$result.ShadowID",
  ].join("")
  const out = await exec(["powershell", "-NoProfile", "-Command", script])
  const token = out.stdout.trim().split(/\s+/).find((line) => line.startsWith("{"))
  return token
}

async function removeNativeSnapshot(
  os: BackupOs,
  rootPath: string,
  item: SnapshotItem,
  exec: CommandExecutor,
): Promise<void> {
  if (os === "macos") {
    const token = item.nativeId || toMacToken(item.createdAt)
    await exec(["tmutil", "deletelocalsnapshots", token])
    return
  }
  if (os === "linux") {
    const target = item.nativeId || `${rootPath}${rootPath.endsWith("/") ? "" : "/"}.open-machina-snapshots/${item.id}`
    await exec(["btrfs", "subvolume", "delete", target])
    return
  }

  if (!item.nativeId) {
    return
  }
  const script = [
    "$id='",
    item.nativeId,
    "';",
    "Get-CimInstance Win32_ShadowCopy | Where-Object {$_.ID -eq $id} | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Delete | Out-Null }",
  ].join("")
  await exec(["powershell", "-NoProfile", "-Command", script])
}

function parseMacSnapshotToken(text: string): string | undefined {
  const namespaced = text.match(/com\.apple\.TimeMachine\.(\d{4}-\d{2}-\d{2}-\d{6})/)
  if (namespaced?.[1]) {
    return namespaced[1]
  }
  const dated = text.match(/(\d{4}-\d{2}-\d{2}-\d{6})/)
  return dated?.[1]
}

function toMacToken(createdAt: string): string {
  const value = createdAt.replace(/[-:]/g, "").replace(/\..+$/, "")
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}-${value.slice(9, 15)}`
}

function toWindowsVolume(rootPath: string): string {
  const match = rootPath.match(/^[A-Za-z]:\\/)
  if (!match) {
    return "C:\\"
  }
  return `${match[0]}`
}

async function readSnapshotMetadata(filePath: string): Promise<SnapshotItem[]> {
  const file = Bun.file(filePath)
  const exists = await file.exists()
  if (!exists) {
    return []
  }
  const payload = await file.json().catch(() => [])
  if (!Array.isArray(payload)) {
    return []
  }
  return payload.filter(isSnapshotItem)
}

async function writeSnapshotMetadata(filePath: string, items: SnapshotItem[]): Promise<void> {
  const sorted = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  await Bun.write(filePath, JSON.stringify(sorted, null, 2))
}

function isSnapshotItem(value: unknown): value is SnapshotItem {
  if (!value || typeof value !== "object") {
    return false
  }
  const obj = value as Record<string, unknown>
  return typeof obj.id === "string" && typeof obj.createdAt === "string" && typeof obj.source === "string"
}
