# Open Machina Operations Runbook

This runbook defines integrated validation and day-2 operations for the OpenCode + oh-my-opencode + open-machina stack.

## Integrated Topology

- OpenCode runtime loads plugins from `opencode.json`.
- `oh-my-opencode` provides agent/tool orchestration primitives.
- `open-machina-plugin` provides interruption arbitration, judge model policy, and orchestration control context.
- `open-machina-shared` provides autonomy/memory/backup primitives.

## Preflight Checklist

1. OpenCode plugin list contains both plugins:
   - `oh-my-opencode`
   - `open-machina-plugin` (file URL or package)
2. Judge auth is stored in OpenCode auth store:
   - `opencode auth login` -> provider `open-machina-judge` (or custom `MACHINA_JUDGE_AUTH_PROVIDER`)
3. Judge target model configured:
   - `MACHINA_JUDGE_PROVIDER`
   - `MACHINA_JUDGE_MODEL`
4. Optional model policy configured:
   - `MACHINA_JUDGE_ALLOW_MODELS`
   - `MACHINA_JUDGE_DENY_MODELS`
   - `MACHINA_JUDGE_FALLBACK_MODELS`

## Integration Validation Matrix

### 1) Auth-backed Judge Resolution

Expected:
- judge token resolved from OpenCode auth storage
- no hard dependency on `MACHINA_JUDGE_API_KEY`

Validation:

```bash
bun test packages/open-machina-plugin/src/index.test.ts
```

Look for passing tests:
- `open_machina_decide resolves key from OpenCode auth store`

### 2) Interruption Arbitration Paths

Expected:
- `abort` triggers session interruption path
- `defer` stores deferred runtime state
- `parallel` stores parallel runtime state

Validation:

```bash
bun test packages/open-machina-plugin/src/index.test.ts
```

Look for passing tests:
- `chat.message uses AI decision and injects orchestration context`
- `chat.message applies defer and parallel execution paths`

### 3) Judge Policy (allow/deny/fallback)

Expected:
- denied model candidates skipped
- fallback candidates tried in order
- first valid candidate selected

Validation:

```bash
bun test packages/open-machina-plugin/src/index.test.ts
```

Look for passing test:
- `open_machina_decide applies deny policy and uses fallback chain`

### 4) OS Snapshot Adapter Behavior

Expected:
- macOS/Linux/Windows command paths are generated correctly
- retention and daily cadence policy is enforced

Validation:

```bash
bun test packages/open-machina-shared/src/backup.test.ts
```

Look for passing tests:
- `createNativeSnapshotAdapter uses macOS tmutil commands`
- `createNativeSnapshotAdapter uses linux btrfs commands`
- `createNativeSnapshotAdapter uses windows shadow copy commands`

### 5) Build and Type Safety Gates

```bash
bun run typecheck
bun run build
```

Expected:
- TypeScript errors: 0
- Build exits successfully for shared/plugin/cli packages

## Operational Procedures

### Credential Rotation

1. Re-login judge provider via `opencode auth login`.
2. Keep provider id stable (`open-machina-judge`) unless intentionally migrating.
3. If migrating provider id, set `MACHINA_JUDGE_AUTH_PROVIDER` to new id.

### Model Policy Hardening

Recommended production baseline:

```bash
export MACHINA_JUDGE_ALLOW_MODELS=openai/gpt-4.1-mini,openrouter/gpt-4.1-mini
export MACHINA_JUDGE_DENY_MODELS=
export MACHINA_JUDGE_FALLBACK_MODELS=openrouter/gpt-4.1-mini
```

### Backup Policy

Policy target:
- cadence: daily
- max per day: 1
- retention: 5

Adapter caveats:
- Linux path assumes btrfs tooling available.
- Windows path uses PowerShell + `Win32_ShadowCopy`.
- macOS path uses `tmutil` local snapshots.

## Incident Response

### Symptom: `AUTONOMY_JUDGE_UNAVAILABLE`

Actions:
1. Verify `MACHINA_JUDGE_MODEL` is set.
2. Verify auth exists for `MACHINA_JUDGE_AUTH_PROVIDER` using `opencode auth list`.
3. Re-run `opencode auth login` for that provider id.

### Symptom: `AUTONOMY_JUDGE_POLICY_BLOCKED`

Actions:
1. Check `MACHINA_JUDGE_ALLOW_MODELS` and `MACHINA_JUDGE_DENY_MODELS` conflict.
2. Ensure `MACHINA_JUDGE_FALLBACK_MODELS` includes at least one available provider/model pair.
3. Confirm model exists in provider metadata.

### Symptom: backup command failures

Actions:
1. Verify required native command availability (`tmutil`, `btrfs`, `powershell`).
2. Verify permissions for snapshot creation/deletion.
3. Verify root path exists and is snapshot-capable.

## Change Management

- Any change to arbitration behavior requires updating plugin tests and this runbook.
- Any change to snapshot command paths requires updating shared backup tests.
- Release gate for these changes: test + typecheck + build must all pass.
