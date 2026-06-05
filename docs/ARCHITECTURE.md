# Architecture: Pi Model Router Extension

The `pi-model-router` registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/auto`). For every turn, the router selects an underlying concrete model based on task complexity, conversation context, and user-defined rules.

> For the full decision-pipeline reference (heuristic details, context controls, fallback chains, image-aware escalation, Google thinking tool continuation, auto-context truncation, and thinking control), see [How Routing Works](../README.md#how-routing-works) in the README.

## Module Architecture

The extension is modularized for maintainability:

- **`extensions/index.ts`**: Orchestrator. Manages state, hooks into `pi` events, and wires modules together.
- **`extensions/provider.ts`**: Implements the `router` provider and the delegation/retry loop.
- **`extensions/routing.ts`**: Core decision logic, heuristics, and the LLM classifier.
- **`extensions/config.ts`**: Loads, merges, and normalizes the JSON configuration.
- **`extensions/commands.ts`**: Registers all `/router` subcommands and their autocompletions.
- **`extensions/ui.ts`**: Manages the status line and the optional state widget.
- **`extensions/state.ts`**: Handles session-persisted state and snapshots.
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
            ├─→ routing.ts (makeHeuristicAnalysis)
            │      Always runs: heuristic analysis (keywords, word count,
            │      tool count, tier-stickiness thresholds, rules,
            │      manual pin, context trigger → HeuristicAnalysis)
            │
            ├─→ Classifier gating (only when classifierModels configured):
            │     ├─ New user message? → run classifier (final say)
            │     ├─ Tool cont ≥ confInitN (first crossing)? → run once
            │     ├─ Consecutive failures ≥ confFailN? → run (crisis)
            │     ├─ Cont crosses new interval bucket? → run (periodic)
            │     └─ Otherwise → reuse previous decision
            │     heuristicAnalysis is advisory to the classifier
            │
            ├─→ Post-route corrections (image escalation)
            ├─→ Auto-context truncation
            ├─→ Delegate to target model
            └─→ Fallback chain on failure
            │
            ▼
      ui.ts (update status line + widget)
      state.ts (persist decision, history)

      session_start / model_select / turn_end (index.ts)
        only restore, validate, or reassert the router model;
        they do not perform routing themselves.
```

## State & Persistence

Router state is persisted using `pi.appendEntry` with a custom type `router-state`. This allows the router to:

- Restore the active profile and pins across agent relaunches.
- Maintain independent pins and state for different conversation branches via `sessionManager.getBranch()`.
- Maintains session state across restarts.

### Persisted Fields

| Field | Type | Description |
|---|---|---|
| `selectedProfile` | `string` | Active profile name |
| `pinnedTierByProfile` | `Record<string, TierLevel>` | Manual tier pins per profile |
| `thinkingOverride` | `Record<string, Record<string, ThinkingLevel>>` | Runtime thinking overrides |
| `debugEnabled` | `boolean` | Debug mode state |
| `widgetEnabled` | `boolean` | Widget visibility |
| `lastDecision` | `RoutingDecision` | Most recent routing decision |
| `lastNonRouterModel` | `string` | Last model used before switching to router |
| `debugHistory` | `RoutingDecision[]` | Recent routing decisions |

> **Branch safety**: Because state is saved via `pi.appendEntry`, each conversation branch gets its own independent state. Switching branches restores the pins and history that were active on that branch.

### Debug History

The debug history stores the last 12 routing decisions (`MAX_DEBUG_HISTORY` in `constants.ts`). When debug mode is enabled (`/router debug on`), each decision is appended to `debugHistory` and `/router debug show` prints the full history.