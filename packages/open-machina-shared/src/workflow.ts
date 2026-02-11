export type WorkflowStatus = "completed" | "cancelled" | "failed"

export type WorkflowLogEntry = {
  operationId: string
  workflowName: string
  status: WorkflowStatus
  startedAt: string
  finishedAt: string
}

export type WorkflowRunResult<Result> = {
  operationId: string
  workflowName: string
  status: WorkflowStatus
  startedAt: string
  finishedAt: string
  result?: Result
  error?: string
  log: WorkflowLogEntry
}

export type WorkflowDefinition<Payload, Result> = {
  name: string
  run: (context: WorkflowContext<Payload>) => Promise<Result>
}

export type WorkflowContext<Payload> = {
  payload: Payload
  signal: AbortSignal
  operationId: string
  workflowName: string
  startedAt: string
  addCleanup: (cleanup: () => void | Promise<void>) => void
  throwIfAborted: () => void
}

export type WorkflowRunOptions<Payload> = {
  payload: Payload
  cancelAfterMs?: number
}

const ABORT_ERROR_NAME = "AbortError"

export class WorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition<unknown, unknown>>()
  private readonly counters = new Map<string, number>()

  register<Payload, Result>(definition: WorkflowDefinition<Payload, Result>): void {
    this.definitions.set(definition.name, definition as WorkflowDefinition<unknown, unknown>)
  }

  listWorkflows(): string[] {
    return [...this.definitions.keys()].sort()
  }

  async run<Payload, Result>(
    workflowName: string,
    options: WorkflowRunOptions<Payload>,
  ): Promise<WorkflowRunResult<Result>> {
    const definition = this.definitions.get(workflowName) as WorkflowDefinition<Payload, Result> | undefined

    if (!definition) {
      throw new Error(`Unknown workflow: ${workflowName}`)
    }

    const operationId = this.createOperationId(workflowName)
    const startedAt = new Date().toISOString()
    const controller = new AbortController()
    const cleanups: Array<() => void | Promise<void>> = []

    const cleanup = async () => {
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        await cleanups[index]!()
      }
    }

    const context: WorkflowContext<Payload> = {
      payload: options.payload,
      signal: controller.signal,
      operationId,
      workflowName,
      startedAt,
      addCleanup: (entry) => cleanups.push(entry),
      throwIfAborted: () => {
        if (controller.signal.aborted) {
          throw createAbortError(controller.signal.reason)
        }
      },
    }

    const timeout =
      typeof options.cancelAfterMs === "number" && options.cancelAfterMs >= 0
        ? setTimeout(() => {
            controller.abort(new Error(`Cancellation requested after ${options.cancelAfterMs}ms`))
          }, options.cancelAfterMs)
        : null

    let status: WorkflowStatus = "failed"
    let result: Result | undefined
    let error: string | undefined

    try {
      const workflowPromise = definition.run(context)
      const cancellable = waitForAbort(controller.signal)
      result = await Promise.race([workflowPromise, cancellable])
      status = "completed"
    } catch (cause) {
      const normalized = normalizeError(cause)
      if (normalized.name === ABORT_ERROR_NAME || controller.signal.aborted) {
        status = "cancelled"
        error = normalized.message
      } else {
        status = "failed"
        error = normalized.message
      }
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout)
      }
      await cleanup()
    }

    const finishedAt = new Date().toISOString()
    const log: WorkflowLogEntry = {
      operationId,
      workflowName,
      status,
      startedAt,
      finishedAt,
    }

    return {
      operationId,
      workflowName,
      status,
      startedAt,
      finishedAt,
      result,
      error,
      log,
    }
  }

  private createOperationId(workflowName: string): string {
    const current = this.counters.get(workflowName) ?? 0
    const next = current + 1
    this.counters.set(workflowName, next)
    const safeName = workflowName.replace(/[^a-zA-Z0-9]+/g, "-")
    return `op-${safeName}-${String(next).padStart(4, "0")}`
  }
}

export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal.reason))
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(createAbortError(signal.reason))
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal.reason))
  }

  return new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(createAbortError(signal.reason))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function createAbortError(reason: unknown): Error {
  const message = reason instanceof Error ? reason.message : "Workflow cancelled"
  const error = new Error(message)
  error.name = ABORT_ERROR_NAME
  return error
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}
