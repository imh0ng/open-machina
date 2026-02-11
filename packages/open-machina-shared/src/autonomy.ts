export type OrchestrationAction = "abort" | "defer" | "parallel" | "continue"

export type OrchestrationDecision = {
  action: OrchestrationAction
  confidence: number
  reason: string
  priority: "critical" | "high" | "medium" | "low"
  deferUntil?: string
  parallelPlan?: {
    lane: "foreground" | "background"
    maxConcurrency: number
  }
}

export type ActiveWorkItem = {
  id: string
  title: string
  status: "running" | "queued" | "blocked"
  priority: "critical" | "high" | "medium" | "low"
  startedAt: string
}

export type OrchestrationInput = {
  now: string
  userMessage: string
  userIntent: string
  persona: {
    name: string
    traits: string[]
    goals: string[]
    fixedPrinciples: string[]
  }
  activeWork: ActiveWorkItem[]
  systemState: {
    cpuLoad?: number
    memoryLoad?: number
    networkHealth?: "good" | "degraded" | "down"
  }
}

export type OrchestrationJudge = (prompt: string) => Promise<string>

const DECISION_SCHEMA = [
  "Return strict JSON only with keys:",
  "action: abort|defer|parallel|continue",
  "confidence: number between 0 and 1",
  "reason: concise rationale",
  "priority: critical|high|medium|low",
  "deferUntil: optional ISO timestamp",
  "parallelPlan: optional { lane: foreground|background, maxConcurrency: number }",
].join("\n")

export async function decideOrchestration(input: OrchestrationInput, judge: OrchestrationJudge): Promise<OrchestrationDecision> {
  const prompt = createDecisionPrompt(input)

  const first = await judge(prompt)
  const parsedFirst = parseDecision(first)
  if (parsedFirst) {
    return parsedFirst
  }

  const repair = await judge([
    "Your previous answer was invalid.",
    DECISION_SCHEMA,
    "Return one valid JSON object now.",
  ].join("\n"))
  const parsedRepair = parseDecision(repair)
  if (parsedRepair) {
    return parsedRepair
  }

  throw new Error("ORCHESTRATION_DECISION_INVALID: judge response did not return valid decision JSON")
}

export function createDecisionPrompt(input: OrchestrationInput): string {
  return [
    "You are open-machina orchestration judge.",
    "Decide interruption strategy for current active work.",
    "Do not use static rules. Make contextual judgement.",
    "Primary objective: maximize user goal completion while preventing direct harm.",
    DECISION_SCHEMA,
    "",
    "Input JSON:",
    JSON.stringify(input, null, 2),
  ].join("\n")
}

export function parseDecision(raw: string): OrchestrationDecision | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      return null
    }
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return null
    }
  }

  if (!isRecord(parsed)) {
    return null
  }

  const action = parsed.action
  const confidence = parsed.confidence
  const reason = parsed.reason
  const priority = parsed.priority
  if (!isAction(action) || typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    return null
  }
  if (typeof reason !== "string" || reason.trim().length === 0 || !isPriority(priority)) {
    return null
  }

  const deferUntil = typeof parsed.deferUntil === "string" && parsed.deferUntil.length > 0 ? parsed.deferUntil : undefined
  const parallelPlan = parseParallelPlan(parsed.parallelPlan)

  return {
    action,
    confidence,
    reason: reason.trim(),
    priority,
    deferUntil,
    parallelPlan,
  }
}

export function shouldInterrupt(decision: OrchestrationDecision): boolean {
  return decision.action === "abort" || decision.action === "parallel"
}

function parseParallelPlan(input: unknown): { lane: "foreground" | "background"; maxConcurrency: number } | undefined {
  if (!isRecord(input)) {
    return undefined
  }
  const lane = input.lane
  const maxConcurrency = input.maxConcurrency
  if ((lane !== "foreground" && lane !== "background") || typeof maxConcurrency !== "number") {
    return undefined
  }
  return {
    lane,
    maxConcurrency: Math.max(1, Math.min(32, Math.floor(maxConcurrency))),
  }
}

function isAction(value: unknown): value is OrchestrationAction {
  return value === "abort" || value === "defer" || value === "parallel" || value === "continue"
}

function isPriority(value: unknown): value is "critical" | "high" | "medium" | "low" {
  return value === "critical" || value === "high" || value === "medium" || value === "low"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
