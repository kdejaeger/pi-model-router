# Pi Model Router: Core Mandates

## Project Overview

The `pi-model-router` is an extension-first model router for the `pi` coding agent. It registers a custom logical provider (`router`) that exposes "profiles" as models (e.g., `router/balanced`). For every turn, the router intelligently selects an underlying concrete model based on task complexity, conversation phase, and user-defined rules.

## Architectural Principles

- **Extension-First**: All functionality must be implemented as a `pi` extension without modifying `pi` core.
- **Custom Provider**: Use `pi.registerProvider` to hook into the model lifecycle. The logical model (e.g., `router/balanced`) should remain stable while the underlying model changes transparently.
- **Modularized Design**: Strictly follow the modular structure defined in Phase 3:
  - `extensions/types.ts`: All interfaces and type definitions.
  - `extensions/config.ts`: Configuration loading, normalization, and merging.
  - `extensions/routing.ts`: Core routing logic (classifier, gating).
  - `extensions/failover.ts`: Rate-limit detection and per-model-slug cooldowns.
  - `extensions/provider.ts`: Custom `router` provider registration and delegation stream.
  - `extensions/compaction.ts`: Deferred Pi session compaction at the settled-session boundary.
  - `extensions/state.ts`: Session-persisted state management and snapshotting.
  - `extensions/ui.ts`: UI status line and widget rendering logic.
  - `extensions/commands.ts`: CLI command registrations and completions.
  - `extensions/index.ts`: Main entry point (orchestrator).

## Routing Decision Logic

Routing follows a tiered system (`high`, `medium`, `low`) and an ordered decision flow:

### Phase 1: Intent Analysis

1. **Manual Pin**: Use tier pinned via `/router pin` if set.
2. **Google Thinking Lock**: Preserve the exact model/tier when a Google tool-result continuation is detected.
3. **LLM Classifier (Optional)**: Call `classifierModel` for intent categorization. Has final say unless overridden by a pin.
4. **Default fallback**: If no classifier configured or no result yet, defaults to `medium`.

### Phase 2: Requirement Matching (in `provider.ts`)

The router searches tiers from the intent-suggested tier upwards using a two-pass strategy:

1. **Pass 1 (Strict)**: Find a model that supports images (if present) and fits the current context within `defaultContextThresholdPercent` (or overrides).
2. **Pass 2 (Last Resort)**: If Pass 1 fails, find a model that supports images but allow context truncation.

### Phase 3: Execution & Fallbacks

1. **Authentication**: Retrieve API keys for the selected model.
2. **Delegation**: Stream the request to the target model with appropriate thinking levels.
3. **Fallbacks**: If a model fails, the search continues to the next available model in the requirements-compliant list.

## Coding Standards

- **TypeScript**: Strictly adhere to TypeScript. NEVER use the `any` type; prefer specific types or `unknown`.
- **Functions**: Always use arrow functions (`const myFunc = () => ...`) instead of function statements (`function myFunc() ...`) for consistency and lexical scoping.
- **Imports**: Use top-level static imports over inline `import()` or `require()` calls for consistency and cleaner ESM code.
- **State Management**: Persist router state via `pi.appendEntry` with a custom `router-state` entry type to ensure branch-safe behavior.
- **Error Handling**: Implement robust fallback chains for model failures (retrying with alternative models).

## Documentation Reference

- `docs/ARCHITECTURE.md`: Detailed architectural deep dive.
- `README.md`: Usage and installation guide.
- `model-router.example.json`: Reference for configuration structure.
