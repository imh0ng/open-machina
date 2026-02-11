import { expect, test } from "bun:test"
import { decideOrchestration, parseDecision, shouldInterrupt } from "./autonomy"

test("parseDecision accepts strict JSON decision", () => {
  const result = parseDecision(
    JSON.stringify({
      action: "parallel",
      confidence: 0.92,
      reason: "User request is urgent and current job can continue in background",
      priority: "high",
      parallelPlan: { lane: "background", maxConcurrency: 4 },
    }),
  )

  expect(result?.action).toBe("parallel")
  expect(result?.parallelPlan?.lane).toBe("background")
  expect(result?.parallelPlan?.maxConcurrency).toBe(4)
})

test("decideOrchestration retries once when first judge output is invalid", async () => {
  let calls = 0
  const decision = await decideOrchestration(
    {
      now: "2026-02-11T10:00:00.000Z",
      userMessage: "Stop this and work on incident now",
      userIntent: "incident-response",
      persona: {
        name: "machina",
        traits: ["proactive", "focused"],
        goals: ["finish user goals"],
        fixedPrinciples: ["prevent direct harm"],
      },
      activeWork: [
        {
          id: "w1",
          title: "daily indexing",
          status: "running",
          priority: "medium",
          startedAt: "2026-02-11T09:40:00.000Z",
        },
      ],
      systemState: { cpuLoad: 0.41, memoryLoad: 0.62, networkHealth: "good" },
    },
    async () => {
      calls += 1
      if (calls === 1) {
        return "not-json"
      }
      return JSON.stringify({
        action: "abort",
        confidence: 0.88,
        reason: "Critical user incident supersedes current medium priority task",
        priority: "critical",
      })
    },
  )

  expect(calls).toBe(2)
  expect(decision.action).toBe("abort")
  expect(shouldInterrupt(decision)).toBe(true)
})
