# pi-model-router

[![npm version](https://img.shields.io/npm/v/@yeliu84/pi-model-router)](https://www.npmjs.com/package/@yeliu84/pi-model-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Intelligent per-turn model router extension** for the [pi-coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Automatically selects between high, medium, and low-tier LLMs on every turn based on task intent, context size, and custom rules -- with automatic fallbacks, image-aware rerouting, context truncation, and phase awareness.

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

The pi-model-router registers itself as a **custom logical provider** called `router` via `pi.registerProvider`. It exposes each of your profiles as a stable model (e.g., `router/balanced`, `router/cheap`, `router/deep`). **The model shown in your pi footer stays fixed**, while the underlying LLM changes transparently on every turn based on what you're asking.

```
  pi footer shows: router/balanced

  Turn 1: "Plan the architecture"
    -> router routes to openai/gpt-5.4-pro (high)

  Turn 2: "Fix the typo in line 42"
    -> router routes to openai/gpt-5.4-nano (low)

  Turn 3: "Implement the API handlers"
    -> router routes to google/gemini-flash (med)
```

---

## Installation

### As a user

```bash
pi install npm:@yeliu84/pi-model-router
```

### For development

```bash
git clone https://github.com/yeliu84/pi-model-router.git
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
     "defaultProfile": "balanced",
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

   - **Persistent activation** (all sessions): Add `router/balanced` (and/or `router/cheap`) to your [scoped models list](#activating-the-router) in pi's configuration. On restart, the router will load automatically with the `defaultProfile`.

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

> **Fallback profile shows in autocomplete:** Because the merge starts with the fallback config, its `"auto"` profile will appear in tab-completion (e.g. `/router profile [TAB]` shows `router/auto`) even though its models are generic placeholders. This is harmless -- just switch to your real profile with `/router profile <name>`. If it bothers you, explicitly add a profile named `"auto"` in your config to override it.

**Fallback defaults** (used when no config file exists):

```json
{
  "defaultProfile": "auto",
  "debug": false,
  "profiles": {
    "auto": {
      "high":   { "model": "openai/gpt-5.4-pro",        "thinking": "off" },
      "medium": { "model": "google/gemini-flash-latest", "thinking": "off" },
      "low":    { "model": "openai/gpt-5.4-nano",        "thinking": "off" }
    }
  }
}
```

There are two unrelated uses of `"auto"` in this project: (1) as a **profile name** (name your profiles descriptively, like `"balanced"`), and (2) as a **pin reset value** in `/router pin auto` (meaning "clear the manual pin"). They are completely separate concepts.

### Configuration Fields

| Field | Type | Default      | Description                                                                                                                                                                                                                                                                       |
|---|---|--------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `debug` | `boolean` | `false`      | Enable debug mode. Equivalent to running `/router debug on` at startup.                                                                                                                                                                                                           |
| `defaultProfile` | `string` | `"auto"`     | The profile to activate by default when the router starts. Must match a key in `profiles`. See [Activating the Router](#activating-the-router) for how to make the router active on session start.                                                                                |
| `classifierModel` | `string` | --           | A fast model ref (e.g. `google/gemini-flash-latest`) used to classify user intent via LLM. When set, the classifier has final say on tier selection (gated by triggers below). Omit to use fast local heuristics only. |
| `classifierModelThinking` | `ThinkingLevel` | `off` | Reasoning/thinking level for the classifier model calls. Defaults to `off` (no extended reasoning) to keep calls fast and cheap. |
| `classifierRunOnceAfterToolCount` | `number` | `3` | Run the classifier once after this many tool continuations. Default: 3. Set to 0 to disable. |
| `classifierRunAfterToolFailures` | `number` | `2` | Run the classifier after this many consecutive tool failures (counting from the tail). Default: 2. |
| `classifierInterval` | `number` | `10` | Run the classifier every N tool continuations as a periodic re-check. Default: 10. Set to 0 to disable. |
| `tierStickiness` | `number` (0.0-1.0) | `0.5`        | Stickiness of the current routing phase. Higher values keep the router in the same tier longer during multi-turn conversations.                                                                                                                                                   |
| `defaultContextThresholdPercent` | `number` | `90`         | Default percentage threshold of a model's context window. If session context usage exceeds this percentage, the router searches for a suitable model in the current or higher tiers. |
| `contextThresholdPercentOverrides` | `Record<string, number>` | --           | **Optional.** Map of model-specific threshold overrides (model slug -> percentage). |
| `rules` | `array` | --           | **Optional.** List of keyword-based routing rules (see [Custom Rules](#custom-rules)).                                                                                                                                                                                            |
| `profiles` | `object` | _(required)_ | Map of profile definitions.                                                                                                                                                                                                                                                       |

### Profile Definitions

Each profile defines three **tiers** (`high`, `medium`, `low`). Each tier config:

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | `string` | _(required)_ | Canonical model ref in `"provider/model"` format (e.g. `"openai/gpt-5.4-pro"`). |
| `thinking` | `ThinkingLevel` | -- | **Optional.** Reasoning/thinking level for this tier. Override per-turn via `/router thinking`. |
| `fallbacks` | `string[]` | -- | **Optional.** Ordered list of fallback model refs. If the primary model fails, the router retries each fallback in sequence before surfacing an error. |

**Valid thinking levels** (from least to most reasoning): `off`, `minimal`, `low`, `medium`, `high`, `xhigh`

### Custom Rules

Rules let you pin a tier based on keywords in the user's prompt. They are checked **before** heuristics and the LLM classifier.

```json
{
  "rules": [
    { "matches": ["deploy", "production", "release"], "tier": "high", "reason": "Safety check for production tasks" },
    { "matches": "changelog", "tier": "low" }
  ]
}
```

> **No default rules.** The router ships with zero built-in rules. You must add rules explicitly if you want keyword-based overrides.

| Field | Type | Description |
|---|---|---|
| `matches` | `string \| string[]` | Keyword(s) to match against the user's prompt. If any match, the rule activates. |
| `tier` | `"high" \| "medium" \| "low"` | The tier to route to when this rule matches. |
| `reason` | `string` | **Optional.** Description shown in routing logs explaining why the rule fired. |

### Config Validation

The config system performs thorough validation on reload/startup and surfaces warnings via the notification system:

- Validates all model refs are in `provider/model` format
- Validates thinking levels against allowed values
- Validates routing rule format
- Reports missing/invalid profiles with fallback resolution
- Normalizes `tierStickiness` to range 0.0-1.0, and `defaultContextThresholdPercent` to positive values only

---

## Activating the Router

When you define profiles in your config, each profile is registered as a model with the `router` provider — e.g., `router/balanced`, `router/cheap`. These models appear in pi's model list and are available for selection in pi's model switcher, just like any other model.

### 1. Persistent activation (on session start)

To have the router activate automatically every time pi starts:

1. Add the router model(s) to pi's **scoped models list** in your pi configuration (e.g., add `"router/balanced"`).
2. Set `"defaultProfile": "balanced"` in `model-router.json` so the router knows which profile to use.

### 2. Runtime activation (current session only)

Once the extension is loaded, run `/router profile <name>` to switch to a router profile. This activates and remembers the router profile for the current session.

--- 

## Commands

All commands are accessible via `/router` in the pi chat interface. **Tab-completion is fully supported** for all subcommands and arguments.

### `/router status`

Show the current router status: enabled/disabled state, active profile and its pin, thinking overrides, widget on/off, tier stickiness, last routing decision, debug mode, and history count.

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

### `/router pin [profile] <tier|auto>`

Force a specific tier for a profile, overriding all automatic routing decisions. **Pins are persisted in session state (branch-safe) but do NOT modify your config file.**

```bash
/router pin high           # Pin current profile to 'high' tier
/router pin auto           # Clear pin on current profile
/router pin cheap low      # Pin the 'cheap' profile to 'low' tier
/router pin                # Show current pin status
```

Valid pin values: `high`, `medium`, `low`, `auto`.

> **Note:** `auto` is **not** a tier. For `/router pin`, `auto` means "clear the manual pin and return this profile to automatic routing." With one arg (`/router pin auto`) it always operates on the **current** profile. With two args, the first is always a **profile name** -- so `/router pin auto auto` would clear the pin on a profile named `"auto"`.

### `/router thinking [profile] [tier] <level|auto>`

Override the thinking/reasoning level for a specific tier or profile. Overrides the `thinking` value in the config.

```bash
/router thinking xhigh              # Set thinking for current tier
/router thinking high low           # Set 'high' tier thinking to 'low'
/router thinking balanced low off   # Set 'balanced' profile's 'low' tier to 'off'
/router thinking balanced all high  # Set all tiers in 'balanced' profile to 'high'
/router thinking                    # Show current thinking overrides
```

Valid thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `auto`.

Special tier value `all` applies the override to all three real tiers at once.

### `/router fix <tier>`

Correct the **last routing decision** and pin that tier for the profile that was used in that decision. If you've since switched profiles, the pin applies to the profile from the last decision, not the currently selected one.

```bash
/router fix high
/router fix low
```

### `/router debug <on|off|show|clear>`

Control turn-by-turn routing debug notifications and history. Debug history stores the last 12 routing decisions.

```bash
/router debug on       # Enable
/router debug off      # Disable
/router debug show     # Show the last 12 routing decisions
/router debug clear    # Clear history
/router debug          # Toggle
```

### `/router widget <on|off|toggle>`

Toggle the persistent status **widget** in the pi TUI sidebar/status area.

```bash
/router widget on
/router widget off
/router widget         # Toggle
```

### `/router disable`

Disable the router and restore the **last used non-router model**.

### `/router reload`

**Hot-reload** the configuration from disk without restarting pi. Preserves debug state.

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

PIPELINE (always runs)
  ├─ makeHeuristicAnalysis() — heuristic analysis (keyword/word-count/wc/tier-stickiness)
  ├─ Manual pin check → use pinned tier if set
  ├─ Custom rules → use configured tier if matched
  ├─ Heuristic tier → advisory HeuristicAnalysis
  └─ heuristicAnalysis is now ready

GATE 1: CLASSIFIER GATING (only when classifierModel is configured)
  - No pin, no context trigger, no Google continuation → evaluate gates
  - New user message? → run classifier (gates bypassed)
  - Tool-result continuation?
     ├─ contCount >= confInitN (first crossing)? → run once
     ├─ Consecutive failures >= confFailN? → run (crisis)
     ├─ contCount crosses new interval bucket? → run (periodic)
     └─ Otherwise → reuse previous decision (classifier or heuristic)
  - Classifier result final — heuristicAnalysis is
    advisory input for the LLM classifier prompt

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
```

### Heuristic Details

Without an LLM classifier, the router uses these signals locally:

| Signal | Routes to |
|---|---|
| Word count > 40-120 (biased) | `high` |
| Word count <= 4-12 (biased) | `low` |
| Planning keywords (`plan`, `architecture`, `analyze`, `tradeoff`, `research`, `design`, `strategy`, `compare`, `approach`, `migration`) | `high` |
| Summary keywords (`summarize`, `changelog`, `rewrite`, `reformat`, `recap`, `tl;dr`, `explain briefly`) | `low` |
| Implementation keywords (`implement`, `code`, `fix`, `edit`, `write`, `refactor`, `patch`, `apply`, `continue`, `add tests`) | `medium` |
| Explicit high hints (`best`, `deep`, `carefully`, `thoroughly`, `robust`, `comprehensive`, `step by step`, `think hard`, `highest quality`) | `high` |
| Explicit low hints (`fast`, `cheap`, `quick`, `brief`, `one sentence`, `tiny`, `small`) | `low` |
| Lookup keywords (`where is`, `show me`, `list`, `find`, `grep`) + short prompt + no tools this turn | `low` |
| Multi-line prompts (>=4 lines) | `high` |
| `why` prefix question | `high` |

### Classifier Gating

When the router has an LLM classifier configured (`classifierModel`), it doesn't run on every turn. Instead, the classifier is gated by smart triggers that avoid waste while catching real tier mismatches. **The classifier has final say on tier** (post-route corrections like image escalation) — heuristic analysis serves as advisory input to the LLM classifier prompt.

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

**Tier Stickiness** (`tierStickiness`, 0.0-1.0, default `0.5`):
- If the previous decision was `high` tier, the word-count high-threshold is lowered (`max(40, 120 - tierStickiness x 80)`), making it easier to stay in high.
- If the previous decision was `high` or `medium` tier, the low-threshold is lowered (`max(4, 12 - tierStickiness x 8)`), requiring even fewer words to trigger a low-tier decision.
- Stickiness only biases thresholds toward the current tier — it never overrides a clear signal.

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

### Image-Aware Auto-Routing

When the user attaches an image, the router checks whether the routed model supports image inputs. If not, it searches for another model in the same tier that does. If none are found, it escalates to higher tiers until a suitable model is found.

> **Note:** The search ensures that the selected model also fits the current context window requirements. To avoid landing on a model that can see images but not the full conversation, make sure your models have adequate context windows and image support configured.

### Google Thinking Tool Continuation

When using Google models with thinking enabled, tool-result continuations require the **same model** to avoid thought-signature replay errors. The router detects this pattern and preserves the exact model/tier for the continuation turn.

### Auto-Context Truncation

The router reports the **largest context window across all models in a profile** (using the `high` tier model's capacity). When routing to a model with a smaller window, the router trims oldest messages (preserving the system prompt and the most recent message) to fit within the target model's limit.

> **Limitation:** This assumes the `high` tier model always has the largest context window in the profile. If a lower tier has a larger window, the router won't use it -- it truncates to the `high` tier's capacity instead.

Estimated using a conservative heuristic: **4 characters = 1 token**.

This is a rough last-resort cut, not a replacement for pi's built-in session compaction (`/compact`).

### Thinking Control

Full control over reasoning/thinking levels per tier and per profile, both statically (in config) and dynamically:

- **Config level**: Set `thinking` per tier in each profile (e.g. `"thinking": "xhigh"`)
- **Runtime override**: `/router thinking balanced high xhigh` overrides the `balanced` profile's `high` tier thinking to `xhigh`
- **Reset to default**: `/router thinking balanced high auto` resets to the config value
- **Tier shorthands**: `/router thinking xhigh` applies to the current tier's decision

Levels: `off | minimal | low | medium | high | xhigh`

### Session & Debugging

**Persistent State:** Router state persists across agent restarts AND conversation branches via `pi.appendEntry` with a custom `router-state` entry type. Pins, thinking overrides, debug mode, widget visibility, debug history, the last routing decision, and the last non-router model are all preserved. State is **branch-safe** -- different conversation branches maintain independent state using `sessionManager.getBranch()`.

**Status Widget:** `/router widget on` shows a live widget in the pi TUI sidebar:
```
Router: enabled
Profile: balanced (active)
Pin: auto
Route: medium -> google/gemini-flash-latest
```

**Debug History:** With `/router debug on`, every routing decision is logged with timestamps. View with `/router debug show`:
```
[10:32:15 AM] balanced: high -> openai/gpt-5.4-pro (Detected planning from keywords.)
[10:33:42 AM] balanced: medium -> google/gemini-flash-latest (Detected implementation work.)
[10:34:10 AM] balanced: low -> openai/gpt-5.4-nano (Detected a short read-only lookup request.)
```

---

## Example Configurations

### Balanced (`balanced`)

```json
{
  "defaultProfile": "balanced",
  "classifierModel": "google/gemini-flash-latest",
  "tierStickiness": 0.5,
  "defaultContextThresholdPercent": 70,
  "rules": [
    { "matches": ["deploy", "production", "release"], "tier": "high", "reason": "Safety check for production tasks" },
    { "matches": "changelog", "tier": "low" }
  ],
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
  "defaultProfile": "cheap",
  "tierStickiness": 0.3,
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
  "defaultProfile": "deep",
  "tierStickiness": 0.8,
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
  "defaultProfile": "anthropic",
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

---

## License

MIT (c) Ye Liu
