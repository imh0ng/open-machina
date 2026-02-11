export type PersonaCore = {
  name: string
  traits: string[]
  goals: string[]
  principles: string[]
  createdAt: string
}

export type PersonaAdaptive = {
  styleHints: string[]
  topicWeights: Record<string, number>
  updatedAt: string
}

export type MemoryRecord = {
  id: string
  userId: string
  shard: "episodic" | "semantic" | "procedural"
  content: string
  tags: string[]
  createdAt: string
  weight: number
}

export type MemoryShardSet = {
  episodic: MemoryRecord[]
  semantic: MemoryRecord[]
  procedural: MemoryRecord[]
}

export function createMemoryShards(records: MemoryRecord[]): MemoryShardSet {
  return {
    episodic: records.filter((item) => item.shard === "episodic"),
    semantic: records.filter((item) => item.shard === "semantic"),
    procedural: records.filter((item) => item.shard === "procedural"),
  }
}

export function selectContext(records: MemoryRecord[], input: { query: string; limit: number }): MemoryRecord[] {
  const q = tokenize(input.query)
  const scored = records
    .map((item) => ({
      item,
      score: score(item, q),
    }))
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, Math.max(1, input.limit)).map((entry) => entry.item)
}

export function compressRecords(records: MemoryRecord[], maxChars: number): string {
  const lines = records
    .sort((a, b) => b.weight - a.weight)
    .map((item) => `${item.shard}:${item.tags.join(",")}:${item.content}`)

  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const next = used + line.length + 1
    if (next > maxChars) {
      break
    }
    out.push(line)
    used = next
  }
  return out.join("\n")
}

function score(item: MemoryRecord, tokens: string[]): number {
  const body = `${item.content} ${item.tags.join(" ")}`.toLowerCase()
  const overlap = tokens.reduce((acc, token) => (body.includes(token) ? acc + 1 : acc), 0)
  return overlap * 10 + item.weight
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((item) => item.length > 1)
}
