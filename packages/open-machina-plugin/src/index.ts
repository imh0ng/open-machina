import { createDefaultChannelConnectors, decideOrchestration, type ActiveWorkItem } from "open-machina-shared"
import os from "node:os"
import path from "node:path"

export const defaultsUrl = new URL("../../../config/defaults.json", import.meta.url)

export type PluginMode = "local" | "dev" | "prod"

type PluginModeConfig = {
  source: string
  entry: string
}

type DefaultsConfig = {
  identity: {
    name: string
    marker: string
  }
  version: string
  plugin: {
    name: string
    mode: PluginMode
    modes: Record<PluginMode, PluginModeConfig>
  }
}

export type PluginRegistration = {
  mode: PluginMode
  name: string
  source: string
  entry: string
  resolvedEntry?: string
}

export type PluginStatus =
  | {
      status: "loaded"
      registration: PluginRegistration
    }
  | {
      status: "error"
      code: "INVALID_MODE" | "CONFIG_NOT_FOUND" | "PLUGIN_NOT_FOUND"
      message: string
      hint: string
      registration?: PluginRegistration
    }

type OpenCodePluginInput = {
  client: {
    provider?: {
      list?: (args?: Record<string, unknown>) => Promise<unknown>
    }
    session: {
      abort?: (args: { path: { id: string } }) => Promise<unknown>
      prompt?: (args: {
        path: { id: string }
        body: {
          parts: Array<{ type: string; text: string }>
          model?: { providerID: string; modelID: string }
        }
      }) => Promise<unknown>
      promptAsync?: (args: {
        path: { id: string }
        body: {
          parts: Array<{ type: string; text: string }>
          model?: { providerID: string; modelID: string }
        }
      }) => Promise<unknown>
    }
  }
  directory: string
  worktree: string
  serverUrl: URL
}

type OpenCodeToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
}

type OpenCodeTool = {
  description: string
  args: Record<string, unknown>
  execute: (args: Record<string, unknown>, context: OpenCodeToolContext) => Promise<string>
}

type OpenCodeHooks = {
  tool?: Record<string, OpenCodeTool>
  auth?: {
    provider: string
    methods: Array<{
      type: "api"
      label: string
    }>
    loader?: (getAuth: () => Promise<unknown>) => Promise<Record<string, unknown>>
  }
  config?: (input: Record<string, unknown>) => Promise<void>
  "tool.execute.before"?: (input: { tool: string; sessionID: string; callID: string }, output: { args: Record<string, unknown> }) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>
  "chat.message"?: (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string },
    output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>
}

type JudgeConfig = {
  providerID: string
  apiUrl?: string
  modelID: string
  authProviderID: string
}

type JudgeRuntime = {
  providerID: string
  modelID: string
  apiUrl: string
  token: string
}

type ModelRef = {
  providerID: string
  modelID: string
}

type JudgePolicy = {
  allow: ModelRef[]
  deny: ModelRef[]
  fallback: ModelRef[]
}

type SessionRuntimeState = {
  deferred: ActiveWorkItem[]
  parallel: ActiveWorkItem[]
}

const CONTROL_MARKER = "[OPEN-MACHINA CONTROL]"

export async function info() {
  const config = await getDefaultsConfig()

  return {
    name: config.identity.name,
    marker: config.identity.marker,
    version: config.version,
    defaultsUrl: defaultsUrl.toString(),
  }
}

export function getDefaultsConfig(): Promise<DefaultsConfig> {
  return Bun.file(defaultsUrl).json() as Promise<DefaultsConfig>
}

export async function resolvePluginRegistration(env: NodeJS.ProcessEnv = process.env): Promise<PluginRegistration> {
  const config = await getDefaultsConfig()
  const mode = (env.MACHINA_PLUGIN_MODE || config.plugin.mode) as PluginMode

  if (!isPluginMode(mode)) {
    throw new Error(`Invalid MACHINA_PLUGIN_MODE \"${mode}\". Expected one of: local, dev, prod.`)
  }

  const modeConfig = config.plugin.modes[mode]
  const registration: PluginRegistration = {
    mode,
    name: config.plugin.name,
    source: modeConfig.source,
    entry: modeConfig.entry,
  }

  const overridePath = env.MACHINA_PLUGIN_PATH
  if (overridePath && overridePath.trim().length > 0) {
    registration.resolvedEntry = overridePath
    return registration
  }

  if (mode === "prod") {
    registration.resolvedEntry = modeConfig.entry
    return registration
  }

  const repoRoot = new URL("../../../", import.meta.url)
  registration.resolvedEntry = Bun.fileURLToPath(new URL(modeConfig.entry, repoRoot))

  return registration
}

export async function getPluginStatus(env: NodeJS.ProcessEnv = process.env): Promise<PluginStatus> {
  if (!(await Bun.file(defaultsUrl).exists())) {
    return {
      status: "error",
      code: "CONFIG_NOT_FOUND",
      message: `Machina defaults config not found at ${defaultsUrl.pathname}`,
      hint: "Ensure open-machina/config/defaults.json exists and is readable.",
    }
  }

  let registration: PluginRegistration

  try {
    registration = await resolvePluginRegistration(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid plugin mode configuration."
    return {
      status: "error",
      code: "INVALID_MODE",
      message,
      hint: "Set MACHINA_PLUGIN_MODE to local, dev, or prod.",
    }
  }

  if (registration.mode !== "prod") {
    const target = registration.resolvedEntry ?? registration.entry
    const exists = await Bun.file(target).exists()

    if (!exists) {
      return {
        status: "error",
        code: "PLUGIN_NOT_FOUND",
        message: `Plugin entry not found for mode ${registration.mode}: ${target}`,
        hint: "Run `bun --cwd=/Users/hong/machina-project/open-machina run build` or set MACHINA_PLUGIN_PATH to a valid entry file.",
        registration,
      }
    }
  }

  return {
    status: "loaded",
    registration,
  }
}

export async function OpenMachinaPlugin(input: OpenCodePluginInput): Promise<OpenCodeHooks> {
  const sessions = new Map<string, ActiveWorkItem[]>()
  const sessionRuntime = new Map<string, SessionRuntimeState>()
  let getJudgeAuth: (() => Promise<unknown>) | undefined

  return {
    auth: {
      provider: (process.env.MACHINA_JUDGE_AUTH_PROVIDER || "open-machina-judge").trim(),
      methods: [
        {
          type: "api",
          label: "Open Machina judge API key",
        },
      ],
      loader: async (getAuth) => {
        getJudgeAuth = getAuth
        return {}
      },
    },
    tool: {
      open_machina_info: {
        description: "Returns open-machina runtime identity and plugin registration status.",
        args: {},
        execute: async () => {
          const identity = await info()
          const status = await getPluginStatus(process.env)
          return JSON.stringify(
            {
              identity,
              status,
            },
            null,
            2,
          )
        },
      },
      open_machina_connectors: {
        description: "Lists available open-machina channel connectors.",
        args: {},
        execute: async () => {
          const connectors = createDefaultChannelConnectors().map((item) => item.id)
          return JSON.stringify({ connectors }, null, 2)
        },
      },
      open_machina_workspace: {
        description: "Returns OpenCode workspace metadata seen by open-machina plugin.",
        args: {},
        execute: async (_args, ctx) => {
          const runtime = getSessionRuntime(sessionRuntime, ctx.sessionID)
          return JSON.stringify(
            {
              directory: input.directory,
              worktree: input.worktree,
              serverUrl: input.serverUrl.toString(),
              session: {
                sessionID: ctx.sessionID,
                messageID: ctx.messageID,
                agent: ctx.agent,
                deferred: runtime.deferred,
                parallel: runtime.parallel,
              },
            },
            null,
            2,
          )
        },
      },
      open_machina_decide: {
        description: "Runs AI interruption arbitration decision for provided context.",
        args: {
          input: {
            type: "object",
            required: true,
          },
          model: {
            type: "object",
            required: false,
          },
        },
        execute: async (args) => {
          const inputArg = args.input
          if (!isRecord(inputArg)) {
            throw new Error("INVALID_INPUT: expected input object")
          }

          const modelArg = parseModelRef(args.model)
          const judge = await resolveJudgeRuntime({
            env: process.env,
            client: input.client,
            getJudgeAuth,
            modelHint: modelArg,
          })
          if (!judge) {
            throw new Error(
              "AUTONOMY_JUDGE_UNAVAILABLE: run `opencode auth login` for provider open-machina-judge (or set MACHINA_JUDGE_AUTH_PROVIDER) and configure MACHINA_JUDGE_MODEL",
            )
          }

          const decision = await decideOrchestration(inputArg as Parameters<typeof decideOrchestration>[0], (prompt) =>
            callJudge(judge, prompt),
          )
          return JSON.stringify(decision, null, 2)
        },
      },
    },
    "tool.execute.before": async (evt) => {
      const work = sessions.get(evt.sessionID) ?? []
      const next: ActiveWorkItem = {
        id: `${evt.tool}:${evt.callID}`,
        title: evt.tool,
        status: "running",
        priority: classifyPriority(evt.tool),
        startedAt: new Date().toISOString(),
      }
      sessions.set(evt.sessionID, [next, ...work].slice(0, 16))
    },
    "tool.execute.after": async (evt) => {
      const work = sessions.get(evt.sessionID) ?? []
      const next = work.map((item) => (item.id === `${evt.tool}:${evt.callID}` ? { ...item, status: "queued" as const } : item))
      sessions.set(evt.sessionID, next)
    },
    "chat.message": async (evt, out) => {
      const runtime = getSessionRuntime(sessionRuntime, evt.sessionID)
      const active = (sessions.get(evt.sessionID) ?? []).filter((item) => item.status === "running")
      if (active.length === 0) {
        return
      }

      const prompt = out.parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim()
      if (!prompt) {
        return
      }
      if (prompt.includes(CONTROL_MARKER)) {
        return
      }

      const judge = await resolveJudgeRuntime({
        env: process.env,
        client: input.client,
        getJudgeAuth,
        modelHint: evt.model,
      })
      if (!judge) {
        return
      }

      const identity = await info()
      const decision = await decideOrchestration(
        {
          now: new Date().toISOString(),
          userMessage: prompt,
          userIntent: inferIntent(prompt),
          persona: {
            name: identity.name,
            traits: ["autonomous", "proactive", "user-aligned"],
            goals: ["maximize user goal completion", "maintain continuity"],
            fixedPrinciples: ["prevent direct harm to user or humans"],
          },
          activeWork: active,
          systemState: {
            networkHealth: "good",
          },
        },
        (judgePrompt) => callJudge(judge, judgePrompt),
      )

      if (decision.action === "abort") {
        await abortSession(input, evt.sessionID)
        runtime.deferred = []
        runtime.parallel = []
      }
      if (decision.action === "defer") {
        applyDefer(runtime, active, decision.deferUntil)
      }
      if (decision.action === "parallel") {
        applyParallel(runtime, prompt, decision)
      }

      const runtimeText = formatRuntimeState(runtime)
      const decisionText = [
        "[OPEN-MACHINA ORCHESTRATION DECISION]",
        `action=${decision.action}`,
        `priority=${decision.priority}`,
        `confidence=${decision.confidence}`,
        `reason=${decision.reason}`,
        runtimeText,
      ].join("\n")

      const index = out.parts.findIndex((part) => part.type === "text")
      if (index >= 0) {
        const original = out.parts[index]?.text ?? ""
        out.parts[index] = {
          type: "text",
          text: `${decisionText}\n\n---\n\n${original}`,
        }
      }
    },
    config: async (_input) => {
      return
    },
  }
}

function getSessionRuntime(registry: Map<string, SessionRuntimeState>, sessionID: string): SessionRuntimeState {
  const current = registry.get(sessionID)
  if (current) {
    return current
  }
  const next: SessionRuntimeState = {
    deferred: [],
    parallel: [],
  }
  registry.set(sessionID, next)
  return next
}

function applyDefer(state: SessionRuntimeState, active: ActiveWorkItem[], deferUntil?: string): void {
  if (active.length === 0) {
    return
  }
  const top = active[0]
  if (!top) {
    return
  }
  const marker = deferUntil ? `${top.title} (until ${deferUntil})` : top.title
  state.deferred = [
    {
      ...top,
      title: marker,
      status: "blocked" as const,
    },
    ...state.deferred.filter((item) => item.id !== top.id),
  ].slice(0, 16)
}

function applyParallel(
  state: SessionRuntimeState,
  prompt: string,
  decision: {
    priority: "critical" | "high" | "medium" | "low"
    parallelPlan?: { lane: "foreground" | "background"; maxConcurrency: number }
  },
): void {
  const lane = decision.parallelPlan?.lane ?? "background"
  const maxConcurrency = decision.parallelPlan?.maxConcurrency ?? 1
  const item: ActiveWorkItem = {
    id: `parallel:${Date.now()}`,
    title: `${lane} x${maxConcurrency}: ${prompt.slice(0, 80)}`,
    status: "queued",
    priority: decision.priority,
    startedAt: new Date().toISOString(),
  }
  state.parallel = [item, ...state.parallel].slice(0, 16)
}

function formatRuntimeState(state: SessionRuntimeState): string {
  if (state.deferred.length === 0 && state.parallel.length === 0) {
    return `${CONTROL_MARKER} continue-current-plan`
  }
  return [
    CONTROL_MARKER,
    `deferred=${state.deferred.length}`,
    `parallel=${state.parallel.length}`,
    state.deferred.length > 0
      ? `defer-head=${state.deferred[0]?.title ?? "none"}`
      : "defer-head=none",
    state.parallel.length > 0
      ? `parallel-head=${state.parallel[0]?.title ?? "none"}`
      : "parallel-head=none",
  ].join(" ")
}

export default OpenMachinaPlugin

function isPluginMode(value: string): value is PluginMode {
  return value === "local" || value === "dev" || value === "prod"
}

function readJudgeConfig(env: NodeJS.ProcessEnv): JudgeConfig | null {
  const providerID = env.MACHINA_JUDGE_PROVIDER?.trim() || "openai"
  const modelID = env.MACHINA_JUDGE_MODEL?.trim()
  const authProviderID = env.MACHINA_JUDGE_AUTH_PROVIDER?.trim() || "open-machina-judge"
  const apiUrl = env.MACHINA_JUDGE_API_URL?.trim()
  if (!modelID) {
    return null
  }
  return { providerID, apiUrl, modelID, authProviderID }
}

async function resolveJudgeRuntime(input: {
  env: NodeJS.ProcessEnv
  client: OpenCodePluginInput["client"]
  getJudgeAuth?: () => Promise<unknown>
  modelHint?: { providerID: string; modelID: string }
}): Promise<JudgeRuntime | null> {
  const config = readJudgeConfig(input.env)
  if (!config) {
    return null
  }

  const policy = readJudgePolicy(input.env)
  const base: ModelRef = {
    providerID: input.modelHint?.providerID?.trim() || config.providerID,
    modelID: input.modelHint?.modelID?.trim() || config.modelID,
  }
  if (!base.providerID || !base.modelID) {
    return null
  }

  const candidates = dedupeModelRefs([base, ...policy.fallback])
  const skips: string[] = []
  let selected: ModelRef | null = null
  for (const candidate of candidates) {
    if (!isPolicyAllowed(policy, candidate)) {
      skips.push(`POLICY_DENY:${candidate.providerID}/${candidate.modelID}`)
      continue
    }
    const modelValidation = await validateJudgeTarget(input.client, candidate.providerID, candidate.modelID)
    if (modelValidation) {
      skips.push(modelValidation)
      continue
    }
    selected = candidate
    break
  }

  if (!selected) {
    throw new Error(`AUTONOMY_JUDGE_POLICY_BLOCKED: no valid model candidate. ${skips.join(" | ")}`)
  }

  const providerID = selected.providerID
  const modelID = selected.modelID

  const token = await resolveJudgeToken({
    env: input.env,
    getJudgeAuth: input.getJudgeAuth,
    authProviderID: config.authProviderID,
    providerID,
  })
  if (!token) {
    return null
  }

  return {
    providerID,
    modelID,
    apiUrl: config.apiUrl || inferJudgeApiUrl(providerID) || "https://api.openai.com/v1/chat/completions",
    token,
  }
}

async function resolveJudgeToken(input: {
  env: NodeJS.ProcessEnv
  getJudgeAuth?: () => Promise<unknown>
  authProviderID: string
  providerID: string
}): Promise<string | null> {
  const live = await input.getJudgeAuth?.().catch(() => undefined)
  const liveToken = pickAuthToken(live)
  if (liveToken) {
    return liveToken
  }

  const pathFromEnv = input.env.OPENCODE_AUTH_PATH?.trim()
  const authPath = pathFromEnv || path.join(os.homedir(), ".config", "opencode", "auth.json")
  const payload = await Bun.file(authPath)
    .json()
    .catch(() => undefined)
  const authToken = pickAuthTokenFromStore(payload, input.authProviderID) || pickAuthTokenFromStore(payload, input.providerID)
  if (authToken) {
    return authToken
  }

  return input.env.MACHINA_JUDGE_API_KEY?.trim() || null
}

async function callJudge(config: JudgeRuntime, prompt: string): Promise<string> {
  const response = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.modelID,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are open-machina orchestration judge. Return strict JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
    }),
  })

  if (!response.ok) {
    throw new Error(`AUTONOMY_JUDGE_FAILED: HTTP ${response.status}`)
  }

  const payload = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const text = payload.choices?.[0]?.message?.content
  if (!text) {
    throw new Error("AUTONOMY_JUDGE_FAILED: empty response")
  }
  return text
}

function classifyPriority(tool: string): "critical" | "high" | "medium" | "low" {
  const name = tool.toLowerCase()
  if (name.includes("deploy") || name.includes("incident") || name.includes("backup")) {
    return "critical"
  }
  if (name.includes("workflow") || name.includes("channel")) {
    return "high"
  }
  if (name.includes("tool") || name.includes("storage")) {
    return "medium"
  }
  return "low"
}

async function validateJudgeTarget(
  client: OpenCodePluginInput["client"],
  providerID: string,
  modelID: string,
): Promise<string | null> {
  const list = client.provider?.list
  if (!list) {
    return null
  }

  const response = await list({}).catch(() => undefined)
  const data = unwrapClientData(response)
  if (!isRecord(data)) {
    return null
  }

  const all = data.all
  if (!Array.isArray(all)) {
    return null
  }

  const provider = all.find((item) => isRecord(item) && item.id === providerID)
  if (!provider || !isRecord(provider)) {
    const options = all
      .map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : null))
      .filter((item): item is string => typeof item === "string")
      .slice(0, 8)
    return `AUTONOMY_JUDGE_INVALID_PROVIDER: provider ${providerID} not found. Available: ${options.join(", ")}`
  }

  const models = provider.models
  if (!isRecord(models) || !(modelID in models)) {
    const options = Object.keys(isRecord(models) ? models : {}).slice(0, 8)
    return `AUTONOMY_JUDGE_INVALID_MODEL: model ${providerID}/${modelID} not found. Available examples: ${options.join(", ")}`
  }

  return null
}

function unwrapClientData(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload) {
    return payload.data
  }
  return payload
}

function pickAuthToken(auth: unknown): string | null {
  if (!isRecord(auth) || typeof auth.type !== "string") {
    return null
  }
  if (auth.type === "api" && typeof auth.key === "string" && auth.key.trim().length > 0) {
    return auth.key.trim()
  }
  if (auth.type === "oauth" && typeof auth.access === "string" && auth.access.trim().length > 0) {
    return auth.access.trim()
  }
  if (auth.type === "wellknown" && typeof auth.token === "string" && auth.token.trim().length > 0) {
    return auth.token.trim()
  }
  return null
}

function pickAuthTokenFromStore(payload: unknown, providerID: string): string | null {
  if (!isRecord(payload)) {
    return null
  }
  return pickAuthToken(payload[providerID])
}

function parseModelRef(value: unknown): { providerID: string; modelID: string } | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (typeof value.providerID !== "string" || typeof value.modelID !== "string") {
    return undefined
  }
  return {
    providerID: value.providerID,
    modelID: value.modelID,
  }
}

function parseModelRefList(value?: string): ModelRef[] {
  if (!value) {
    return []
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const split = item.split("/")
      if (split.length !== 2) {
        return null
      }
      const providerID = split[0]?.trim()
      const modelID = split[1]?.trim()
      if (!providerID || !modelID) {
        return null
      }
      return { providerID, modelID }
    })
    .filter((item): item is ModelRef => Boolean(item))
}

function readJudgePolicy(env: NodeJS.ProcessEnv): JudgePolicy {
  return {
    allow: parseModelRefList(env.MACHINA_JUDGE_ALLOW_MODELS),
    deny: parseModelRefList(env.MACHINA_JUDGE_DENY_MODELS),
    fallback: parseModelRefList(env.MACHINA_JUDGE_FALLBACK_MODELS),
  }
}

function dedupeModelRefs(items: ModelRef[]): ModelRef[] {
  const keys = new Set<string>()
  const out: ModelRef[] = []
  for (const item of items) {
    const key = `${item.providerID}/${item.modelID}`
    if (keys.has(key)) {
      continue
    }
    keys.add(key)
    out.push(item)
  }
  return out
}

function isPolicyAllowed(policy: JudgePolicy, target: ModelRef): boolean {
  const key = `${target.providerID}/${target.modelID}`
  const denied = policy.deny.some((item) => `${item.providerID}/${item.modelID}` === key)
  if (denied) {
    return false
  }
  if (policy.allow.length === 0) {
    return true
  }
  return policy.allow.some((item) => `${item.providerID}/${item.modelID}` === key)
}

function inferJudgeApiUrl(providerID: string): string | null {
  const provider = providerID.trim().toLowerCase()
  if (provider === "openai") {
    return "https://api.openai.com/v1/chat/completions"
  }
  if (provider === "openrouter") {
    return "https://openrouter.ai/api/v1/chat/completions"
  }
  if (provider === "xai") {
    return "https://api.x.ai/v1/chat/completions"
  }
  return null
}

function inferIntent(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes("urgent") || lower.includes("incident") || lower.includes("now")) {
    return "urgent-request"
  }
  if (lower.includes("later") || lower.includes("defer") || lower.includes("after")) {
    return "deferred-request"
  }
  if (lower.includes("parallel") || lower.includes("also")) {
    return "parallel-request"
  }
  return "general-request"
}

async function abortSession(input: OpenCodePluginInput, sessionID: string): Promise<void> {
  if (input.client.session.abort) {
    await input.client.session.abort({ path: { id: sessionID } }).catch(() => undefined)
    return
  }

  const text = "open-machina requested interruption due to new higher-priority user intent"
  if (input.client.session.promptAsync) {
    await input.client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } }).catch(
      () => undefined,
    )
    return
  }

  if (input.client.session.prompt) {
    await input.client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } }).catch(() =>
      undefined,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
