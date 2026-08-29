# Architecture: Pi Model Router Extension

The `pi-model-router` registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/balanced`). For every turn, the router selects an underlying concrete model based on task complexity and conversation context.

> For the full decision-pipeline reference (context controls, fallback chains, image-aware escalation, Google thinking tool continuation, auto-context truncation, and thinking control), see [How Routing Works](../README.md#how-routing-works) in the README.

## Module Architecture

The extension is modularized for maintainability:

- **`extensions/index.ts`**: Orchestrator. Manages state, hooks into `pi` events, and wires modules together.
- **`extensions/provider.ts`**: Implements the `router` provider, delegation/retry loop, provider cooldown checks, and context fallback/compaction marking.
- **`extensions/routing.ts`**: Core decision logic, classifier, gating, and classifier-provider cooldown handling.
- **`extensions/config.ts`**: Loads, merges, and normalizes the JSON configuration.
- **`extensions/commands.ts`**: Registers all `/router` subcommands and their autocompletions.
- **`extensions/ui.ts`**: Manages the status line and the optional state widget.
- **`extensions/state.ts`**: Handles session-persisted state and snapshots.
- **`extensions/failover.ts`**: Parses rate-limit failures, computes bounded retry cooldowns, and tracks suspended providers.
- **`extensions/compaction.ts`**: Defers and awaits one post-truncation Pi compaction at the settled-session boundary.
- **`extensions/types.ts`**: Centralized interface and type definitions.

### Data Flow

```
session_start / model_select / turn_end (index.ts)
      pi runtime calls router provider on turn
            │
            ▼
      provider.ts streamSimple
            │
            ├─→ Google lock → preserve exact model for tool continuation
            ├─→ routing.ts
            ├─→ Classifier gating (only when classifierModels configured):
            │     ├─ New user message? → run classifier (final say)
            │     ├─ Tool cont ≥ confInitN (first crossing)? → run once
            │     ├─ Consecutive failures ≥ confFailN? → run (crisis)
            │     ├─ Cont crosses new interval bucket? → run (periodic)
            │     └─ Otherwise → reuse previous decision
            │
            ├─→ Post-route corrections (image escalation)
            ├─→ Provider cooldown check
            ├─→ Auto-context truncation/response-full detection (mark settled compaction when needed)
            ├─→ Delegate to target model
            └─→ Fallback chain on failure (suspend provider on rate limit)
            │
            ▼
      ui.ts (update status line + widget)
      state.ts (persist decision, history)
      compaction.ts (await pending compaction after agent_settled)

      session_start / model_select / turn_end (index.ts)
        restore, validate, or reassert the router model;
        agent_settled drains deferred compaction.
```

## Config Merging Order

Config is loaded from two locations and **merged**:

| Location | Scope | Path |
|---|---|---|
| Global | User-wide | `~/.pi/agent/model-router.json` |
| Project | Per-project | `.pi/model-router.json` |

The merge order is: **Base defaults ← Global config ← Project config**.

Project config values override global values, which override built-in defaults. Profiles are merged **deeply** — if you define only a `high` tier override for a profile in your project config, the `medium` and `low` tiers are inherited from the global config.

**When no config file exists**, the router loads with an empty profile list and no active models.

### Why Two Config Locations?

- **Global config** (`~/.pi/agent/model-router.json`) lets you set cross-project defaults — profile definitions, classifier preferences, and context thresholds you want everywhere.
- **Project config** (`.pi/model-router.json`) lets you override per-project — different profile choices, tighter context budgets, or debug flags for development.

This is handled by `extensions/config.ts`, which normalizes and validates the merged result.

### Config Validation

On reload/startup, the config system validates:
- Profile model refs are in `provider/model` format
- Thinking levels are valid (`off` → `max`)
- `defaultContextThresholdPercent` is positive
- `contextThresholdPercentOverrides` keys match known models (unknown keys produce a warning on provider registration)

## State & Persistence

Router state is persisted using `pi.appendEntry` with a custom type `router-state`. This allows the router to:

- Restore the active profile and pins across agent relaunches.
- Maintain independent pins and state for different conversation branches via `sessionManager.getBranch()`.
- Maintains session state across restarts.

### Persisted Fields

| Field | Type | Description |
|---|---|---|
| `selectedProfile` | `string` | Active profile name |
| `pinnedTierByProfile` | `Record<string, RouterTier>` | Manual tier pins per profile |
| `debugEnabled` | `boolean` | Debug mode state |
| `lastDecision` | `RoutingDecision` | Most recent routing decision |
| `lastNonRouterModel` | `string` | Last model used before switching to router |
> **Branch safety**: Because state is saved via `pi.appendEntry`, each conversation branch gets its own independent state. Switching branches restores the pins and state that were active on that branch.

### Debug Mode

Use `/router debug on` to enable debug notifications for routing decisions and classifier runs.