import { expect, test } from "bun:test"
import { compressRecords, createMemoryShards, selectContext, type MemoryRecord } from "./memory"

const data: MemoryRecord[] = [
  {
    id: "e1",
    userId: "u1",
    shard: "episodic",
    content: "User prefers concise action-first updates",
    tags: ["style", "preference"],
    createdAt: "2026-02-10T10:00:00.000Z",
    weight: 0.8,
  },
  {
    id: "s1",
    userId: "u1",
    shard: "semantic",
    content: "Primary project goal is autonomous orchestration",
    tags: ["goal", "orchestration"],
    createdAt: "2026-02-10T11:00:00.000Z",
    weight: 1,
  },
  {
    id: "p1",
    userId: "u1",
    shard: "procedural",
    content: "Backup policy is one daily snapshot with max five retained",
    tags: ["backup", "policy"],
    createdAt: "2026-02-10T12:00:00.000Z",
    weight: 0.9,
  },
]

test("createMemoryShards partitions records by shard", () => {
  const shards = createMemoryShards(data)
  expect(shards.episodic.length).toBe(1)
  expect(shards.semantic.length).toBe(1)
  expect(shards.procedural.length).toBe(1)
})

test("selectContext ranks relevant records", () => {
  const selected = selectContext(data, { query: "autonomous orchestration goal", limit: 2 })
  expect(selected[0]?.id).toBe("s1")
})

test("compressRecords returns bounded summary text", () => {
  const output = compressRecords(data, 120)
  expect(output.length).toBeLessThanOrEqual(120)
  expect(output.length).toBeGreaterThan(0)
})
