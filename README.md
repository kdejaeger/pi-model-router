# pi-model-router

[![npm version](https://img.shields.io/npm/v/@kdejaeger/pi-model-router)](https://www.npmjs.com/package/@kdejaeger/pi-model-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Intelligent per-turn model router extension** (forked from [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router)) for the [pi-coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Automatically selects between high, medium, and low-tier LLMs on every turn based on task intent and context size — with automatic fallbacks, image-aware rerouting, context truncation, and classifier-based tier selection.

> Think of it as an automatic transmission for your LLM -- it shifts gears up or down depending on what you're doing, so you never waste compute on a trivial task or run out of reasoning power on a complex one.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [How Routing Works](#how-routing-works)
- [Example Configurations](#example-configurations)
- [Architecture](#architecture)
- [License](#license)

---

## How It Works

The pi-model-router registers itself as a **custom logical provider** (`router`) via `pi.registerProvider`. Each profile becomes a stable model (e.g., `router/balanced`). **The model shown in your footer stays fixed** while the underlying LLM changes per turn based on task complexity:

```
  footer shows: router/balanced

  Turn 1: "Plan the architecture for the new API" → openai/gpt-5.4-pro       (high)
  Turn 2: "Yes, go ahead"                  → openai/gpt-5.4-pro       (high)
  Turn 3: "Implement the API handlers"     → google/gemini-flash      (med)
```

---

## Installation

### As a user

```bash
pi install npm:@kdejaeger/pi-model-router
```

### For development

```bash
git clone https://github.com/kdejaeger/pi-model-router.git
cd pi-model-router
pi install .
```

Or load directly for a single run:

```bash
pi -e ./extensions/index.ts
```

---

## Quick Start

1. **Install** the package (see above).

2. **Create a config file** at `.pi/model-router.json` in your project:

   ```json
   {
     "profiles": {
       "balanced": {
         "high":    { "model": "openai/gpt-5.4-pro",          "thinking": "high" },
         "medium":  { "model": "google/gemini-flash-latest",  "thinking": "medium" },
         "low":     { "model": "openai/gpt-5.4-nano",         "thinking": "low" }
       },
       "cheap": {
         "high":    { "model": "google/gemini-flash-latest",     "thinking": "low" },
         "medium":  { "model": "openai/gpt-5.4-nano",          "thinking": "off" },
         "low":     { "model": "google/gemini-flash-lite-latest", "thinking": "off" }
       }
     }
   }
   ```

3. **Activate the router** -- choose one approach:

   - **Runtime switch** (per session): Restart pi (or run `/router reload`), then run:
     ```
     /router profile balanced
     ```

   - **Persistent activation** (all sessions): Add `router/balanced` (and/or `router/cheap`) to your [scoped models list](#activating-the-router) in pi's configuration. On restart, the router will load automatically with the profile you last used.

4. **Check the status:**

   ```
   /router
   ```

---

## Configuration

### Config Locations

Config is loaded from two locations and **merged**:

| Location | Scope | Path |
|---|---|---|
| Global | User-wide | `~/.pi/agent/model-router.json` |
| Project | Per-project | `.pi/model-router.json` |

### Config Merging Order

Configs are merged: **Fallback defaults <- Global config <- Project config**.

Project config values override global values, which override built-in defaults. Profiles are merged **deeply** -- if you define only a `high` tier override for a profile in your project config, the `medium` and `low` tiers are inherited from the global config (or fallback defaults).

**When no config file exists**, the router loads with an empty profile list and no active models. Create a `.pi/model-router.json` with at least one profile to use the router.



### Configuration Fields

| Field | Type | Default      | Description                                                                                                                                                                                                                                                                                                                                                                                         |
|---|---|--------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `debug` | `boolean` | `false`      | Enable debug mode. Equivalent to running `/router debug on` at startup.                                                                                                                                                                                                                                                                                                                             |
| `classifierModels` | `string[]` | --           | Array of fast model refs (e.g. `["google/gemini-flash-latest"]`) used to classify user intent via LLM. Models are tried in order, providing fallback if one hits an error. When set, the classifier has final say on tier selection (gated by triggers below). Omit to use fast local heuristics only.                                                                                              |
| `classifierModelThinking` | `ThinkingLevel` | `off` | Reasoning/thinking level for the classifier model calls. Defaults to `off` (no extended reasoning) to keep calls fast and cheap.                                                                                                                                                                                                                                                                    |
| `classifierRunOnceAfterToolCount` | `number` | `3` | Run the classifier once after this many tool continuations (only after the first user message of a turn). Default: 3. Set to 0 to disable.                                                                                                                                                                                                                                                                                                        |
| `classifierRunAfterToolFailures` | `number` | `2` | Run the classifier after this many consecutive tool failures (counting from the tail of the current turn). Default: 2.                                                                                                                                                                                                                                                                                                  |
| `classifierInterval` | `number` | `10` | Run the classifier every N tool continuations as a periodic re-check (crossed interval buckets). Default: 10. Set to 0 to disable.                                                                                                                                                                                                                                                                                             |
| `defaultContextThresholdPercent` | `number` | `90`         | Default percentage threshold of a model's context window. If session context usage exceeds this percentage, the router searches for a suitable model in the current or higher tiers.                                                                                                                                                                                                                |
| `contextThresholdPercentOverrides` | `Record<string, number>` | -- | **Optional.** Per-model context threshold overrides. Keys are canonical model refs in `"provider/model"` format. Values are the percentage of that model's context window that triggers an upgrade search. These take precedence over `defaultContextThresholdPercent`. Unknown keys produce a warning on provider registration. See [Context Threshold Overrides](#context-threshold-overrides). |
| `profiles` | `object` | _(required)_ | Map of profile definitions.                                                                                                                                                                                                                                                                                                                                                                         |

### Profile Definitions

Each profile defines three **tiers** (`high`, `medium`, `low`). Each tier config:

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | _(required)_ | Canonical model ref in `"provider/model"` format (e.g. `"openai/gpt-5.4-pro"`). |
| `thinking` | `ThinkingLevel` | -- | **Optional.** Reasoning/thinking level for this tier. |
| `fallbacks` | `string[]` | -- | **Optional.** Ordered list of fallback model refs. If the primary model fails, the router retries each fallback in sequence before surfacing an error. |

**Valid thinking levels** (from least to most reasoning): `off`, `minimal`, `low`, `medium`, `high`, `xhigh`

### Context Threshold Overrides

Use `contextThresholdPercentOverrides` to tune the context threshold for specific models. Keys must be canonical model refs in `"provider/model"` format. Values are percentages; lower values cause the router to consider upgrading sooner.

```json
{
  "contextThresholdPercentOverrides": {
    "openrouter/deepseek/deepseek-v4-flash": 60,
    "openrouter/deepseek/deepseek-v4-pro": 50,
    "openai-codex/gpt-5.5": 60,
    "openrouter/google/gemini-3.1-pro-preview": 18
  }
}
```



### Config Validation

The config system performs thorough validation on reload/startup and surfaces warnings via the notification system:

- Validates all profile model refs are in `provider/model` format
- Validates thinking levels against allowed values
- Reports missing/invalid profiles with fallback resolution
- Normalizes `defaultContextThresholdPercent` to positive values only
- Validates `contextThresholdPercentOverrides` keys against known models; unknown keys produce a warning on provider registration

---

## Activating the Router

When you define profiles in your config, each profile is registered as a model with the `router` provider — e.g., `router/balanced`, `router/cheap`. These models appear in pi's model list and are available for selection in pi's model switcher, just like any other model.

### 1. Persistent activation (on session start)

To have the router activate automatically every time pi starts:

1. Add the router model(s) to pi's **scoped models list** in your pi configuration (e.g., add `"router/balanced"`).
2. When pi starts with a router model in scope, the router activates using the profile name embedded in the model ID (e.g., `router/balanced` activates the `balanced` profile).

### 2. Runtime activation (current session only)

Once the extension is loaded, run `/router profile <name>` to switch to a router profile. This activates and remembers the router profile for the current session.

## Commands

All commands are accessible via `/router` in the pi chat interface. **Tab-completion is fully supported** for all subcommands and arguments.

### `/router status`

Show the current router status: enabled/disabled state, active profile and its pin, tier stickiness, last routing decision, debug mode, and history count.

```
/router
/router status
```

### `/router profile [name]`

Switch to a different router profile. This automatically enables the router if it was disabled.

```
/router profile balanced    # Switch to the 'balanced' profile
/router profile             # List available profiles
```

If you call `/router` with a profile name directly (e.g. `/router balanced`), it also works as a shortcut.

### `/router pin [profile] <tier|clear>`

Force a specific tier for a profile, overriding all automatic routing decisions. **Pins are persisted in session state (branch-safe) but do NOT modify your config file.**

```bash
/router pin high           # Pin current profile to 'high' tier
/router pin clear          # Clear pin on current profile
/router pin cheap low      # Pin the 'cheap' profile to 'low' tier
/router pin                # Show current pin status
```

Valid pin values: `high`, `medium`, `low`, `clear`.

> **Note:** `clear` removes the pin and returns the profile to automatic routing.



### `/router debug <on|off|show|clear>`

Control turn-by-turn routing debug notifications and history. Debug history stores the last 12 routing decisions.

```bash
/router debug on       # Enable
/router debug off      # Disable
/router debug show     # Show the last 12 routing decisions
/router debug clear    # Clear history
/router debug          # Toggle
```

### `/router disable`

Disable the router and restore the **last used non-router model**.

### `/router reload`

**Hot-reload** the configuration from disk without restarting pi. Preserves debug state.

If the active profile was removed from the config, the router becomes inactive until you switch to an available profile via `/router profile <name>`.

### `/router help`

Show a comprehensive help listing of all subcommands.

```bash
/router help
/router ?
```

---

## How Routing Works

For every turn, the router executes this ordered pipeline:

```
GATE 0: GOOGLE LOCK
  - Google thinking tool continuation? → preserve exact model/tier
     (skips EVERYTHING below)

GATE 1: CLASSIFIER GATING (only when classifierModels is configured)
  - Manual pin set → use pinned tier, classifier is skipped entirely
  - No classifier result yet → default to `medium`
  - New user message → run classifier
  - Tool-result continuation?
     ├─ contCount >= classifierRunOnceAfterToolCount (first crossing)? → run once
     ├─ Consecutive failures >= classifierRunAfterToolFailures? → run (crisis)
     ├─ contCount % classifierInterval === 0? → run (periodic)
     └─ Otherwise → reuse previous decision

POST-ROUTE CORRECTIONS (always apply)
  - Image-aware escalation: upgrade tier if routed model
     doesn't support image attachments
  - Context threshold enforcement: if context usage exceeds
     threshold, re-search for a suitable model in current or
     higher tiers (strict pass first, truncation pass as fallback)

EXECUTION
  - Auto-context truncation: trim oldest messages if target
     model's window is smaller than the profile's maximum window
  - Fallback chain: retry fallback models if primary fails
  - Post-turn re-assert: re-select the router model after each turn if it was changed
```



### Classifier Gating

When the router has an LLM classifier configured (`classifierModels`), it doesn't run on every turn. Instead, the classifier is gated by smart triggers that avoid waste while catching real tier mismatches. **The classifier has final say on tier** (post-route corrections like image escalation).

| Gate | Trigger                                                                                     | Reason |
|---|---------------------------------------------------------------------------------------------|---|
| **Google lock** | Previous model was Google with thinking, and this is a tool-result continuation             | Freezes to the same model — any change breaks thought-signature replay |
| **Fresh feedback** | Tool-continuation count first reaches or exceeds `classifierRunOnceAfterToolCount` (default: 3) | Captures the assistant's first response + tool result after a new user message |
| **Crisis** | Consecutive failed tool results (from the tail) ≥ `classifierRunAfterToolFailures` (default: 2)   | Model is struggling — reclassify to potentially upgrade tier |
| **Interval** | Tool-continuation count % `classifierInterval` === 0 (default: 10)                           | Periodic re-check for long-running turns where initial assessment might be stale |

All counters reset per user turn — each new user message is treated as a fresh task. The crisis gate counts **consecutive** failures from the tail: one successful tool result resets the count to 0, so it only fires when failures are actually piling up.

When the classifier is skipped, the **previous routing decision** is reused directly. Post-route corrections (image escalation) still apply regardless.

### Context Controls

**Context & Image Requirements** (`defaultContextThresholdPercent`): When the conversation context exceeds this percentage of a model's window, or when images are detected, the router searches for a suitable model in the current or higher tiers. This check happens on every turn, but since context usage usually only grows across turns (unless compaction reduces it), the router will often stay in higher tiers once pushed there.



### Fallback Chains

Each tier can define `fallbacks` -- an ordered list of alternative models. If the primary model fails, the router retries each fallback in sequence before surfacing an error.

```json
{
  "profiles": {
    "auto": {
      "high": {
        "model": "openai/gpt-5.4-pro",
        "fallbacks": ["anthropic/claude-3-5-sonnet-20241022", "google/gemini-2.5-pro-latest"]
      }
    }
  }
}
```

When a fallback is used, `decision.isFallback` is set to `true` and shown in the status. The tier's configured thinking level (or runtime override) applies to all fallback models -- if a fallback doesn't support the requested level, pi silently clamps it.

If a model fails during a turn, the router retries it up to **2 times** before moving to the next fallback in the chain.

### Image-Aware Auto-Routing

When the user attaches an image, the router checks whether the routed model supports image inputs. If not, it searches for another model in the same tier that does. If none are found, it escalates to higher tiers until a suitable model is found.

> **Note:** The search ensures that the selected model also fits the current context window requirements. To avoid landing on a model that can see images but not the full conversation, make sure your models have adequate context windows and image support configured.

### Google Thinking Tool Continuation

When using Google models with thinking enabled, tool-result continuations require the **same model** to avoid thought-signature replay errors. The router detects this pattern and preserves the exact model/tier for the continuation turn.

### Auto-Context Truncation

The router reports the **largest context window across all models in a profile** (scanning all tiers and their fallbacks for the maximum). When routing to a model with a smaller window, the router trims oldest messages (preserving the system prompt and the most recent message) to fit within the target model's limit.

Estimated using a conservative heuristic: **4 characters = 1 token**.

This is a rough last-resort cut, not a replacement for pi's built-in session compaction (`/compact`).

### Session & Debugging

**Persistent State:** Router state persists across agent restarts AND conversation branches via `pi.appendEntry` with a custom `router-state` entry type. Pins, debug mode, debug history, the last routing decision, and the last non-router model are all preserved. State is **branch-safe** -- different conversation branches maintain independent state using `sessionManager.getBranch()`.

**Status Line:** The router shows its status in the pi TUI status bar:
```
Router: enabled
Profile: balanced (active)
Pin: none
Route: medium -> google/gemini-flash-latest
```

The `Route:` line may show decision flags in brackets when applicable:
- `[classifier]` — routed by the LLM classifier

- `[fallback]` — a fallback model was used
- `[context]` — context threshold triggered an upgrade

**Debug History:** With `/router debug on`, routing decisions and classifier gating decisions are logged with timestamps. View with `/router debug show` to see the routing history:

```
RUN classifier — init(≥3), interval(%10) (cont:5)
SKIP classifier (cont:2, fail:0)
```

The classifier gating notifications show why the classifier ran or was skipped (`cont` = tool-result continuations since the last user message, `fail` = consecutive recent tool failures).
```
[10:32:15 AM] high -> openai/gpt-5.4-pro (high) - Detected planning from keywords.
[10:33:42 AM] medium -> google/gemini-flash-latest (medium) - Detected implementation work.
[10:34:10 AM] low -> openai/gpt-5.4-nano (low) - Detected a short read-only lookup request.
```

---

## Example Configurations

### Balanced (`balanced`)

```json
{
  "classifierModels": ["google/gemini-flash-latest"],
  "defaultContextThresholdPercent": 70,
  "profiles": {
    "balanced": {
      "high":    { "model": "openai/gpt-5.4-pro", "thinking": "high", "fallbacks": ["anthropic/claude-3-5-sonnet-20241022"] },
      "medium":  { "model": "google/gemini-flash-latest", "thinking": "medium" },
      "low":     { "model": "openai/gpt-5.4-nano", "thinking": "low" }
    }
  }
}
```

### Budget-Conscious (`cheap`)

```json
{
  "profiles": {
    "cheap": {
      "high":   { "model": "google/gemini-flash-latest",     "thinking": "low" },
      "medium": { "model": "openai/gpt-5.4-nano",            "thinking": "off" },
      "low":    { "model": "google/gemini-flash-lite-latest", "thinking": "off" }
    }
  }
}
```

### Deep Reasoning (`deep`)

```json
{
  "profiles": {
    "deep": {
      "high":   { "model": "openai/o1-preview",          "thinking": "xhigh" },
      "medium": { "model": "openai/gpt-5.4-pro",         "thinking": "medium" },
      "low":    { "model": "google/gemini-flash-latest", "thinking": "low" }
    }
  }
}
```

### Anthropic-Only (`anthropic`)

```json
{
  "profiles": {
    "anthropic": {
      "high":   { "model": "anthropic/claude-3-5-sonnet-20241022", "thinking": "high" },
      "medium": { "model": "anthropic/claude-3-5-sonnet-20241022", "thinking": "medium" },
      "low":    { "model": "anthropic/claude-3-haiku-20240307",    "thinking": "low" }
    }
  }
}
```

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a detailed architectural deep dive, including the decision flow, module responsibilities, state persistence, and fallback chain design.
